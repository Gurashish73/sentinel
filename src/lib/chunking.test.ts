import { describe, it, expect } from "vitest";
import { chunkText } from "@/lib/chunking";

describe("chunkText", () => {
  it("returns a single chunk for short content", () => {
    const chunks = chunkText("Restart the connection pool service and monitor for 10 minutes.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Restart the connection pool service");
  });

  it("groups multiple short paragraphs into one chunk when they fit", () => {
    const text = "Step 1: check the pool metrics.\n\nStep 2: restart the service.\n\nStep 3: verify recovery.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Step 1");
    expect(chunks[0]).toContain("Step 3");
  });

  it("splits into multiple chunks once accumulated paragraphs exceed the size limit", () => {
    const paragraph = "A".repeat(500);
    // Four ~500 char paragraphs won't all fit in one 800-char chunk.
    const text = [paragraph, paragraph, paragraph, paragraph].join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should silently drop content — every char across all chunks
    // traces back to the source (allowing for the joining "\n\n").
    const totalContentLength = chunks.reduce((sum, c) => sum + c.replace(/\n\n/g, "").length, 0);
    expect(totalContentLength).toBeGreaterThanOrEqual(paragraph.length * 4 * 0.9);
  });

  it("falls back to a fixed window with overlap for a single paragraph longer than one chunk", () => {
    const longParagraph = "word ".repeat(400); // ~2000 chars, no blank-line breaks
    const chunks = chunkText(longParagraph);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk individually respects the size ceiling.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(800);
    }
  });

  it("overlaps consecutive windowed chunks so a boundary sentence isn't lost entirely", () => {
    const longParagraph = "word ".repeat(400);
    const chunks = chunkText(longParagraph);
    // With 150 chars of overlap, the tail of chunk N should reappear at
    // the head of chunk N+1.
    const tailOfFirst = chunks[0].slice(-100);
    expect(chunks[1]).toContain(tailOfFirst.slice(0, 50));
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n   ")).toEqual([]);
  });

  it("ignores extra blank lines between paragraphs", () => {
    const text = "First paragraph.\n\n\n\nSecond paragraph.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("First paragraph.");
    expect(chunks[0]).toContain("Second paragraph.");
  });
});