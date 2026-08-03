import "server-only";
import { agentClient } from "@/lib/ai-client";
import { db } from "@/lib/db";
import { emitAgentEvent } from "@/lib/emit-agent-event";
import { fetchRecentLogs } from "@/agents/tools";
import { env } from "@/lib/env";
import type { Incident } from "@prisma/client";

export type DiagnosisResult = { summary: string };

export async function runDiagnosis(
  incident: Pick<Incident, "id" | "title" | "description">,
  orgId: string,
): Promise<DiagnosisResult> {
  await emitAgentEvent(orgId, incident.id, {
    type: "tool_call",
    tool: "fetchRecentLogs",
    args: { incidentTitle: incident.title },
    ts: Date.now(),
  });
  
  const logs = await fetchRecentLogs(incident.title);
  
  await emitAgentEvent(orgId, incident.id, {
    type: "tool_result",
    tool: "fetchRecentLogs",
    result: logs,
    ts: Date.now(),
  });

  // Plain text-in-context, no vector search — pgvector similarity search is
  // a Phase 5 concern (scaling retrieval across many runbooks), not a
  // prerequisite for retrieval existing at all. At the runbook volumes a
  // demo or small team actually has, passing everything directly works fine.
  const runbooks = await db.runbook.findMany({
    where: { orgId },
    select: { title: true, content: true },
    take: 10,
  });
  
  const runbookContext = runbooks.length
    ? runbooks.map((r) => `### ${r.title}\n${r.content}`).join("\n\n")
    : "No runbooks on file for this organization yet.";

  const response = await agentClient.chat.completions.create({
    model: env.AGENT_MODEL,
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `Incident: "${incident.title}". Description: ${incident.description ?? "none"}.

Recent logs:
${logs.join("\n")}

Relevant runbooks:
${runbookContext}

In 2-3 sentences, summarize the likely root cause and whether a runbook covers it.`,
      },
    ],
  });

  const text = response.choices[0]?.message?.content;
  const summary = text ? text.trim() : "Unable to produce a diagnosis.";

  await emitAgentEvent(orgId, incident.id, { type: "thought", text: summary, ts: Date.now() });

  return { summary };
}