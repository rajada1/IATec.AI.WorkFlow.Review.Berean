import { getAzureDevOpsPATFromPipeline } from './credentials.js';

export interface PRInfo {
  organization: string;
  project: string;
  repository: string;
  pullRequestId: number;
  hostname?: string;
}

export interface PRDetails {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface PRDiffResult {
  success: boolean;
  diff?: string;
  prDetails?: PRDetails;
  currentIterationId?: number;
  skippedFiles?: number;
  error?: string;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface ApiContext {
  apiBase: string;
  headers: Record<string, string>;
}

function buildApiContext(prInfo: PRInfo): ApiContext | null {
  const pat = getAzureDevOpsPATFromPipeline();
  if (!pat) return null;

  const baseUrl = prInfo.hostname
    ? `https://${prInfo.hostname}`
    : `https://dev.azure.com/${prInfo.organization}`;

  return {
    apiBase: `${baseUrl}/${prInfo.project}/_apis`,
    headers: {
      Authorization: `Basic ${Buffer.from(':' + pat).toString('base64')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse Azure DevOps PR URL into components
 */
export function parsePRUrl(url: string): PRInfo | null {
  // Format: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
  // Or: https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id}

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // dev.azure.com format
    if (hostname === 'dev.azure.com') {
      const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/);
      if (match) {
        return {
          organization: match[1],
          project: match[2],
          repository: match[3],
          pullRequestId: parseInt(match[4], 10),
        };
      }
    }

    // visualstudio.com format
    if (hostname.endsWith('.visualstudio.com')) {
      const org = hostname.replace('.visualstudio.com', '');
      const match = parsed.pathname.match(/^\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/);
      if (match) {
        return {
          organization: org,
          project: match[1],
          repository: match[2],
          pullRequestId: parseInt(match[3], 10),
          hostname,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─── PR basic info (lightweight – just metadata, no diff) ────────────────────

export interface PRBasicInfoResult {
  success: boolean;
  prDetails?: PRDetails;
  error?: string;
}

/**
 * Fetch only the PR metadata (title, description, branches) without building a diff.
 * Use this for quick checks (e.g., @berean: ignore) before fetching the full diff.
 */
export async function fetchPRBasicInfo(prInfo: PRInfo): Promise<PRBasicInfoResult> {
  const ctx = buildApiContext(prInfo);
  if (!ctx) {
    return {
      success: false,
      error: 'Azure DevOps PAT not configured. Set AZURE_DEVOPS_PAT env var or run: berean config set azure-pat <token>',
    };
  }

  try {
    const res = await fetch(
      `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}?api-version=7.1`,
      { headers: ctx.headers },
    );

    if (!res.ok) {
      if (res.status === 401) return { success: false, error: 'Azure DevOps token is invalid or expired' };
      if (res.status === 403) return { success: false, error: 'Access denied. Check your token permissions.' };
      if (res.status === 404) return { success: false, error: 'Pull request not found. Check the URL.' };
      return { success: false, error: `Azure DevOps API error: ${res.status}` };
    }

    const data = await res.json() as {
      title: string;
      description?: string;
      sourceRefName: string;
      targetRefName: string;
    };

    return {
      success: true,
      prDetails: {
        title: data.title,
        description: data.description ?? '',
        sourceBranch: data.sourceRefName?.replace('refs/heads/', ''),
        targetBranch: data.targetRefName?.replace('refs/heads/', ''),
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ─── Fetch PR diff ────────────────────────────────────────────────────────────

export interface FetchDiffOptions {
  /** When set, only returns changes since this iteration (incremental mode) */
  fromIterationId?: number;
  /** Folder paths to exclude from the diff (e.g. ['node_modules', 'dist', 'src/generated']) */
  skipFolders?: string[];
}

/**
 * Fetch PR diff from Azure DevOps.
 *
 * When `options.fromIterationId` is provided, the diff covers only what changed
 * between that iteration and the latest one (true incremental review).
 */
export async function fetchPRDiff(prInfo: PRInfo, options: FetchDiffOptions = {}): Promise<PRDiffResult> {
  const ctx = buildApiContext(prInfo);
  if (!ctx) {
    return {
      success: false,
      error: 'Azure DevOps PAT not configured. Set AZURE_DEVOPS_PAT env var or run: berean config set azure-pat <token>',
    };
  }

  try {
    // ── 1. PR details ─────────────────────────────────────────────────────────
    const prRes = await fetch(
      `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}?api-version=7.1`,
      { headers: ctx.headers },
    );

    if (!prRes.ok) {
      if (prRes.status === 401) return { success: false, error: 'Azure DevOps token is invalid or expired' };
      if (prRes.status === 403) return { success: false, error: 'Access denied. Check your token permissions.' };
      if (prRes.status === 404) return { success: false, error: 'Pull request not found. Check the URL.' };
      return { success: false, error: `Azure DevOps API error: ${prRes.status}` };
    }

    const prData = await prRes.json() as {
      title: string;
      description?: string;
      sourceRefName: string;
      targetRefName: string;
      repository?: { id: string };
    };

    const sourceBranch = prData.sourceRefName?.replace('refs/heads/', '');
    const targetBranch = prData.targetRefName?.replace('refs/heads/', '');
    const repoId = prData.repository?.id;

    // ── 2. Iterations ─────────────────────────────────────────────────────────
    type IterationItem = { id: number; sourceRefCommit?: { commitId: string } };
    const iterRes = await fetch(
      `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/iterations?api-version=7.1`,
      { headers: ctx.headers },
    );

    let changeEntries: Array<{ item?: { path: string }; path?: string; changeType?: number }> = [];
    let currentIterationId: number | undefined;
    /** Commit at the fromIteration — used as "old" version when doing incremental diffs */
    let fromCommitId: string | undefined;

    if (iterRes.ok) {
      const iterData = await iterRes.json() as { value: IterationItem[] };
      const iterations = iterData.value ?? [];

      if (iterations.length > 0) {
        const latestIteration = iterations[iterations.length - 1];
        currentIterationId = latestIteration.id;

        const { fromIterationId } = options;

        if (fromIterationId && fromIterationId < currentIterationId) {
          // Incremental: compare fromIteration → latestIteration
          const fromIter = iterations.find(it => it.id === fromIterationId);
          fromCommitId = fromIter?.sourceRefCommit?.commitId;

          const changesRes = await fetch(
            `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/iterations/${currentIterationId}/changes?$compareTo=${fromIterationId}&api-version=7.1`,
            { headers: ctx.headers },
          );
          if (changesRes.ok) {
            const changesData = await changesRes.json() as { changeEntries: typeof changeEntries };
            changeEntries = changesData.changeEntries ?? [];
          }
        } else {
          // Full diff from latest iteration
          const changesRes = await fetch(
            `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/iterations/${currentIterationId}/changes?api-version=7.1`,
            { headers: ctx.headers },
          );
          if (changesRes.ok) {
            const changesData = await changesRes.json() as { changeEntries: typeof changeEntries };
            changeEntries = changesData.changeEntries ?? [];
          }
        }
      }
    }

    // ── 3. Fallback to commits if no iteration data ────────────────────────────
    if (changeEntries.length === 0) {
      const commitsRes = await fetch(
        `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/commits?api-version=7.1`,
        { headers: ctx.headers },
      );

      if (commitsRes.ok) {
        const commitsData = await commitsRes.json() as { value: Array<{ commitId: string }> };
        const commits = commitsData.value ?? [];

        for (const commit of commits) {
          const commitChangesRes = await fetch(
            `${ctx.apiBase}/git/repositories/${prInfo.repository}/commits/${commit.commitId}/changes?api-version=7.1`,
            { headers: ctx.headers },
          );
          if (commitChangesRes.ok) {
            const commitChangesData = await commitChangesRes.json() as { changes: typeof changeEntries };
            for (const change of commitChangesData.changes ?? []) {
              const p = change.item?.path ?? change.path;
              if (p && !changeEntries.find(e => (e.item?.path ?? e.path) === p)) {
                changeEntries.push(change);
              }
            }
          }
        }
      }
    }

    // ── 4. Build diff header ───────────────────────────────────────────────────
    const incrementalLabel = options.fromIterationId
      ? ` (incremental: iteration ${options.fromIterationId} → ${currentIterationId})`
      : '';

    let diffContent = `# Pull Request: ${prData.title}${incrementalLabel}\n`;
    if (prData.description) {
      diffContent += `Description: ${prData.description}\n`;
    }
    diffContent += `\nBranch: ${sourceBranch} → ${targetBranch}\n`;
    diffContent += `Files changed: ${changeEntries.length}\n\n---\n`;

    if (changeEntries.length === 0) {
      diffContent += '\n⚠️ No file changes detected.\n';
      return {
        success: true,
        diff: diffContent,
        prDetails: { title: prData.title, description: prData.description ?? '', sourceBranch, targetBranch },
        currentIterationId,
      };
    }

    // ── 5. Apply skip-folders filter ──────────────────────────────────────────
    const { skipFolders = [] } = options;
    let skippedFiles = 0;
    if (skipFolders.length > 0) {
      const before = changeEntries.length;
      changeEntries = changeEntries.filter(entry => {
        const p = entry.item?.path ?? entry.path ?? '';
        return !isPathInSkippedFolder(p, skipFolders);
      });
      skippedFiles = before - changeEntries.length;
    }

    // ── 6. Prioritize code files ───────────────────────────────────────────────
    const MAX_FILES = 40;
    const MAX_FILE_CHARS = 8000;
    const codeExtensions = ['.js', '.ts', '.py', '.cs', '.java', '.go', '.rs', '.cpp', '.c', '.jsx', '.tsx', '.vue', '.rb', '.php'];

    const sortedEntries = [...changeEntries].sort((a, b) => {
      const pathA = a.item?.path ?? a.path ?? '';
      const pathB = b.item?.path ?? b.path ?? '';
      const isCodeA = codeExtensions.some(ext => pathA.endsWith(ext));
      const isCodeB = codeExtensions.some(ext => pathB.endsWith(ext));
      if (isCodeA && !isCodeB) return -1;
      if (isCodeB && !isCodeA) return 1;
      return 0;
    });

    const filesToProcess = sortedEntries.slice(0, MAX_FILES);

    // ── 7. Fetch file diffs in parallel ──────────────────────────────────────
    const CONCURRENCY = 8;
    const fileSections: string[] = [];

    for (let i = 0; i < filesToProcess.length; i += CONCURRENCY) {
      const chunk = filesToProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map((entry) =>
          fetchFileSection(entry, ctx, repoId ?? prInfo.repository, sourceBranch, targetBranch, fromCommitId, MAX_FILE_CHARS),
        ),
      );
      fileSections.push(...results);
    }

    diffContent += fileSections.join('');

    if (changeEntries.length > MAX_FILES) {
      diffContent += `\n---\n⚠️ ${changeEntries.length - MAX_FILES} files not shown (limit: ${MAX_FILES})\n`;
    }

    return {
      success: true,
      diff: diffContent,
      prDetails: { title: prData.title, description: prData.description ?? '', sourceBranch, targetBranch },
      currentIterationId,
      skippedFiles,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Fetch and format a single file section for the diff.
 * Extracted for use with Promise.all parallelism.
 */
async function fetchFileSection(
  entry: { item?: { path: string }; path?: string; changeType?: number },
  ctx: ApiContext,
  repoId: string,
  sourceBranch: string,
  targetBranch: string,
  fromCommitId: string | undefined,
  maxChars: number,
): Promise<string> {
  const filePath = entry.item?.path ?? entry.path;
  if (!filePath) return '';

  const changeType = getChangeTypeName(entry.changeType);
  let section = `\n## ${changeType}: ${filePath}\n`;

  try {
    if (changeType === 'Delete') {
      section += '(File deleted)\n';
      return section;
    }

    // Current (source branch) content
    const srcRes = await fetch(
      `${ctx.apiBase}/git/repositories/${repoId}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(sourceBranch)}&versionDescriptor.versionType=branch&includeContent=true&api-version=7.1`,
      { headers: ctx.headers },
    );

    if (!srcRes.ok) {
      section += `(Could not fetch content - ${srcRes.status})\n`;
      return section;
    }

    const srcData = await srcRes.json() as { content?: string };
    if (!srcData.content) {
      section += '(Binary or empty file)\n';
      return section;
    }

    if (changeType === 'Add') {
      const truncated = srcData.content.substring(0, maxChars);
      section += '```diff\n' + truncated.split('\n').map((l: string) => '+ ' + l).join('\n');
      if (truncated.length < srcData.content.length) section += '\n... (file truncated)';
      section += '\n```\n';
      return section;
    }

    // Edit / Rename — compare against old version
    // Use fromCommitId (incremental) or targetBranch (full diff) as the "old" version
    const oldVersionParam = fromCommitId
      ? `versionDescriptor.version=${encodeURIComponent(fromCommitId)}&versionDescriptor.versionType=commit`
      : `versionDescriptor.version=${encodeURIComponent(targetBranch)}&versionDescriptor.versionType=branch`;

    const oldRes = await fetch(
      `${ctx.apiBase}/git/repositories/${repoId}/items?path=${encodeURIComponent(filePath)}&${oldVersionParam}&includeContent=true&api-version=7.1`,
      { headers: ctx.headers },
    );

    if (oldRes.ok) {
      const oldData = await oldRes.json() as { content?: string };
      const diff = generateUnifiedDiff(oldData.content ?? '', srcData.content, maxChars);
      if (diff) {
        section += '```diff\n' + diff + '\n```\n';
      } else {
        section += '(No text changes detected)\n';
      }
    } else {
      const preview = srcData.content.substring(0, maxChars);
      section += '```\n' + preview;
      if (preview.length < srcData.content.length) section += '\n... (truncated)';
      section += '\n```\n';
    }
  } catch {
    section += '(Error fetching content)\n';
  }

  return section;
}

/**
 * Returns true if the given file path is inside one of the skipped folders.
 *
 * Matching rules (case-insensitive, leading slash optional):
 *   skipFolder "node_modules"  matches  "/node_modules/lodash/index.js"
 *   skipFolder "src/generated" matches  "/src/generated/api-client.ts"
 *   skipFolder "/dist"         matches  "/dist/bundle.js"
 */
function isPathInSkippedFolder(filePath: string, skipFolders: string[]): boolean {
  // Normalise: strip leading slash so we compare apples-to-apples
  const normalised = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return skipFolders.some(folder => {
    const f = folder.replace(/^\/+|\/+$/g, '').toLowerCase();
    const n = normalised.toLowerCase();
    return n === f || n.startsWith(f + '/');
  });
}

function getChangeTypeName(changeType?: number): string {
  const types: Record<number, string> = { 1: 'Add', 2: 'Edit', 4: 'Delete', 8: 'Rename', 16: 'SourceRename' };
  return types[changeType ?? 0] ?? 'Change';
}

// ─── LCS-based unified diff ───────────────────────────────────────────────────

/**
 * Generate a unified diff with context lines using LCS algorithm.
 * Falls back to a simpler approach for very large files.
 */
function generateUnifiedDiff(oldContent: string, newContent: string, maxChars: number): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Use LCS only if file sizes are manageable (O(n*m) memory)
  if (oldLines.length * newLines.length > 300_000) {
    return generateFallbackDiff(oldLines, newLines, maxChars);
  }

  const n = oldLines.length;
  const m = newLines.length;

  // Build LCS DP table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Traceback to produce diff operations
  type DiffOp = { type: 'keep' | 'add' | 'del'; line: string; oldNum: number; newNum: number };
  const ops: DiffOp[] = [];
  let i = n, j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: 'keep', line: oldLines[i - 1], oldNum: i, newNum: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', line: newLines[j - 1], oldNum: 0, newNum: j });
      j--;
    } else {
      ops.unshift({ type: 'del', line: oldLines[i - 1], oldNum: i, newNum: 0 });
      i--;
    }
  }

  return renderHunks(ops, maxChars);
}

/**
 * Faster fallback diff with context for very large files (no LCS).
 * Adds 3 lines of context around each changed block.
 */
function generateFallbackDiff(oldLines: string[], newLines: string[], maxChars: number): string {
  type DiffOp = { type: 'keep' | 'add' | 'del'; line: string; oldNum: number; newNum: number };
  const ops: DiffOp[] = [];
  let oi = 0, ni = 0, oldNum = 1, newNum = 1;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      ops.push({ type: 'keep', line: oldLines[oi], oldNum: oldNum++, newNum: newNum++ });
      oi++; ni++;
    } else {
      if (oi < oldLines.length) {
        ops.push({ type: 'del', line: oldLines[oi], oldNum: oldNum++, newNum: 0 });
        oi++;
      }
      if (ni < newLines.length) {
        ops.push({ type: 'add', line: newLines[ni], oldNum: 0, newNum: newNum++ });
        ni++;
      }
    }
  }

  return renderHunks(ops, maxChars);
}

/**
 * Render diff ops into unified diff format with context hunks.
 */
function renderHunks(
  ops: Array<{ type: 'keep' | 'add' | 'del'; line: string; oldNum: number; newNum: number }>,
  maxChars: number,
): string {
  const CONTEXT = 3;
  const changedIdxs: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'keep') changedIdxs.push(k);
  }

  if (changedIdxs.length === 0) return '';

  // Merge nearby changes into hunks with context padding
  const hunks: Array<{ start: number; end: number }> = [];
  let hStart = Math.max(0, changedIdxs[0] - CONTEXT);
  let hEnd = Math.min(ops.length - 1, changedIdxs[0] + CONTEXT);

  for (let k = 1; k < changedIdxs.length; k++) {
    const nextStart = Math.max(0, changedIdxs[k] - CONTEXT);
    if (nextStart <= hEnd + 1) {
      hEnd = Math.min(ops.length - 1, changedIdxs[k] + CONTEXT);
    } else {
      hunks.push({ start: hStart, end: hEnd });
      hStart = nextStart;
      hEnd = Math.min(ops.length - 1, changedIdxs[k] + CONTEXT);
    }
  }
  hunks.push({ start: hStart, end: hEnd });

  const result: string[] = [];
  let chars = 0;

  for (const hunk of hunks) {
    if (chars >= maxChars) break;

    // Find first valid old/new line numbers for the hunk header
    let oldStart = 1, newStart = 1;
    for (let k = hunk.start; k <= hunk.end; k++) {
      const op = ops[k];
      if (op.oldNum > 0) { oldStart = op.oldNum; break; }
    }
    for (let k = hunk.start; k <= hunk.end; k++) {
      const op = ops[k];
      if (op.newNum > 0) { newStart = op.newNum; break; }
    }

    const header = `@@ -${oldStart} +${newStart} @@`;
    result.push(header);
    chars += header.length + 1;

    for (let k = hunk.start; k <= hunk.end && chars < maxChars; k++) {
      const { type, line } = ops[k];
      const prefix = type === 'keep' ? '  ' : type === 'add' ? '+ ' : '- ';
      const rendered = `${prefix}${line}`;
      result.push(rendered);
      chars += rendered.length + 1;
    }
  }

  if (chars >= maxChars) result.push('... (diff truncated)');
  return result.join('\n');
}

// ─── Comment posting ──────────────────────────────────────────────────────────

export interface PostCommentResult {
  success: boolean;
  threadId?: number;
  error?: string;
}

export interface BereanComment {
  threadId: number;
  commentId: number;
  content: string;
  createdDate: string;
  reviewedCommits?: string[];
  reviewedIterationId?: number;
}

// Hidden tags embedded in Berean comments to track reviewed state
const BEREAN_TAG = '<!-- berean-review -->';
const BEREAN_COMMITS_START = '<!-- berean-commits:';
const BEREAN_COMMITS_END = ':berean-commits -->';
const BEREAN_ITERATION_START = '<!-- berean-iteration:';
const BEREAN_ITERATION_END = ':berean-iteration -->';

/**
 * Find existing Berean review comments on a PR
 */
export async function findBereanComments(prInfo: PRInfo): Promise<BereanComment[]> {
  const ctx = buildApiContext(prInfo);
  if (!ctx) return [];

  try {
    const res = await fetch(
      `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/threads?api-version=7.1`,
      { headers: ctx.headers },
    );

    if (!res.ok) return [];

    const data = await res.json() as {
      value: Array<{
        id: number;
        comments: Array<{ id: number; content: string; publishedDate: string }>;
      }>;
    };

    const bereanComments: BereanComment[] = [];

    for (const thread of data.value ?? []) {
      for (const comment of thread.comments ?? []) {
        if (
          comment.content?.includes(BEREAN_TAG) ||
          comment.content?.includes('Generated by [Berean]') ||
          comment.content?.includes('Generated by Berean')
        ) {
          bereanComments.push({
            threadId: thread.id,
            commentId: comment.id,
            content: comment.content,
            createdDate: comment.publishedDate,
            reviewedCommits: extractReviewedCommits(comment.content),
            reviewedIterationId: extractReviewedIteration(comment.content),
          });
        }
      }
    }

    return bereanComments;
  } catch {
    return [];
  }
}

function extractReviewedCommits(content: string): string[] {
  const startIdx = content.indexOf(BEREAN_COMMITS_START);
  const endIdx = content.indexOf(BEREAN_COMMITS_END);
  if (startIdx === -1 || endIdx === -1) return [];
  return content
    .substring(startIdx + BEREAN_COMMITS_START.length, endIdx)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function extractReviewedIteration(content: string): number | undefined {
  const start = content.indexOf(BEREAN_ITERATION_START);
  const end = content.indexOf(BEREAN_ITERATION_END);
  if (start === -1 || end === -1) return undefined;
  const val = parseInt(content.substring(start + BEREAN_ITERATION_START.length, end).trim(), 10);
  return isNaN(val) ? undefined : val;
}

/**
 * Embed the list of reviewed commit IDs into a comment (as a hidden HTML tag)
 */
export function addReviewedCommitsTag(comment: string, commitIds: string[]): string {
  const tag = `${BEREAN_COMMITS_START}${commitIds.join(',')}${BEREAN_COMMITS_END}`;
  return `${BEREAN_TAG}\n${comment}\n\n${tag}`;
}

/**
 * Embed the reviewed iteration ID into a comment (as a hidden HTML tag)
 */
export function addReviewedIterationTag(comment: string, iterationId: number): string {
  return `${comment}\n${BEREAN_ITERATION_START}${iterationId}${BEREAN_ITERATION_END}`;
}

/**
 * Get all commit IDs for a PR
 */
export async function getPRCommits(prInfo: PRInfo): Promise<string[]> {
  const ctx = buildApiContext(prInfo);
  if (!ctx) return [];

  try {
    const res = await fetch(
      `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/commits?api-version=7.1`,
      { headers: ctx.headers },
    );

    if (!res.ok) return [];

    const data = await res.json() as { value: Array<{ commitId: string }> };
    return (data.value ?? []).map(c => c.commitId);
  } catch {
    return [];
  }
}

/**
 * Check if PR description contains an ignore keyword.
 * Normalises whitespace so "@ berean : ignore" also matches.
 */
export function shouldIgnorePR(description: string | undefined): boolean {
  if (!description) return false;
  const normalised = description.replace(/\s+/g, ' ').toLowerCase();
  const ignorePatterns = [
    '@berean: ignore',
    '@berean:ignore',
    '@berean ignore',
    '[berean:ignore]',
    '[berean: ignore]',
  ];
  return ignorePatterns.some(p => normalised.includes(p));
}

/**
 * Update an existing Berean comment (for incremental reviews)
 */
export async function updatePRComment(
  prInfo: PRInfo,
  threadId: number,
  commentId: number,
  newContent: string,
): Promise<PostCommentResult> {
  const ctx = buildApiContext(prInfo);
  if (!ctx) return { success: false, error: 'Azure DevOps PAT not configured' };

  try {
    const res = await fetch(
      `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/threads/${threadId}/comments/${commentId}?api-version=7.1`,
      { method: 'PATCH', headers: ctx.headers, body: JSON.stringify({ content: newContent }) },
    );

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({})) as { message?: string };
      return { success: false, error: errorData.message ?? `HTTP ${res.status}` };
    }

    return { success: true, threadId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Post a general comment to a PR
 */
export async function postPRComment(prInfo: PRInfo, comment: string): Promise<PostCommentResult> {
  const ctx = buildApiContext(prInfo);
  if (!ctx) return { success: false, error: 'Azure DevOps PAT not configured' };

  try {
    const threadPayload = {
      comments: [{ parentCommentId: 0, content: comment, commentType: 1 }],
      status: 1,
    };

    const res = await fetch(
      `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/threads?api-version=7.1`,
      { method: 'POST', headers: ctx.headers, body: JSON.stringify(threadPayload) },
    );

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({})) as { message?: string };
      return { success: false, error: errorData.message ?? `HTTP ${res.status}` };
    }

    const data = await res.json() as { id: number };
    return { success: true, threadId: data.id };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ─── Inline comments ──────────────────────────────────────────────────────────

export interface InlineComment {
  filePath: string;
  line: number;
  content: string;
}

/**
 * Post multiple inline comments to a PR.
 *
 * Improvements over the previous version:
 * - Fetches the latest iterationId once (instead of per-comment)
 * - Skips file:line locations that already have an open inline thread
 */
export async function postInlineComments(
  prInfo: PRInfo,
  comments: InlineComment[],
): Promise<{ success: number; failed: number; errors: string[] }> {
  const ctx = buildApiContext(prInfo);
  if (!ctx) {
    return {
      success: 0,
      failed: comments.length,
      errors: ['Azure DevOps PAT not configured'],
    };
  }

  // 1. Fetch iterationId once
  let iterationId = 1;
  const iterRes = await fetch(
    `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/iterations?api-version=7.1`,
    { headers: ctx.headers },
  ).catch(() => null);

  if (iterRes?.ok) {
    const iterData = await iterRes.json() as { value: Array<{ id: number }> };
    const iterations = iterData.value ?? [];
    if (iterations.length > 0) iterationId = iterations[iterations.length - 1].id;
  }

  // 2. Fetch existing inline threads for deduplication
  const existingKeys = new Set<string>();
  const threadsRes = await fetch(
    `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/threads?api-version=7.1`,
    { headers: ctx.headers },
  ).catch(() => null);

  if (threadsRes?.ok) {
    const threadsData = await threadsRes.json() as {
      value: Array<{
        isDeleted?: boolean;
        threadContext?: { filePath?: string; rightFileStart?: { line?: number } };
      }>;
    };
    for (const thread of threadsData.value ?? []) {
      if (thread.isDeleted) continue;
      const fp = thread.threadContext?.filePath;
      const ln = thread.threadContext?.rightFileStart?.line;
      if (fp && ln) existingKeys.add(`${fp}:${ln}`);
    }
  }

  // 3. Post comments, skipping duplicates
  const results = { success: 0, failed: 0, errors: [] as string[] };

  for (const comment of comments) {
    const key = `${comment.filePath}:${comment.line}`;

    if (existingKeys.has(key)) {
      // Already has an inline comment here — skip to avoid spam
      results.success++;
      continue;
    }

    const result = await postInlineComment(prInfo, comment.filePath, comment.line, comment.content, iterationId, ctx);

    if (result.success) {
      results.success++;
      existingKeys.add(key); // prevent duplicates within the same batch
    } else {
      results.failed++;
      results.errors.push(`${comment.filePath}:${comment.line} - ${result.error}`);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return results;
}

/**
 * Post a single inline comment to a specific file/line in a PR.
 * Accepts a pre-fetched iterationId and optional ApiContext to avoid repeated setup.
 */
async function postInlineComment(
  prInfo: PRInfo,
  filePath: string,
  line: number,
  content: string,
  iterationId: number,
  ctx: ApiContext,
): Promise<PostCommentResult> {
  try {
    const threadPayload = {
      comments: [{ parentCommentId: 0, content, commentType: 1 }],
      status: 1,
      threadContext: {
        filePath,
        rightFileStart: { line, offset: 1 },
        rightFileEnd: { line, offset: 1 },
      },
      pullRequestThreadContext: {
        iterationContext: {
          firstComparingIteration: iterationId,
          secondComparingIteration: iterationId,
        },
        changeTrackingId: 0,
      },
    };

    const res = await fetch(
      `${ctx.apiBase}/git/repositories/${prInfo.repository}/pullRequests/${prInfo.pullRequestId}/threads?api-version=7.1`,
      { method: 'POST', headers: ctx.headers, body: JSON.stringify(threadPayload) },
    );

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({})) as { message?: string };
      return { success: false, error: errorData.message ?? `HTTP ${res.status}` };
    }

    const data = await res.json() as { id: number };
    return { success: true, threadId: data.id };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
