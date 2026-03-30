import { getGitHubToken } from './credentials.js';
import type {
  PRBasicInfoResult,
  PRDiffResult,
  PostCommentResult,
  BereanComment,
  InlineComment,
  FetchDiffOptions,
} from './azure-devops.js';

export interface GitHubPRInfo {
  owner: string;
  repo: string;
  pullNumber: number;
}

// Hidden tags (same values as azure-devops.ts)
const BEREAN_TAG = '<!-- berean-review -->';
const BEREAN_COMMITS_START = '<!-- berean-commits:';
const BEREAN_COMMITS_END = ':berean-commits -->';
const BEREAN_ITERATION_START = '<!-- berean-iteration:';
const BEREAN_ITERATION_END = ':berean-iteration -->';

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface GitHubApiContext {
  headers: Record<string, string>;
}

function buildGitHubApiContext(): GitHubApiContext | null {
  const token = getGitHubToken();
  if (!token) return null;

  return {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
  };
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse a GitHub PR URL into components.
 *
 * Supported formats:
 *   https://github.com/{owner}/{repo}/pull/{number}
 *   https://github.com/{owner}/{repo}/pull/{number}/files
 *   https://github.com/{owner}/{repo}/pull/{number}/commits
 */
export function parseGitHubPRUrl(url: string): GitHubPRInfo | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return null;

    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;

    return {
      owner: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2]),
      pullNumber: parseInt(match[3], 10),
    };
  } catch {
    return null;
  }
}

// ─── PR basic info (lightweight – just metadata, no diff) ────────────────────

/**
 * Fetch only the PR metadata (title, description, branches) from GitHub.
 */
export async function fetchGitHubPRBasicInfo(prInfo: GitHubPRInfo): Promise<PRBasicInfoResult> {
  const ctx = buildGitHubApiContext();
  if (!ctx) {
    return {
      success: false,
      error: 'GitHub token not configured. Set GITHUB_TOKEN or GH_TOKEN environment variable.',
    };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/pulls/${prInfo.pullNumber}`,
      { headers: ctx.headers },
    );

    if (!res.ok) {
      if (res.status === 401) return { success: false, error: 'GitHub token is invalid or expired' };
      if (res.status === 403) return { success: false, error: 'Access denied. Check your token permissions.' };
      if (res.status === 404) return { success: false, error: 'Pull request not found. Check the URL.' };
      return { success: false, error: `GitHub API error: ${res.status}` };
    }

    const data = await res.json() as {
      title: string;
      body?: string;
      head: { ref: string };
      base: { ref: string };
    };

    return {
      success: true,
      prDetails: {
        title: data.title,
        description: data.body ?? '',
        sourceBranch: data.head.ref,
        targetBranch: data.base.ref,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ─── Fetch PR diff ────────────────────────────────────────────────────────────

/**
 * Fetch PR diff from the GitHub API.
 *
 * Uses the "list pull request files" endpoint which returns per-file patches.
 * The `fromIterationId` option from {@link FetchDiffOptions} is Azure-specific
 * and is ignored for GitHub; the full diff is always returned.
 */
export async function fetchGitHubPRDiff(
  prInfo: GitHubPRInfo,
  options: FetchDiffOptions = {},
): Promise<PRDiffResult> {
  const ctx = buildGitHubApiContext();
  if (!ctx) {
    return {
      success: false,
      error: 'GitHub token not configured. Set GITHUB_TOKEN or GH_TOKEN environment variable.',
    };
  }

  try {
    // ── 1. PR metadata ────────────────────────────────────────────────────────
    const prRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/pulls/${prInfo.pullNumber}`,
      { headers: ctx.headers },
    );

    if (!prRes.ok) {
      if (prRes.status === 401) return { success: false, error: 'GitHub token is invalid or expired' };
      if (prRes.status === 403) return { success: false, error: 'Access denied. Check your token permissions.' };
      if (prRes.status === 404) return { success: false, error: 'Pull request not found. Check the URL.' };
      return { success: false, error: `GitHub API error: ${prRes.status}` };
    }

    const prData = await prRes.json() as {
      title: string;
      body?: string;
      head: { ref: string; sha: string };
      base: { ref: string };
      changed_files: number;
    };

    const sourceBranch = prData.head.ref;
    const targetBranch = prData.base.ref;

    // ── 2. Fetch changed files (paginated) ────────────────────────────────────
    interface GitHubFile {
      filename: string;
      status: string;
      patch?: string;
      additions: number;
      deletions: number;
      changes: number;
      previous_filename?: string;
    }

    let allFiles: GitHubFile[] = [];
    let page = 1;
    const perPage = 100;

    while (allFiles.length < 300) {
      const filesRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/pulls/${prInfo.pullNumber}/files?per_page=${perPage}&page=${page}`,
        { headers: ctx.headers },
      );

      if (!filesRes.ok) break;

      const files = await filesRes.json() as GitHubFile[];
      if (files.length === 0) break;

      allFiles.push(...files);
      if (files.length < perPage) break;
      page++;
    }

    // ── 3. Apply skip-folders filter ──────────────────────────────────────────
    const { skipFolders = [] } = options;
    let skippedFiles = 0;

    if (skipFolders.length > 0) {
      const before = allFiles.length;
      allFiles = allFiles.filter(file => !isPathInSkippedFolder(file.filename, skipFolders));
      skippedFiles = before - allFiles.length;
    }

    // ── 4. Prioritize code files ──────────────────────────────────────────────
    const MAX_FILES = 40;
    const MAX_FILE_CHARS = 8000;
    const codeExtensions = ['.js', '.ts', '.py', '.cs', '.java', '.go', '.rs', '.cpp', '.c', '.jsx', '.tsx', '.vue', '.rb', '.php'];

    const sortedFiles = [...allFiles].sort((a, b) => {
      const isCodeA = codeExtensions.some(ext => a.filename.endsWith(ext));
      const isCodeB = codeExtensions.some(ext => b.filename.endsWith(ext));
      if (isCodeA && !isCodeB) return -1;
      if (isCodeB && !isCodeA) return 1;
      return 0;
    });

    const filesToProcess = sortedFiles.slice(0, MAX_FILES);

    // ── 5. Build diff content ─────────────────────────────────────────────────
    let diffContent = `# Pull Request: ${prData.title}\n`;
    if (prData.body) {
      diffContent += `Description: ${prData.body}\n`;
    }
    diffContent += `\nBranch: ${sourceBranch} → ${targetBranch}\n`;
    diffContent += `Files changed: ${allFiles.length}\n\n---\n`;

    if (allFiles.length === 0) {
      diffContent += '\n⚠️ No file changes detected.\n';
      return {
        success: true,
        diff: diffContent,
        prDetails: { title: prData.title, description: prData.body ?? '', sourceBranch, targetBranch },
      };
    }

    for (const file of filesToProcess) {
      const changeType = getGitHubChangeType(file.status);
      diffContent += `\n## ${changeType}: ${file.filename}\n`;

      if (file.status === 'removed') {
        diffContent += '(File deleted)\n';
      } else if (file.patch) {
        const patch = file.patch.substring(0, MAX_FILE_CHARS);
        diffContent += '```diff\n' + patch;
        if (patch.length < (file.patch?.length ?? 0)) diffContent += '\n... (diff truncated)';
        diffContent += '\n```\n';
      } else {
        diffContent += '(Binary file or diff too large)\n';
      }
    }

    if (allFiles.length > MAX_FILES) {
      diffContent += `\n---\n⚠️ ${allFiles.length - MAX_FILES} files not shown (limit: ${MAX_FILES})\n`;
    }

    return {
      success: true,
      diff: diffContent,
      prDetails: { title: prData.title, description: prData.body ?? '', sourceBranch, targetBranch },
      skippedFiles,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function getGitHubChangeType(status: string): string {
  const types: Record<string, string> = {
    added: 'Add',
    removed: 'Delete',
    modified: 'Edit',
    renamed: 'Rename',
    copied: 'Copy',
    changed: 'Change',
    unchanged: 'Unchanged',
  };
  return types[status] ?? 'Change';
}

/**
 * Returns true if the given file path is inside one of the skipped folders.
 */
function isPathInSkippedFolder(filePath: string, skipFolders: string[]): boolean {
  const normalised = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return skipFolders.some(folder => {
    const f = folder.replace(/^\/+|\/+$/g, '').toLowerCase();
    const n = normalised.toLowerCase();
    return n === f || n.startsWith(f + '/');
  });
}

// ─── Comment posting ──────────────────────────────────────────────────────────

/**
 * Post a general comment (issue comment) on a GitHub PR.
 */
export async function postGitHubPRComment(
  prInfo: GitHubPRInfo,
  comment: string,
): Promise<PostCommentResult> {
  const ctx = buildGitHubApiContext();
  if (!ctx) return { success: false, error: 'GitHub token not configured' };

  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/issues/${prInfo.pullNumber}/comments`,
      {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ body: comment }),
      },
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

// ─── Find Berean comments ─────────────────────────────────────────────────────

/**
 * Find existing Berean review comments on a GitHub PR (issue comments).
 */
export async function findGitHubBereanComments(prInfo: GitHubPRInfo): Promise<BereanComment[]> {
  const ctx = buildGitHubApiContext();
  if (!ctx) return [];

  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/issues/${prInfo.pullNumber}/comments?per_page=100`,
      { headers: ctx.headers },
    );

    if (!res.ok) return [];

    const comments = await res.json() as Array<{
      id: number;
      body: string;
      created_at: string;
    }>;

    const bereanComments: BereanComment[] = [];

    for (const comment of comments) {
      if (
        comment.body?.includes(BEREAN_TAG) ||
        comment.body?.includes('Generated by [Berean]') ||
        comment.body?.includes('Generated by Berean')
      ) {
        bereanComments.push({
          threadId: comment.id,
          commentId: comment.id,
          content: comment.body,
          createdDate: comment.created_at,
          reviewedCommits: extractReviewedCommits(comment.body),
          reviewedIterationId: extractReviewedIteration(comment.body),
        });
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

// ─── Get PR commits ───────────────────────────────────────────────────────────

/**
 * Get all commit SHAs for a GitHub PR.
 */
export async function getGitHubPRCommits(prInfo: GitHubPRInfo): Promise<string[]> {
  const ctx = buildGitHubApiContext();
  if (!ctx) return [];

  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/pulls/${prInfo.pullNumber}/commits?per_page=100`,
      { headers: ctx.headers },
    );

    if (!res.ok) return [];

    const commits = await res.json() as Array<{ sha: string }>;
    return commits.map(c => c.sha);
  } catch {
    return [];
  }
}

// ─── Update PR comment ───────────────────────────────────────────────────────

/**
 * Update an existing issue comment on a GitHub PR.
 */
export async function updateGitHubPRComment(
  prInfo: GitHubPRInfo,
  commentId: number,
  newContent: string,
): Promise<PostCommentResult> {
  const ctx = buildGitHubApiContext();
  if (!ctx) return { success: false, error: 'GitHub token not configured' };

  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/issues/comments/${commentId}`,
      {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ body: newContent }),
      },
    );

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({})) as { message?: string };
      return { success: false, error: errorData.message ?? `HTTP ${res.status}` };
    }

    return { success: true, threadId: commentId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ─── Inline comments ──────────────────────────────────────────────────────────

/**
 * Post multiple inline (review) comments on a GitHub PR.
 *
 * Uses the "create a review comment" endpoint which attaches comments to
 * specific lines in the diff.  Deduplicates against existing review comments.
 */
export async function postGitHubInlineComments(
  prInfo: GitHubPRInfo,
  comments: InlineComment[],
): Promise<{ success: number; failed: number; errors: string[] }> {
  const ctx = buildGitHubApiContext();
  if (!ctx) {
    return {
      success: 0,
      failed: comments.length,
      errors: ['GitHub token not configured'],
    };
  }

  // 1. Get the head SHA (required for commit_id)
  const prRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/pulls/${prInfo.pullNumber}`,
    { headers: ctx.headers },
  ).catch(() => null);

  let headSha = '';
  if (prRes?.ok) {
    const prData = await prRes.json() as { head: { sha: string } };
    headSha = prData.head.sha;
  }

  if (!headSha) {
    return {
      success: 0,
      failed: comments.length,
      errors: ['Could not determine PR head SHA'],
    };
  }

  // 2. Fetch existing review comments for deduplication
  const existingKeys = new Set<string>();
  const reviewCommentsRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/pulls/${prInfo.pullNumber}/comments?per_page=100`,
    { headers: ctx.headers },
  ).catch(() => null);

  if (reviewCommentsRes?.ok) {
    const existingComments = await reviewCommentsRes.json() as Array<{
      path: string;
      line?: number;
    }>;
    for (const c of existingComments) {
      if (c.path && c.line) existingKeys.add(`${c.path}:${c.line}`);
    }
  }

  // 3. Post comments, skipping duplicates
  const results = { success: 0, failed: 0, errors: [] as string[] };

  for (const comment of comments) {
    // Normalise file path — GitHub expects paths without leading slash
    const filePath = comment.filePath.startsWith('/') ? comment.filePath.slice(1) : comment.filePath;
    const key = `${filePath}:${comment.line}`;

    if (existingKeys.has(key)) {
      results.success++;
      continue;
    }

    try {
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(prInfo.owner)}/${encodeURIComponent(prInfo.repo)}/pulls/${prInfo.pullNumber}/comments`,
        {
          method: 'POST',
          headers: ctx.headers,
          body: JSON.stringify({
            body: comment.content,
            commit_id: headSha,
            path: filePath,
            line: comment.line,
            side: 'RIGHT',
          }),
        },
      );

      if (res.ok) {
        results.success++;
        existingKeys.add(key);
      } else {
        const errorData = await res.json().catch(() => ({})) as { message?: string };
        results.failed++;
        results.errors.push(`${filePath}:${comment.line} - ${errorData.message ?? `HTTP ${res.status}`}`);
      }
    } catch (error) {
      results.failed++;
      results.errors.push(`${filePath}:${comment.line} - ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return results;
}
