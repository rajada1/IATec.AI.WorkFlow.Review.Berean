/**
 * Rules service — resolves rule sources (files, directories, static URLs,
 * or dynamic RAG-style URLs with a {{query}} placeholder) into a single
 * combined rules string that gets injected into the AI review prompt.
 *
 * Supported source formats (comma-separated in --rules / BEREAN_RULES):
 *   - /path/to/file.md                       → file
 *   - /path/to/rules-dir                     → directory (all files inside)
 *   - https://example.com/rules.md           → static URL (fetched once)
 *   - https://host/search?q={{query}}        → dynamic URL (LLM generates queries,
 *                                              fetched in parallel for each query)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMaxRulesChars } from './credentials.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RuleSourceType = 'file' | 'directory' | 'url';

export interface RuleSource {
  type: RuleSourceType;
  /** Original value as provided by the user */
  rawValue: string;
  /** Absolute path (files/dirs) or URL (unchanged) */
  resolvedValue: string;
  /** True if the URL contains the {{query}} placeholder */
  hasDynamicQuery: boolean;
}

export interface SourceReport {
  label: string;
  type: RuleSourceType;
  status: 'ok' | 'warn' | 'skip';
  message?: string;
}

export interface ResolveRulesResult {
  rules: string;
  sources: SourceReport[];
}

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Maximum chars returned per URL fetch (per query) */
const MAX_URL_RESPONSE_CHARS = 3_000;

/** Timeout (ms) per HTTP fetch */
const URL_TIMEOUT_MS = 12_000;

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a comma-separated rules string into individual RuleSources.
 *
 * Each token is classified as:
 *   - url   → starts with http:// or https://
 *   - directory → resolved path is an existing directory
 *   - file  → anything else (will fail gracefully if path not found)
 *
 * @param input Comma-separated rule sources string (from --rules or BEREAN_RULES).
 */
export function parseRuleSources(input: string): RuleSource[] {
  return input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(value => {
      if (/^https?:\/\//i.test(value)) {
        return {
          type: 'url' as const,
          rawValue: value,
          resolvedValue: value,
          hasDynamicQuery: /\{\{query\}\}/i.test(value),
        };
      }

      const resolved = path.resolve(value);
      let type: RuleSourceType = 'file';
      try {
        type = fs.statSync(resolved).isDirectory() ? 'directory' : 'file';
      } catch {
        // Path doesn't exist — will fail gracefully when read
      }
      return { type, rawValue: value, resolvedValue: resolved, hasDynamicQuery: false };
    });
}

// ─── File / directory loading ─────────────────────────────────────────────────

interface LoadResult {
  content: string | null;
  error?: string;
}

function loadFileSource(source: RuleSource): LoadResult {
  try {
    if (source.type === 'directory') {
      const files = fs.readdirSync(source.resolvedValue)
        .filter(f => !f.startsWith('.'))
        .sort();

      const parts: string[] = [];
      for (const file of files) {
        const filePath = path.join(source.resolvedValue, file);
        if (fs.statSync(filePath).isFile()) {
          const content = fs.readFileSync(filePath, 'utf-8');
          parts.push(`### ${file}\n\n${content}`);
        }
      }
      return parts.length > 0
        ? { content: parts.join('\n\n---\n\n') }
        : { content: null, error: `Directory is empty: ${source.resolvedValue}` };
    }

    const content = fs.readFileSync(source.resolvedValue, 'utf-8');
    return { content };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { content: null, error: `Path does not exist: ${source.resolvedValue}` };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { content: null, error: `Permission denied: ${source.resolvedValue}` };
    }
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return { content: null, error: msg };
  }
}

// ─── URL fetching ─────────────────────────────────────────────────────────────

/**
 * Fetch content from a URL.
 * If the URL contains {{query}}, replaces it with the provided query string (URL-encoded).
 *
 * @param urlTemplate URL to fetch; may include {{query}} placeholder.
 * @param query Optional query string to substitute into {{query}}.
 */
export async function fetchFromUrl(urlTemplate: string, query?: string): Promise<string> {
  const url = query
    ? urlTemplate.replace(/\{\{query\}\}/gi, encodeURIComponent(query))
    : urlTemplate;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    headers: { Accept: 'text/plain, application/json, */*' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${hostname(url)}`);
  }

  const text = await response.text();
  return text.substring(0, MAX_URL_RESPONSE_CHARS);
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Resolve all rule sources into a single combined rules string.
 *
 * @param sources         Parsed rule sources (from parseRuleSources)
 * @param diff            The PR diff — used to generate queries for dynamic URL sources
 * @param generateQueries Callback that asks the LLM for relevant search queries.
 *                        Injected from review.ts to avoid coupling with github-copilot.ts.
 * @param maxRulesCharsDefault Optional default max rules length when no config/env is set.
 */
export async function resolveRules(
  sources: RuleSource[],
  diff: string,
  generateQueries: (diff: string) => Promise<string[]>,
  maxRulesCharsDefault?: number,
): Promise<ResolveRulesResult> {
  const parts: string[] = [];
  const report: SourceReport[] = [];

  for (const source of sources) {
    // ── File / directory ───────────────────────────────────────────────────────
    if (source.type === 'file' || source.type === 'directory') {
      const result = loadFileSource(source);
      if (result.content) {
        const label =
          source.type === 'directory'
            ? `Directory: ${source.rawValue}`
            : path.basename(source.resolvedValue);
        parts.push(`## ${label}\n\n${result.content}`);
        report.push({ label: source.rawValue, type: source.type, status: 'ok' });
      } else {
        report.push({
          label: source.rawValue,
          type: source.type,
          status: 'warn',
          message: result.error || `Could not read: ${source.resolvedValue}`,
        });
      }
      continue;
    }

    // ── Static URL (no {{query}}) ─────────────────────────────────────────────
    if (!source.hasDynamicQuery) {
      try {
        const content = await fetchFromUrl(source.resolvedValue);
        parts.push(`## Rules from ${hostname(source.resolvedValue)}\n\n${content}`);
        report.push({ label: source.rawValue, type: 'url', status: 'ok' });
      } catch (e) {
        report.push({
          label: source.rawValue,
          type: 'url',
          status: 'warn',
          message: e instanceof Error ? e.message : 'Fetch failed',
        });
      }
      continue;
    }

    // ── Dynamic URL with {{query}} ────────────────────────────────────────────
    let queries: string[] = [];
    try {
      queries = await generateQueries(diff);
    } catch {
      queries = [];
    }

    if (queries.length === 0) {
      // No queries generated — fetch without substitution as best-effort fallback
      try {
        const urlWithoutPlaceholder = source.resolvedValue.replace(/\{\{query\}\}/gi, '');
        const content = await fetchFromUrl(urlWithoutPlaceholder);
        parts.push(`## Rules from ${hostname(source.resolvedValue)}\n\n${content}`);
        report.push({
          label: source.rawValue,
          type: 'url',
          status: 'ok',
          message: 'No queries generated — fetched without query parameter',
        });
      } catch (e) {
        report.push({
          label: source.rawValue,
          type: 'url',
          status: 'warn',
          message: e instanceof Error ? e.message : 'Fetch failed (no queries generated)',
        });
      }
      continue;
    }

    // Fetch all queries in parallel
    const fetchResults = await Promise.all(
      queries.map(query =>
        fetchFromUrl(source.resolvedValue, query)
          .then(content => ({ query, content, ok: true }))
          .catch(e => ({
            query,
            content: '',
            ok: false,
            error: e instanceof Error ? e.message : 'Fetch failed',
          })),
      ),
    );

    const successful = fetchResults.filter(r => r.ok && r.content);

    if (successful.length > 0) {
      const fetchedParts = successful.map(r => `### Query: "${r.query}"\n\n${r.content}`);
      parts.push(
        `## Rules from ${hostname(source.resolvedValue)}\n\n${fetchedParts.join('\n\n---\n\n')}`,
      );
      report.push({
        label: source.rawValue,
        type: 'url',
        status: 'ok',
        message: `Fetched ${successful.length}/${queries.length} queries`,
      });
    } else {
      report.push({
        label: source.rawValue,
        type: 'url',
        status: 'warn',
        message: `All ${queries.length} URL fetches failed`,
      });
    }
  }

  // ── Combine & cap total size ─────────────────────────────────────────────────
  const maxTotalRulesChars = getMaxRulesChars(maxRulesCharsDefault);
  let combined = parts.join('\n\n---\n\n');
  if (combined.length > maxTotalRulesChars) {
    combined = combined.substring(0, maxTotalRulesChars) + '\n... (rules truncated)';
    report.push({
      label: '(limit)',
      type: 'file',
      status: 'warn',
      message: `Total rules truncated to ${maxTotalRulesChars} chars (set BEREAN_MAX_RULES_CHARS to adjust)`,
    });
  }

  return { rules: combined, sources: report };
}
