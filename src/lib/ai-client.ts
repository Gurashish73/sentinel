import "server-only";
import OpenAI from "openai";
import { env } from "@/lib/env";

export const agentClient = new OpenAI({
  apiKey: env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  maxRetries: 0,
});