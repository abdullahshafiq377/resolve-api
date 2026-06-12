// Plain-text extraction from Tiptap/ProseMirror article bodies, mirroring the
// frontend renderer in
// resolve-webapp/src/app/components/ui/editorjs-content/EditorJsContent.tsx
// (`renderBlock`). Keep the custom-block list in sync with that component — if a
// new block type is added there, add it here or its text drops out of chat/RAG.

/* eslint-disable @typescript-eslint/no-explicit-any */

type JSONContent = any;

// Recursively collect text from a standard rich-text subtree (paragraphs,
// headings, lists, blockquotes, marks, hardBreaks…). Leaf `text` nodes carry the
// content; container nodes carry `content`.
function inlineText(node: JSONContent): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(inlineText).join('');
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  if (Array.isArray(node.content)) {
    return node.content.map(inlineText).join('');
  }
  return '';
}

function listItemsText(node: JSONContent): string {
  if (!Array.isArray(node?.content)) return '';
  return node.content
    .map((item: JSONContent) => {
      const text = inlineText(item).trim();
      return text ? `- ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function clean(s: unknown): string {
  return typeof s === 'string' ? s.trim() : '';
}

// Convert one top-level block to plain text. Returns '' for pure-layout / unknown
// blocks (which contribute nothing meaningful to comprehension).
function blockToText(node: JSONContent): string {
  if (node == null) return '';
  const attrs = node.attrs ?? {};

  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'blockquote':
      return inlineText(node).trim();

    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listItemsText(node);

    case 'pullQuote': {
      const text = clean(attrs.text);
      const author = clean(attrs.author);
      if (!text) return '';
      return author ? `"${text}" — ${author}` : `"${text}"`;
    }

    case 'keyPoints': {
      const items = Array.isArray(attrs.items) ? attrs.items : [];
      return items
        .map((i: JSONContent) => [clean(i?.title), clean(i?.description)].filter(Boolean).join(': '))
        .filter(Boolean)
        .join('\n');
    }

    case 'timeline': {
      const entries = Array.isArray(attrs.entries) ? attrs.entries : [];
      return entries
        .map((e: JSONContent) => [clean(e?.title), clean(e?.description)].filter(Boolean).join(': '))
        .filter(Boolean)
        .join('\n');
    }

    case 'imageGallery': {
      const images = Array.isArray(attrs.images) ? attrs.images : [];
      return images
        .map((img: JSONContent) => clean(img?.caption))
        .filter(Boolean)
        .join('\n');
    }

    case 'imageText': {
      // Two-column blocks: a rich-text side plus image captions. Accept either a
      // `rows` array or a single `row`, each with nested `text` content + image
      // caption. Current frontend nodes store `imageCaption`; keep `caption` as a
      // legacy fallback for older content.
      const rows = Array.isArray(attrs.rows) ? attrs.rows : attrs.row ? [attrs.row] : [];
      return rows
        .map((row: JSONContent) =>
          [inlineText(row?.text).trim(), clean(row?.imageCaption) || clean(row?.caption)].filter(Boolean).join('\n'),
        )
        .filter(Boolean)
        .join('\n');
    }

    case 'videoSection':
      return [clean(attrs.heading), clean(attrs.description)].filter(Boolean).join('\n');

    case 'image':
      return [clean(attrs.title), clean(attrs.alt)].filter(Boolean).join(' — ');

    case 'embed':
      return clean(attrs.caption);

    default:
      // Unknown standard container with text children (forward-compatible).
      if (Array.isArray(node.content)) return inlineText(node).trim();
      return '';
  }
}

// Traverse a Tiptap document body and return its plain text. Accepts the doc
// node ({ type:'doc', content:[…] }) or a bare content array.
export function extractPlainText(body: JSONContent): string {
  if (body == null) return '';
  const blocks: JSONContent[] = Array.isArray(body)
    ? body
    : Array.isArray(body.content)
      ? body.content
      : [];
  return blocks
    .map(blockToText)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Approximate token count (Gemini averages ~4 chars/token for English).
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ChunkOptions {
  size?: number; // target chunk size in approx tokens
  overlap?: number; // overlap between consecutive chunks in approx tokens
}

// Split text into ~`size`-token chunks with ~`overlap`-token overlap, on word
// boundaries (Phase 2 embedding unit). ~1.3 tokens per whitespace word.
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.size ?? 800;
  const overlap = opts.overlap ?? 100;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const TOKENS_PER_WORD = 1.3;
  const wordsPerChunk = Math.max(1, Math.round(size / TOKENS_PER_WORD));
  const overlapWords = Math.min(wordsPerChunk - 1, Math.max(0, Math.round(overlap / TOKENS_PER_WORD)));
  const stride = Math.max(1, wordsPerChunk - overlapWords);

  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += stride) {
    const chunk = words.slice(start, start + wordsPerChunk).join(' ');
    if (chunk) chunks.push(chunk);
    if (start + wordsPerChunk >= words.length) break;
  }
  return chunks;
}
