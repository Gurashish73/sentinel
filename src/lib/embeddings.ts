import "server-only";
import { agentClient } from "@/lib/ai-client";
import { env } from "@/lib/env";

const EMBEDDING_DIMENSIONS = 768;

export async function embedText(text: string): Promise<number[]> {
  const response = await agentClient.embeddings.create({
    model: env.AGENT_EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await agentClient.embeddings.create({
    model: env.AGENT_EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data.map((d) => d.embedding);
}