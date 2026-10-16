-- Ensure fresh databases include the incident status introduced in Phase 6.
ALTER TYPE "IncidentStatus"
  ADD VALUE IF NOT EXISTS 'ESCALATION_REQUIRED';

-- Restore the HNSW index dropped by the historical vector finalization migration.
CREATE INDEX "runbook_chunk_embedding_idx"
  ON "RunbookChunk" USING hnsw (embedding vector_cosine_ops);