import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

/** Public webhook defense, keyed by client IP. */
export const webhookIpLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "10 s"),
  prefix: "ratelimit:webhook:ip",
  analytics: true,
});

/** Per-organization webhook defense; only reached after HMAC verification. */
export const webhookOrgLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "60 s"),
  prefix: "ratelimit:webhook:org",
  analytics: true,
});

/** Defense-in-depth for authenticated Commander approval actions. */
export const approvalActionLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "60 s"),
  prefix: "ratelimit:approval:user",
  analytics: true,
});

/** Post-approval execution blast-radius control. */
export const orgExecutionLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 h"),
  prefix: "ratelimit:execution:org",
  analytics: true,
});

/** Best-effort client IP extraction behind a trusted reverse proxy. */
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();

  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}

/** Convert Upstash's millisecond reset timestamp into Retry-After seconds. */
export function retryAfterSeconds(reset: number): number {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1000));
}
