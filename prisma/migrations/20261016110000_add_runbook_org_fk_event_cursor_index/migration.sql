-- Enforce that every runbook chunk belongs to an existing organization.
ALTER TABLE "RunbookChunk"
ADD CONSTRAINT "RunbookChunk_orgId_fkey"
FOREIGN KEY ("orgId")
REFERENCES "Organization"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- Optimize event retrieval by incident and chronological cursor.
CREATE INDEX "Event_incidentId_createdAt_idx"
ON "Event"("incidentId", "createdAt");