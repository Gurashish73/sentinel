import "server-only";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length <= CHUNK_SIZE) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }
    if (current) chunks.push(current);

    if (paragraph.length <= CHUNK_SIZE) {
      current = paragraph;
    } else {
      for (let i = 0; i < paragraph.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        chunks.push(paragraph.slice(i, i + CHUNK_SIZE));
      }
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}