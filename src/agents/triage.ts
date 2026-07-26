import "server-only";
import OpenAI from "openai";
import { emitAgentEvent } from "@/lib/emit-agent-event";
import { env } from "@/lib/env";
import type { Incident } from "@prisma/client";

const openai = new OpenAI({
  baseURL: "https://models.inference.ai.azure.com",
  apiKey: env.GITHUB_TOKEN,
  maxRetries: 0, // Forces the SDK to fail fast so Upstash can handle the pause/retry
});

export async function runTriage(
  incident: Pick<Incident, "id" | "title" | "severity" | "description">,
  orgId: string,
): Promise<{ shouldInvestigate: boolean }> {
  const response = await openai.chat.completions.create({
    model: env.AGENT_MODEL,
    max_completion_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `Incident: "${incident.title}". Severity: ${incident.severity}. Description: ${incident.description ?? "none"}.
Respond with exactly one word: INVESTIGATE or SKIP. SKIP only if this looks like a duplicate or clearly not actionable.`,
      },
    ],
  });

  const text = response.choices[0]?.message?.content || "";
  const shouldInvestigate = text.trim().toUpperCase().includes("INVESTIGATE");

  await emitAgentEvent(orgId, incident.id, {
    type: "thought",
    text: shouldInvestigate
      ? "Triage: this looks actionable — proceeding to diagnosis."
      : "Triage: skipping — doesn't look actionable (possible duplicate).",
    ts: Date.now(),
  });

  return { shouldInvestigate };
}