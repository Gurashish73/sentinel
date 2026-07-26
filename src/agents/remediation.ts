import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { db } from "@/lib/db";
import { emitAgentEvent } from "@/lib/emit-agent-event";
import { env } from "@/lib/env";
import type { Incident } from "@prisma/client";
import type { DiagnosisResult } from "@/agents/diagnosis";

const openai = new OpenAI({
  baseURL: "https://models.inference.ai.azure.com",
  apiKey: env.GITHUB_TOKEN,
  maxRetries: 0,
});

const proposalSchema = z.object({
  action: z.string().min(3).max(300),
  riskLevel: z.enum(["low", "medium", "high"]),
});

export async function proposeRemediation(
  incident: Pick<Incident, "id" | "title">,
  orgId: string,
  diagnosis: DiagnosisResult,
): Promise<void> {
  const response = await openai.chat.completions.create({
    model: env.AGENT_MODEL,
    max_completion_tokens: 1000, 
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `Incident: "${incident.title}". Diagnosis: ${diagnosis.summary}

Propose ONE remediation action. Respond with ONLY a JSON object containing keys "action" and "riskLevel":
{"action": "<short description of the action>", "riskLevel": "low" | "medium" | "high"}`,
      },
    ],
  });

  const text = response.choices[0]?.message?.content;
  const raw = text ? text : "{}";

  // Extract JSON block and parse safely before Zod validation
  const startIndex = raw.indexOf("{");
  const endIndex = raw.lastIndexOf("}");
  
  const cleanJson = (startIndex !== -1 && endIndex !== -1) 
    ? raw.slice(startIndex, endIndex + 1) 
    : "{}";

  let parsed: z.infer<typeof proposalSchema>;
  try {
    const rawObj = JSON.parse(cleanJson);
    
    if (rawObj.riskLevel) {
      rawObj.riskLevel = String(rawObj.riskLevel).toLowerCase();
    }
    
    parsed = proposalSchema.parse(rawObj);
  } catch (error) {
    console.error("[Remediation Agent] Failed to parse proposal:", { error, raw, cleanJson });
    
    await emitAgentEvent(orgId, incident.id, {
      type: "thought",
      text: "Remediation agent could not produce a valid proposal — leaving incident open for manual review.",
      ts: Date.now(),
    });
    return;
  }

  await emitAgentEvent(orgId, incident.id, {
    type: "action_proposed",
    action: parsed.action,
    riskLevel: parsed.riskLevel,
    ts: Date.now(),
  });

  await db.incident.update({
    where: { id: incident.id },
    data: { status: "AWAITING_APPROVAL" },
  });
}