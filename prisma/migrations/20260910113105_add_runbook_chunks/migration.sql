CREATE EXTENSION IF NOT EXISTS vector;
-- CreateTable
CREATE TABLE "RunbookChunk" (
    "id" TEXT NOT NULL,
    "runbookId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunbookChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunbookChunk_orgId_idx" ON "RunbookChunk"("orgId");

-- CreateIndex
CREATE INDEX "RunbookChunk_runbookId_idx" ON "RunbookChunk"("runbookId");

-- AddForeignKey
ALTER TABLE "RunbookChunk" ADD CONSTRAINT "RunbookChunk_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "Runbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create HNSW Index for fast approximate-nearest-neighbor search
CREATE INDEX "runbook_chunk_embedding_idx" ON "RunbookChunk" USING hnsw (embedding vector_cosine_ops);