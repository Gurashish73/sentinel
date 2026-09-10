# Phase 5: AI Intelligence (RAG)

## Overview

Phase 5 replaces Sentinel's initial naive runbook ingestion with a scalable Retrieval-Augmented Generation (RAG) pipeline.

Instead of concatenating every organizational runbook directly into the Diagnosis agent's prompt, Sentinel now semantically chunks, embeds, and retrieves only the runbook passages that are relevant to the current incident. This keeps the diagnosis context focused while maintaining strict multi-tenant data boundaries.

## Developer Notes & Architecture Decisions

* **Semantic Search via `pgvector`:** Replaced full-runbook prompt loading with vector-based retrieval using PostgreSQL's `pgvector` extension. Query and runbook chunk embeddings are compared using cosine distance.
  
* **HNSW Indexing:** Added an HNSW index using `vector_cosine_ops` for efficient nearest-neighbor retrieval as runbook libraries scale.

* **Chunking Strategy:** Implemented paragraph-aware chunking with an 800-character target size and 150-character overlap for fixed-window splitting. Long paragraphs fall back to overlapping windows so context is not silently lost at chunk boundaries.

* **Embedding Model Routing:** Separated the chat generation model (`gemini-3.1-flash-lite`) from the embedding model (`gemini-embedding-001`). Embeddings are generated at 768 dimensions through the existing OpenAI-compatible `agentClient`.

* **Tenant Isolation in Vector Space:** Vector retrieval is strictly scoped by `orgId` inside the SQL `WHERE` clause, ensuring retrieved chunks remain within the active organization.

* **Retrieved Content Remains Untrusted:** Phase 5 extends the Phase 4.5 prompt-safety model rather than introducing a new trust boundary. Retrieved chunks are independently fenced and scanned before reaching the Diagnosis prompt.

* **Citation Hallucination Tripwire:** Added a non-blocking post-generation check for cases where the Diagnosis agent names a known organizational runbook that was not part of the retrieved set. The tripwire emits `unretrieved_citation_suspected` for human review without altering the diagnosis.

## 1. Data Layer & Vector Storage

A dedicated `RunbookChunk` model was added because one runbook can produce multiple independently retrievable chunks.

Each chunk stores:

* `id`
* `runbookId`
* `orgId`
* `chunkIndex`
* `content`
* `embedding`
* `createdAt`

The embedding is stored as:

```prisma
Unsupported("vector(768)")
```

PostgreSQL `pgvector` is enabled through the migration, and an HNSW index is created for cosine similarity search:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE INDEX runbook_chunk_embedding_idx
ON "RunbookChunk"
USING hnsw (embedding vector_cosine_ops);
```

Because Prisma does not natively type the `Unsupported()` vector field, the embedding-specific database operations use raw SQL.

## 2. Chunking & Embedding Pipeline

The runbook creation flow now automatically prepares content for retrieval.

```text
Runbook content
      ↓
Paragraph-aware chunking
      ↓
800-character chunks
      ↓
150-character overlap for windowed splits
      ↓
gemini-embedding-001
      ↓
768-dimensional vectors
      ↓
PostgreSQL / pgvector
```

The chunking implementation lives in:

```text
src/lib/chunking.ts
```

The embedding implementation lives in:

```text
src/lib/embeddings.ts
```

Runbook creation performs chunking and embedding as part of the same application workflow, with the resulting chunk records stored in PostgreSQL.

The embedding request uses the existing OpenAI-compatible AI client rather than introducing a separate SDK.

## 3. Semantic Retrieval & Tenant Boundaries

Semantic retrieval is implemented in:

```text
src/lib/queries/runbook-retrieval.ts
```

The Diagnosis agent builds a search query from the incident title and description, generates its embedding, and retrieves the top relevant runbook chunks.

The retrieval query uses pgvector cosine distance:

```sql
ORDER BY c.embedding <=> ${vectorLiteral}::vector
```

and exposes a similarity score for each result.

The critical tenant boundary is enforced directly in SQL:

```sql
WHERE c."orgId" = ${orgId}
```

This prevents an incident belonging to one organization from retrieving runbook chunks belonging to another organization.

Retrieval is limited to the most relevant chunks rather than loading the complete runbook library into the prompt.

When no relevant content is returned, Diagnosis receives a controlled fallback:

```text
No relevant runbook content found for this incident.
```

## 4. Retrieved Runbook Prompt Safety

Phase 5 extends the structural prompt-isolation model introduced in Phase 4.5.

Retrieved runbook chunks are not trusted simply because they came from the organization's database. Each chunk is treated as untrusted content before it reaches the model.

The following helpers were added to `src/agents/prompt-safety.ts`:

```text
wrapRetrievedChunks()
scanRetrievedChunks()
```

Each retrieved chunk is fenced independently using the existing `wrapUntrusted()` mechanism, giving every chunk its own nonce boundary.

Each chunk is also scanned independently using the existing prompt-injection heuristic.

When a retrieved chunk triggers the scanner, Sentinel emits:

```text
injection_suspected
source: retrieved_chunk:<chunkId>
```

The check remains a tripwire rather than a gate. Suspicious content is surfaced for review without silently rewriting or discarding the retrieved material.

## 5. Diagnosis Agent Integration

The Diagnosis agent was refactored so retrieval replaces the previous approach of loading the organization's runbooks directly.

The updated flow is:

```text
Incident
   ↓
Fetch recent logs
   ↓
Build incident search query
   ↓
Retrieve relevant runbook chunks
   ↓
Scan retrieved chunks
   ↓
Fence retrieved content
   ↓
Generate diagnosis
   ↓
Check runbook citations
   ↓
Emit events
   ↓
Return diagnosis
```

The relevant implementation is:

```text
src/agents/diagnosis.ts
```

The model is instructed to name a runbook only when that runbook is present in the retrieved context.

The existing agent event system remains the source of runtime observability for tool calls, suspicious-content tripwires, and the final diagnosis.

## 6. Citation Hallucination Tripwire

A specific RAG failure mode is the model mentioning a runbook that exists in the organization's library but was never retrieved for the current incident.

To detect this, Phase 5 adds:

```text
listRunbookTitles(orgId)
```

in:

```text
src/lib/queries/runbook-retrieval.ts
```

and:

```text
findUncitedRunbookMentions(...)
```

in:

```text
src/agents/prompt-safety.ts
```

After the Diagnosis summary is generated, Sentinel compares:

1. The active organization's known runbook titles.
2. The runbook titles represented by the retrieved chunks.
3. Runbook titles mentioned in the generated summary.

When a known runbook is mentioned but none of its chunks were retrieved, Sentinel emits:

```text
unretrieved_citation_suspected
```

with the affected runbook title.

This is deliberately advisory:

* the diagnosis is not blocked;
* the diagnosis is not rewritten;
* the event is recorded for Commander/human review.

The implementation uses a lightweight title/substring heuristic, so it can miss paraphrased references and may produce false positives when a title is also an ordinary phrase. It is therefore treated as a tripwire, not a definitive citation validator.

## 7. Tests & Validation

Phase 5 extends the Vitest coverage across the RAG pipeline.

### Chunking Tests

Added:

```text
src/lib/chunking.test.ts
```

Coverage includes:

* short content;
* multiple paragraphs;
* multi-chunk splitting;
* long single paragraphs;
* overlap behavior;
* empty and whitespace-only input;
* extra blank lines between paragraphs.

### Prompt Safety Tests

Updated:

```text
src/agents/prompt-safety.test.ts
```

Coverage includes:

* retrieved-chunk injection detection;
* chunk-specific tripwire attribution;
* unretrieved runbook citation detection;
* no false tripwire for an actually retrieved runbook;
* summaries with no known runbook references.

### Diagnosis Integration Tests

Updated:

```text
src/agents/diagnosis.test.ts
```

Coverage includes:

* RAG retrieval integration;
* zero-result fallback;
* citation tripwire event emission;
* preservation of existing Diagnosis behavior.

The existing RAG-related tests were updated and pass successfully.

## Implementation Checklist

### 1. Data Layer & Vector Storage Checklist

* [x] Add `RunbookChunk` model to Prisma schema.
* [x] Add `vector(768)` embedding field.
* [x] Enable PostgreSQL `pgvector`.
* [x] Add HNSW index using `vector_cosine_ops`.
* [x] Add organization and runbook indexes for chunk lookup.

### 2. Chunking & Embedding

* [x] Create `src/lib/chunking.ts`.
* [x] Implement 800-character chunking.
* [x] Implement 150-character overlap for fixed-window splits.
* [x] Preserve paragraph boundaries where possible.
* [x] Create `src/lib/embeddings.ts`.
* [x] Route embeddings through `gemini-embedding-001`.
* [x] Generate 768-dimensional vectors.
* [x] Reuse the existing OpenAI-compatible `agentClient`.
* [x] Automatically chunk and embed runbooks during creation.

### 3. Semantic Retrieval

* [x] Create `src/lib/queries/runbook-retrieval.ts`.
* [x] Generate an embedding for the incident search query.
* [x] Retrieve the most relevant runbook chunks using cosine distance.
* [x] Limit retrieval to the top relevant results.
* [x] Enforce `orgId` scoping directly inside the SQL query.
* [x] Provide a fallback when no relevant chunks are retrieved.

### 4. Prompt Safety

* [x] Add `wrapRetrievedChunks()`.
* [x] Add `scanRetrievedChunks()`.
* [x] Fence every retrieved chunk independently.
* [x] Scan retrieved chunks independently for prompt injection.
* [x] Emit `injection_suspected` with the affected chunk ID.
* [x] Keep detection non-blocking in accordance with the Phase 4.5 trust model.

### 5. Diagnosis Integration

* [x] Replace direct runbook loading with semantic retrieval.
* [x] Build the retrieval query from incident context.
* [x] Insert only retrieved chunks into the Diagnosis context.
* [x] Handle zero retrieval results safely.
* [x] Preserve the existing tool/event flow.

### 6. Citation Verification

* [x] Add `listRunbookTitles(orgId)`.
* [x] Add `findUncitedRunbookMentions(...)`.
* [x] Compare generated runbook mentions against the retrieved set.
* [x] Emit `unretrieved_citation_suspected` for suspicious citations.
* [x] Keep citation verification advisory and non-blocking.
* [x] Add unit and Diagnosis integration tests for the tripwire.

## Definition of Done

* [x] Creating a runbook automatically generates overlapping chunks and stores their embeddings.
* [x] Runbook embeddings are stored in PostgreSQL using `pgvector`.
* [x] The HNSW vector index is configured for cosine similarity retrieval.
* [x] Diagnosis retrieves semantically relevant chunks instead of loading the complete runbook library.
* [x] Retrieval is strictly scoped to the active organization.
* [x] Retrieved chunks are individually nonce-fenced before entering the LLM prompt.
* [x] Retrieved chunks are independently scanned for prompt injection.
* [x] Prompt-injection tripwires identify the affected chunk.
* [x] Diagnosis remains stable when no relevant runbook content is retrieved.
* [x] A diagnosis mentioning a known but unretrieved runbook emits `unretrieved_citation_suspected`.
* [x] Citation verification does not block or rewrite the diagnosis.
* [x] Chunking, retrieval, tenant isolation, prompt safety, citation verification, and Diagnosis integration are covered by tests.
* [x] The embedding and retrieval workflow remains stable without introducing 500/404 failures.

## Closing Notes

Phase 5 moves Sentinel from naive runbook ingestion to a tenant-isolated semantic retrieval workflow.

The Diagnosis agent no longer needs the organization's complete runbook library in context. It retrieves the most relevant operational procedures for the current incident while preserving the prompt-safety guarantees established in Phase 4.5.

The addition of citation verification also provides a second layer of RAG observability: Sentinel can detect when the model references a runbook that was not actually retrieved for the incident and surface that discrepancy for human review.
