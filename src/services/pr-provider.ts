import {
  parsePRUrl as parseAzurePRUrl,
  fetchPRBasicInfo as fetchAzurePRBasicInfo,
  fetchPRDiff as fetchAzurePRDiff,
  postPRComment as postAzurePRComment,
  postInlineComments as postAzureInlineComments,
  findBereanComments as findAzureBereanComments,
  getPRCommits as getAzurePRCommits,
  updatePRComment as updateAzurePRComment,
  type PRInfo as AzurePRInfo,
  type PRBasicInfoResult,
  type PRDiffResult,
  type PostCommentResult,
  type BereanComment,
  type InlineComment,
  type FetchDiffOptions,
} from './azure-devops.js';

import {
  parseGitHubPRUrl,
  fetchGitHubPRBasicInfo,
  fetchGitHubPRDiff,
  postGitHubPRComment,
  postGitHubInlineComments,
  findGitHubBereanComments,
  getGitHubPRCommits,
  updateGitHubPRComment,
  type GitHubPRInfo,
} from './github.js';

import { getAzureDevOpsPATFromPipeline, getGitHubToken } from './credentials.js';

// Re-export platform-independent utilities
export { shouldIgnorePR, addReviewedCommitsTag, addReviewedIterationTag } from './azure-devops.js';

// Re-export shared types for consumers
export type { PRBasicInfoResult, PRDiffResult, PostCommentResult, BereanComment, InlineComment, FetchDiffOptions };

// ─── Provider interface ───────────────────────────────────────────────────────

export interface PRProvider {
  platform: 'azure-devops' | 'github';

  fetchPRBasicInfo(): Promise<PRBasicInfoResult>;
  fetchPRDiff(options?: FetchDiffOptions): Promise<PRDiffResult>;
  postPRComment(comment: string): Promise<PostCommentResult>;
  postInlineComments(comments: InlineComment[]): Promise<{ success: number; failed: number; errors: string[] }>;
  findBereanComments(): Promise<BereanComment[]>;
  getPRCommits(): Promise<string[]>;
  updatePRComment(threadId: number, commentId: number, newContent: string): Promise<PostCommentResult>;
}

// ─── Factory: create provider from a URL ──────────────────────────────────────

export interface CreateProviderResult {
  provider?: PRProvider;
  error?: string;
}

/**
 * Detect the platform from a PR URL and return the corresponding provider.
 *
 * Supported URL formats:
 *   GitHub:      https://github.com/{owner}/{repo}/pull/{number}
 *   Azure DevOps: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
 *                 https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id}
 */
export function createProviderFromUrl(url: string): CreateProviderResult {
  // Try GitHub
  const ghInfo = parseGitHubPRUrl(url);
  if (ghInfo) {
    if (!getGitHubToken()) {
      return {
        error: 'GitHub token not configured. Set GITHUB_TOKEN or GH_TOKEN environment variable.',
      };
    }
    return { provider: buildGitHubProvider(ghInfo) };
  }

  // Try Azure DevOps
  const azInfo = parseAzurePRUrl(url);
  if (azInfo) {
    if (!getAzureDevOpsPATFromPipeline()) {
      return {
        error:
          'Azure DevOps PAT not configured. Set AZURE_DEVOPS_PAT env var or run: berean config set azure-pat <token>',
      };
    }
    return { provider: buildAzureProvider(azInfo) };
  }

  return {
    error:
      'Invalid PR URL. Supported formats:\n' +
      '  GitHub:      https://github.com/{owner}/{repo}/pull/{number}\n' +
      '  Azure DevOps: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}',
  };
}

// ─── Factory: create provider from CLI flags ──────────────────────────────────

/**
 * Create a provider from explicit CLI flags.
 *
 * GitHub:      --owner + --repo + --pr
 * Azure DevOps: --org + --project + --repo + --pr
 */
export function createProviderFromFlags(flags: {
  org?: string;
  project?: string;
  repo?: string;
  pr?: string;
  owner?: string;
}): CreateProviderResult {
  // GitHub: --owner + --repo + --pr
  if (flags.owner && flags.repo && flags.pr) {
    if (!getGitHubToken()) {
      return {
        error: 'GitHub token not configured. Set GITHUB_TOKEN or GH_TOKEN environment variable.',
      };
    }
    return {
      provider: buildGitHubProvider({
        owner: flags.owner,
        repo: flags.repo,
        pullNumber: parseInt(flags.pr, 10),
      }),
    };
  }

  // Azure DevOps: --org + --project + --repo + --pr
  if (flags.org && flags.project && flags.repo && flags.pr) {
    if (!getAzureDevOpsPATFromPipeline()) {
      return {
        error:
          'Azure DevOps PAT not configured. Set AZURE_DEVOPS_PAT env var or run: berean config set azure-pat <token>',
      };
    }
    return {
      provider: buildAzureProvider({
        organization: flags.org,
        project: flags.project,
        repository: flags.repo,
        pullRequestId: parseInt(flags.pr, 10),
      }),
    };
  }

  return {
    error:
      'Please provide a PR URL or use flags:\n' +
      '  GitHub:      --owner, --repo, --pr\n' +
      '  Azure DevOps: --org, --project, --repo, --pr',
  };
}

// ─── Provider builders ────────────────────────────────────────────────────────

function buildGitHubProvider(info: GitHubPRInfo): PRProvider {
  return {
    platform: 'github',
    fetchPRBasicInfo: () => fetchGitHubPRBasicInfo(info),
    fetchPRDiff: (opts) => fetchGitHubPRDiff(info, opts),
    postPRComment: (c) => postGitHubPRComment(info, c),
    postInlineComments: (c) => postGitHubInlineComments(info, c),
    findBereanComments: () => findGitHubBereanComments(info),
    getPRCommits: () => getGitHubPRCommits(info),
    updatePRComment: (_threadId, c, content) => updateGitHubPRComment(info, c, content),
  };
}

function buildAzureProvider(info: AzurePRInfo): PRProvider {
  return {
    platform: 'azure-devops',
    fetchPRBasicInfo: () => fetchAzurePRBasicInfo(info),
    fetchPRDiff: (opts) => fetchAzurePRDiff(info, opts),
    postPRComment: (c) => postAzurePRComment(info, c),
    postInlineComments: (c) => postAzureInlineComments(info, c),
    findBereanComments: () => findAzureBereanComments(info),
    getPRCommits: () => getAzurePRCommits(info),
    updatePRComment: (t, c, content) => updateAzurePRComment(info, t, c, content),
  };
}
