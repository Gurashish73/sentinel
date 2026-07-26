import { describe, it, expect, vi, beforeEach } from "vitest";
import { proposeRemediation } from "@/agents/remediation";

const { mockCreate, mockEmitAgentEvent, mockIncidentUpdate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockEmitAgentEvent: vi.fn(),
  mockIncidentUpdate: vi.fn(),
}));

// ES6 class mock ensures `new OpenAI()` instantiation behaves identically to the real SDK
vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  }
  return {
    default: MockOpenAI,
    OpenAI: MockOpenAI,
  };
});

vi.mock("@/lib/emit-agent-event", () => ({
  emitAgentEvent: mockEmitAgentEvent,
}));

vi.mock("@/lib/db", () => ({
  db: { incident: { update: mockIncidentUpdate } },
}));

const incident = { id: "inc_1", title: "DB connection pool exhausted" };
const diagnosis = { summary: "Connection pool saturated at 100/100." };

function mockLlmResponse(content: string) {
  mockCreate.mockResolvedValue({
    choices: [{ message: { content } }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proposeRemediation", () => {
  it("emits action_proposed and updates incident status on valid proposal", async () => {
    mockLlmResponse('{"action": "Restart the connection pool service", "riskLevel": "medium"}');

    await proposeRemediation(incident, "org_1", diagnosis);

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org_1",
      "inc_1",
      expect.objectContaining({
        type: "action_proposed",
        action: "Restart the connection pool service",
        riskLevel: "medium",
      }),
    );
    expect(mockIncidentUpdate).toHaveBeenCalledWith({
      where: { id: "inc_1" },
      data: { status: "AWAITING_APPROVAL" },
    });
  });

  it("handles conversational LLM filler gracefully and falls back without throwing on malformed JSON", async () => {
    mockLlmResponse("Sure! Here's my recommendation: restart the service.");

    await proposeRemediation(incident, "org_1", diagnosis);

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org_1",
      "inc_1",
      expect.objectContaining({ type: "thought" }),
    );
    expect(mockEmitAgentEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ type: "action_proposed" }),
    );
    expect(mockIncidentUpdate).not.toHaveBeenCalled();
  });

  it("rejects valid JSON payloads that fail strict Zod schema validation", async () => {
    // Valid JSON, invalid riskLevel enum value
    mockLlmResponse('{"action": "Restart the service", "riskLevel": "critical"}');

    await proposeRemediation(incident, "org_1", diagnosis);

    expect(mockIncidentUpdate).not.toHaveBeenCalled();
    expect(mockEmitAgentEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ type: "action_proposed" }),
    );
  });

  it("rejects proposals where action string length violates min bounds", async () => {
    mockLlmResponse('{"action": "ok", "riskLevel": "low"}');

    await proposeRemediation(incident, "org_1", diagnosis);

    expect(mockIncidentUpdate).not.toHaveBeenCalled();
  });

  it("never throws unhandled exceptions on empty responses to protect workflow execution", async () => {
    mockLlmResponse("");
    await expect(proposeRemediation(incident, "org_1", diagnosis)).resolves.not.toThrow();
  });
});