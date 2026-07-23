import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { verifyHmacSignature } from "@/lib/webhook-verify";
import { ingestAlert, alertSchema } from "@/lib/ingest-alert";

/**
 * POST /api/webhooks/alert/[orgSlug]
 * 
 * Public-facing ingestion endpoint for external tools (GitHub, Sentry, Sentinel Agents).
 * Protected via HMAC-SHA256 signature verification.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgSlug: string }> }
) {
  try {
    const { orgSlug } = await params;

    // OPTIMIZATION: Use `select` to minimize memory footprint. 
    // We only need the ID and the secret, nothing else from the Org table.
    const org = await db.organization.findUnique({
      where: { slug: orgSlug },
      select: { id: true, webhookSecret: true },
    });
    
    // SECURITY: Return an identical generic 404 whether the org doesn't exist 
    // OR has no secret configured. This prevents malicious slug enumeration.
    if (!org?.webhookSecret) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    let secret: string;
    try {
       // Decrypt the secret in-memory.
       secret = decryptSecret(org.webhookSecret);
    } catch (cryptoError) {
       console.error(`Failed to decrypt webhook secret for org ${org.id}:`, cryptoError);
       return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }

    // SECURITY: We MUST read the raw text for HMAC verification. 
    // Using req.json() strips formatting/whitespaces and breaks the cryptographic signature.
    const rawBody = await req.text();
    
    // Support Sentinel's standard header, with a fallback for GitHub's native integrations.
    const signature = req.headers.get("x-signature") || req.headers.get("x-hub-signature-256");

    if (!verifyHmacSignature(rawBody, signature, secret)) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    let json: unknown;
    try {
      // Now that the signature is verified, we can safely parse the body
      json = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Malformed JSON payload" }, { status: 400 });
    }

    const parsed = alertSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 
        { status: 422 }
      );
    }

    // Pass the validated payload to the idempotent ingestion pipeline
    const result = await ingestAlert(org.id, parsed.data);

    // Return 200 OK for both "created" and "duplicate" statuses.
    // Throwing a 409 Conflict on a duplicate would cause the external provider to endlessly retry.
    return Response.json(result, { status: 200 });

  } catch (error) {
    // Catch-all prevents Next.js from leaking stack traces to external callers
    console.error("[Webhook Error] Unhandled exception in ingestion route:", error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}