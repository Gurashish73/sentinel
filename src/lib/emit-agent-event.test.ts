import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { mockEventCreate, mockRevalidateTag } = vi.hoisted(() => ({
  mockEventCreate: vi.fn(),
  mockRevalidateTag: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { event: { create: mockEventCreate } },
}));

vi.mock("next/cache", () => ({ revalidateTag: mockRevalidateTag }));

import { dedupeExternalId, emitAgentEvent, workflowEventDedupeKey } from "@/lib/emit-agent-event";
import type { AgentEvent } from "@/lib/event";

const event: AgentEvent = { type: "thought", text: "triage complete", ts: 123 };

function uniqueExternalIdError(target: string[] | string) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.8.0",
    meta: { target },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEventCreate.mockResolvedValue({ id: "event-1" });
  mockRevalidateTag.mockReturnValue(undefined);
});

describe("workflow event deduplication", () => {
  it("creates namespaced, stable keys for the same workflow event", () => {
    const first = workflowEventDedupeKey("wfr-1", "diagnosis", "summary");
    const retry = workflowEventDedupeKey("wfr-1", "diagnosis", "summary");
    const nextRun = workflowEventDedupeKey("wfr-2", "diagnosis", "summary");

    expect(first).toBe(retry);
    expect(nextRun).not.toBe(first);
    expect(dedupeExternalId("inc-1", first)).not.toBe(dedupeExternalId("inc-2", first));
  });

  it("persists the dedupe key through Event.externalId", async () => {
    const key = workflowEventDedupeKey("wfr-1", "triage", "verdict");

    await expect(emitAgentEvent("org-1", "inc-1", event, { dedupeKey: key })).resolves.toBe(true);

    expect(mockEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org-1",
        incidentId: "inc-1",
        type: "thought",
        externalId: dedupeExternalId("inc-1", key),
      }),
    });
  });

  it("treats only the org/externalId unique collision as an idempotent no-op", async () => {
    mockEventCreate.mockRejectedValueOnce(uniqueExternalIdError(["orgId", "externalId"]));
    const key = workflowEventDedupeKey("wfr-1", "triage", "verdict");

    await expect(emitAgentEvent("org-1", "inc-1", event, { dedupeKey: key })).resolves.toBe(false);
    expect(mockRevalidateTag).toHaveBeenCalledWith("incidents-org-1", { expire: 0 });
  });

  it("does not swallow a different unique-constraint error", async () => {
    const error = uniqueExternalIdError(["id"]);
    mockEventCreate.mockRejectedValueOnce(error);

    await expect(
      emitAgentEvent("org-1", "inc-1", event, { dedupeKey: "wfr-1:triage:verdict" }),
    ).rejects.toBe(error);
  });

  it("preserves non-deduplicated event writes", async () => {
    await expect(emitAgentEvent("org-1", "inc-1", event)).resolves.toBe(true);
    expect(mockEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ externalId: undefined }),
    });
  });
});
