import { BEREAN_USER_AGENT, getGitHubTokenFromAzureSource, normalizeGitHubToken, tokenLooksPrefixed } from '../services/credentials.js';

/**
 * Direct HTTP provider for GitHub Copilot API.
 *
 * Mirrors the real flow used by the official `@github/copilot` CLI
 * (v1.0.35, function `ox()` in `node_modules/@github/copilot/app.js`):
 *
 *   1. Validate the token by calling
 *        GET https://api.github.com/copilot_internal/user
 *      with  `Authorization: Bearer <token>`  and  `Accept: application/json`.
 *      The response contains the user's Copilot plan and the per-user
 *      Copilot API endpoint (`endpoints.api`, typically
 *      `https://api.githubcopilot.com`).
 *
 *   2. Call the Copilot chat-completions endpoint directly using the *same*
 *      GitHub token as a `Bearer`. There is **no** ephemeral-token exchange
 *      step — the PAT / OAuth token is the credential.
 *
 * Accepted token prefixes (same as the CLI):
 *   - `github_pat_` — fine-grained PAT with the "Copilot Chat" / "Copilot
 *     Requests" permission
 *   - `gho_`, `ghu_` — OAuth tokens from `gh auth` / `copilot login`
 *   - `ghs_`         — server-to-server tokens
 *
 * Rejected: `ghp_` (classic PAT) — the CLI explicitly refuses these and so
 * do we.
 *
 * The old `POST /copilot_internal/v2/token` endpoint (the "token exchange"
 * path from the legacy `copilot.vim` / early VS Code Copilot extensions) is
 * NOT used here — it does not accept fine-grained PATs and returns a
 * permanent 403 "Resource not accessible by personal access token".
 */

// ─── Verbose logger ───────────────────────────────────────────────────────────

function log(msg: string): void {
  if (process.env.BEREAN_VERBOSE) {
    console.error(msg);
  }
}

// ─── Copilot chat headers (mirrors the official @github/copilot CLI) ──────────
//
// Reverse-engineered from `node_modules/@github/copilot/app.js`:
//
//   • app.js:49719,49723 (class jM, baseHeaders + defaultHeaders())
//       Content-Type, Accept, Openai-Intent, X-Initiator, X-GitHub-Api-Version
//   • app.js:61715
//       M4 = "copilot-developer-cli"   (the integration ID the CLI declares)
//
// Why this matters: the Copilot gateway correlates `Copilot-Integration-Id`
// with the kind of credential it accepts. Declaring `vscode-chat` (the
// VS Code extension's id) makes the gateway require a short-lived OAuth
// token from the extension's flow, and reject fine-grained PATs with
// "Personal Access Tokens are not supported for this endpoint".
// Declaring `copilot-developer-cli` instead — the official CLI's id —
// makes the gateway accept `gho_`, `ghu_`, `ghs_` AND `github_pat_`
// (provided the PAT has the "Copilot Chat" / "Copilot Requests" permission).
const COPILOT_INTEGRATION_ID = 'copilot-developer-cli';
const COPILOT_API_VERSION = '2026-01-09';

function copilotChatHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
    'Openai-Intent': 'conversation-agent',
    'X-Initiator': 'user',
    'X-GitHub-Api-Version': COPILOT_API_VERSION,
    // User-Agent mirrors the official @github/copilot CLI's `ene()` format
    // (app.js:5611). See `BEREAN_USER_AGENT` in services/credentials.ts.
    'User-Agent': BEREAN_USER_AGENT,
  };
}

// ─── Token validation (GET /copilot_internal/user) ────────────────────────────

/**
 * Shape of the most relevant fields returned by
 * `GET https://api.github.com/copilot_internal/user`. The full response has
 * many more fields; we only type what we use.
 */
interface CopilotUser {
  login?: string;
  copilot_plan?: string;
  chat_enabled?: boolean;
  endpoints?: {
    api?: string;
    telemetry?: string;
  };
}

export interface CopilotTokenExchangeResult {
  ok: boolean;
  status: number;
  statusText: string;
  tokenSource: string;
  responseBody: string;
  responseHeaders: Record<string, string>;
  /** User login returned by `/copilot_internal/user` when validation succeeds. */
  login?: string;
  /** Copilot plan (e.g. `individual`, `business`) when available. */
  copilotPlan?: string;
  /** Per-user Copilot API host, e.g. `https://api.githubcopilot.com`. */
  copilotApiUrl?: string;
  normalizedTokenLength: number;
  hadPrefix: boolean;
}

function pickRelevantHeaders(headers: Headers): Record<string, string> {
  const keys = [
    'content-type',
    'www-authenticate',
    'x-github-request-id',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-ratelimit-resource',
    'x-ratelimit-used',
  ];

  const picked: Record<string, string> = {};
  for (const key of keys) {
    const value = headers.get(key);
    if (value) picked[key] = value;
  }

  return picked;
}

/**
 * Validate a GitHub token against the Copilot "who am I" endpoint the
 * official CLI uses. On success, the response includes the Copilot plan
 * and the per-user `endpoints.api` host to call for chat completions.
 *
 * The function name is kept as `exchangeCopilotToken` for backwards-
 * compatibility with callers (e.g. `berean auth test`), even though there
 * is no longer a token exchange — validation is all we do.
 */
export async function exchangeCopilotToken(githubToken: string): Promise<CopilotTokenExchangeResult> {
  const normalizedToken = normalizeGitHubToken(githubToken);
  const tokenSource = getGitHubTokenFromAzureSource() ?? 'explicit';

  const response = await fetch('https://api.github.com/copilot_internal/user', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
      Accept: 'application/json',
      'User-Agent': BEREAN_USER_AGENT,
    },
  });

  const responseBody = await response.text();
  const result: CopilotTokenExchangeResult = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    tokenSource,
    responseBody,
    responseHeaders: pickRelevantHeaders(response.headers),
    normalizedTokenLength: normalizedToken.length,
    hadPrefix: tokenLooksPrefixed(githubToken),
  };

  if (response.ok) {
    try {
      const data = JSON.parse(responseBody) as CopilotUser;
      result.login = data.login;
      result.copilotPlan = data.copilot_plan;
      result.copilotApiUrl = data.endpoints?.api;
    } catch {
      // Keep raw responseBody only.
    }
  }

  return result;
}

// ─── Copilot API URL resolution (cached) ──────────────────────────────────────

let cachedCopilotApiUrl: string | null = null;

/**
 * Resolve the per-user Copilot API URL by validating the token against
 * `/copilot_internal/user`. Cached for the lifetime of the process because
 * this endpoint is effectively static per user (and the CLI caches it too).
 *
 * On failure, provides rich, actionable error messages for the common
 * failure modes (401, 403-PAT, 404-no-seat).
 */
async function resolveCopilotApiUrl(githubToken: string): Promise<string> {
  if (cachedCopilotApiUrl) {
    return cachedCopilotApiUrl;
  }

  const tokenSource = getGitHubTokenFromAzureSource() ?? 'unknown';
  const normalizedToken = normalizeGitHubToken(githubToken);
  log(`[berean-http] Validating GitHub token against /copilot_internal/user (source: ${tokenSource}, length: ${normalizedToken.length})...`);

  const result = await exchangeCopilotToken(githubToken);

  if (result.ok && result.copilotApiUrl) {
    cachedCopilotApiUrl = result.copilotApiUrl;
    log(`[berean-http] Copilot API URL resolved: ${cachedCopilotApiUrl} (user: ${result.login ?? 'unknown'}, plan: ${result.copilotPlan ?? 'unknown'})`);
    return cachedCopilotApiUrl;
  }

  const body = result.responseBody;

  if (result.status === 401) {
    throw new Error(`Token validation failed (401): GitHub rejected the token. ${body}`);
  }

  if (result.status === 403) {
    throw new Error(`Token validation failed (403): access denied. ${body}`);
  }

  if (result.status === 404) {
    throw new Error(`Token validation failed (404): no active Copilot seat found. ${body}`);
  }

  // 200 OK but no endpoints.api — unexpected response shape
  if (result.ok) {
    throw new Error(
      'Token validation succeeded but the /copilot_internal/user response did not include endpoints.api. '
      + 'This is unexpected — the GitHub API may have changed. '
      + `Response body: ${body}`,
    );
  }

  // Other non-OK statuses (5xx, etc.) — surface as generic failure
  throw new Error(`Token validation failed (${result.status}): ${body}`);
}

// ─── Chat completions ─────────────────────────────────────────────────────────

/**
 * Call Copilot Chat Completions API directly via HTTP.
 *
 * The GitHub token itself is used as `Authorization: Bearer <token>` — the
 * same way the official CLI does it. There is no separate token exchange;
 * the per-user API host is discovered from `/copilot_internal/user`.
 *
 * @param githubToken GitHub PAT / OAuth token (gho_, ghu_, github_pat_, ghs_).
 * @param model Copilot model identifier.
 * @param systemPrompt System prompt content.
 * @param userPrompt User prompt content.
 * @param timeoutMs Timeout in milliseconds.
 */
export async function chatCompletion(
  githubToken: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number = 300_000,
): Promise<string> {
  const normalizedToken = normalizeGitHubToken(githubToken);
  const apiBase = await resolveCopilotApiUrl(githubToken);
  const url = `${apiBase.replace(/\/+$/, '')}/chat/completions`;

  log(`[berean-http] Sending chat completion request (url: ${url}, model: ${model}, system: ${systemPrompt.length} chars, user: ${userPrompt.length} chars)...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: copilotChatHeaders(normalizedToken),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Copilot API error (${response.status}): ${body}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data?.choices?.[0]?.message?.content ?? '';
    log(`[berean-http] Response received (${content.length} chars)`);
    return content;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Copilot API timeout after ${timeoutMs / 1000}s`);
    }
    throw error;
  }
}
