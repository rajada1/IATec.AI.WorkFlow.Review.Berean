/**
 * Memory service — loads a MEMORY.md index file and resolves topic files
 * referenced within it, providing enriched context for the two-phase agentic review.
 *
 * MEMORY.md format (Markdown links in any section):
 *   - [Authentication](./docs/auth.md)
 *   - [Payment Patterns](./docs/payments.md)
 *   [API Design](./docs/api-design.md)
 *
 * Any line containing a Markdown link `[label](relative/path)` pointing to a
 * local file (not an http URL) is treated as a memory pointer.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Maximum number of topic files loaded per review */
export const MAX_TOPIC_FILES = 5;

/** Maximum chars taken from each topic file */
export const MAX_TOPIC_FILE_CHARS = 3_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryPointer {
  /** Human-readable topic label */
  topic: string;
  /** Absolute resolved file path */
  filePath: string;
  /** Original relative path as written in MEMORY.md */
  relativePath: string;
}

// ─── Index loading ────────────────────────────────────────────────────────────

/**
 * Read a MEMORY.md file from disk and return its raw content.
 * Returns null if the file doesn't exist or can't be read.
 */
export function loadMemoryIndex(filePath: string): string | null {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return null;
    return fs.readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Pointer parsing ──────────────────────────────────────────────────────────

/**
 * Extract memory pointers from a MEMORY.md content string.
 *
 * Recognises Markdown links whose target is a local relative path:
 *   [Topic Name](./relative/path.md)
 *   [Topic Name](relative/path.md)
 *
 * HTTP/HTTPS links are ignored.
 */
export function parseMemoryPointers(content: string, baseDir: string): MemoryPointer[] {
  const pointers: MemoryPointer[] = [];

  // Match every Markdown link: [label](target)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(content)) !== null) {
    const topic = match[1].trim();
    const rawPath = match[2].trim();

    // Skip HTTP links and anchors
    if (/^https?:\/\//i.test(rawPath) || rawPath.startsWith('#')) continue;

    const filePath = path.resolve(baseDir, rawPath);
    pointers.push({ topic, filePath, relativePath: rawPath });
  }

  return pointers;
}

// ─── Topic file loading ───────────────────────────────────────────────────────

/**
 * Read a single topic file from disk.
 * Returns null if the file doesn't exist or can't be read.
 * Content is capped at MAX_TOPIC_FILE_CHARS.
 */
export function loadTopicFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.length > MAX_TOPIC_FILE_CHARS) {
      return raw.substring(0, MAX_TOPIC_FILE_CHARS) + '\n... (truncated)';
    }
    return raw;
  } catch {
    return null;
  }
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Given the full set of memory pointers and a list of relative paths requested
 * by the AI (Phase 1), load the matching topic files from disk.
 *
 * Matching is done by normalizing both sides to forward-slash relative paths
 * and also by topic label (case-insensitive) as a fallback.
 *
 * Returns a record mapping `topic label → file content` for up to MAX_TOPIC_FILES entries.
 */
export function resolveTopicFiles(
  pointers: MemoryPointer[],
  neededPaths: string[],
): Record<string, string> {
  const result: Record<string, string> = {};

  const normalise = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

  // Build lookup maps: normalised relative path → pointer, topic → pointer
  const byPath = new Map<string, MemoryPointer>();
  const byTopic = new Map<string, MemoryPointer>();

  for (const ptr of pointers) {
    byPath.set(normalise(ptr.relativePath), ptr);
    byTopic.set(ptr.topic.toLowerCase(), ptr);
  }

  for (const requested of neededPaths) {
    if (Object.keys(result).length >= MAX_TOPIC_FILES) break;

    const normRequested = normalise(requested);
    const ptr =
      byPath.get(normRequested) ??
      byTopic.get(requested.toLowerCase()) ??
      // Also try matching by basename
      [...byPath.values()].find(p => path.basename(p.filePath) === path.basename(requested));

    if (!ptr) continue;
    if (result[ptr.topic] !== undefined) continue; // already loaded

    const content = loadTopicFile(ptr.filePath);
    if (content) {
      result[ptr.topic] = content;
    }
  }

  return result;
}
