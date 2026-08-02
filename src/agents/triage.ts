import "server-only";
import { agentClient } from "@/lib/ai-client";
import { emitAgentEvent } from "@/lib/emit-agent-event";
import { env } from "@/lib/env";
import type { Incident } from "@prisma/client";

export async function runTriage(
  incident: Pick<Incident, "id" | "title" | "severity" | "description">,
  orgId: string,
): Promise<{ shouldInvestigate: boolean }> {
  const response = await agentClient.chat.completions.create({
    model: env.AGENT_MODEL,
    max_tokens: 1000,
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