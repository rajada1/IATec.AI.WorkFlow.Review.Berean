/**
 * Direct HTTP provider for GitHub Copilot API
 * Bypasses the SDK/CLI subprocess for environments where it doesn't work (CI/CD)
 *
 * Flow: GitHub PAT → Copilot token exchange → Chat Completions API
 */

// ─── Verbose logger ───────────────────────────────────────────────────────────

function log(msg: string): void {
  if (process.env.BEREAN_VERBOSE) {
    console.error(msg);
  }
}

// ─── Token management ─────────────────────────────────────────────────────────

interface CopilotToken {
  token: string;
  expires_at: number;
}

let cachedToken: CopilotToken | null = null;

/**
 * Exchange GitHub PAT for a Copilot API token (cached with 60s expiry buffer).
 *
 * Includes retry logic with exponential backoff for transient failures
 * (e.g. intermittent 403 responses from the GitHub API).
 */
async function getCopilotToken(githubToken: string): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now() / 1000 + 60) {
    return cachedToken.token;
  }

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1_000;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log(`[berean-http] Exchanging GitHub token for Copilot token (attempt ${attempt}/${MAX_RETRIES})...`);

    const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        Authorization: `token ${githubToken}`,
        Accept: 'application/json',
        'User-Agent': 'berean-cli/1.7.0',
      },
    });

    if (response.ok) {
      const data = await response.json() as CopilotToken;
      cachedToken = data;
      log(`[berean-http] Copilot token obtained (expires: ${new Date(data.expires_at * 1000).toISOString()})`);
      return data.token;
    }

    const body = await response.text();

    // Transient 403 or 5xx — retry after a delay
    if ((response.status === 403 || response.status >= 500) && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      log(`[berean-http] Token exchange returned ${response.status}, retrying in ${delay}ms...`);
      // Clear cached token so it won't be reused on next attempt
      cachedToken = null;
      await new Promise(resolve => setTimeout(resolve, delay));
      lastError = new Error(`Token exchange failed (${response.status}): ${body}`);
      continue;
    }

    // Final attempt or non-retryable status — throw
    if (response.status === 403 && body.includes('Resource not accessible by personal access token')) {
      throw new Error(
        'Token exchange failed (403): the configured GitHub token is a personal access token, and this Copilot endpoint does not accept PATs. Remove GITHUB_TOKEN/GH_TOKEN/COPILOT_GITHUB_TOKEN and authenticate with `berean auth login`, or provide a GitHub token type that is allowed to exchange for a Copilot token.',
      );
    }
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  throw lastError ?? new Error('Token exchange failed after retries');
}

// ─── Chat completions ─────────────────────────────────────────────────────────

/**
 * Call Copilot Chat Completions API via HTTP with SSE streaming.
 *
 * Uses an inactivity-based timeout: the timer resets on every received chunk,
 * so a slow but active model response will never be aborted prematurely.
 * A hard overall cap (maxTotalMs) ensures the request eventually terminates.
 *
 * @param githubToken GitHub PAT used to exchange for a Copilot token.
 * @param model Copilot model identifier.
 * @param systemPrompt System prompt content.
 * @param userPrompt User prompt content.
 * @param maxTotalMs Hard overall timeout in milliseconds (default 600 s).
 * @param inactivityMs Inactivity timeout — abort if no chunk arrives within
 *   this window (default 60 s).
 */
export async function chatCompletion(
  githubToken: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTotalMs: number = 600_000,
  inactivityMs: number = 60_000,
): Promise<string> {
  const copilotToken = await getCopilotToken(githubToken);

  log(`[berean-http] Sending streaming chat completion request (model: ${model}, system: ${systemPrompt.length} chars, user: ${userPrompt.length} chars)...`);

  const controller = new AbortController();
  let abortReason = 'overall timeout';

  // Hard overall timeout
  const overallTimer = setTimeout(() => {
    abortReason = 'overall timeout';
    log(`[berean-http] Hard overall timeout (${maxTotalMs / 1000}s) reached, aborting`);
    controller.abort();
  }, maxTotalMs);

  // Inactivity timer — reset on each received chunk
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  const resetInactivityTimer = (): void => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      abortReason = 'inactivity timeout';
      log(`[berean-http] Inactivity timeout (${inactivityMs / 1000}s) reached, aborting`);
      controller.abort();
    }, inactivityMs);
  };

  const clearTimers = (): void => {
    clearTimeout(overallTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
  };

  try {
    const response = await fetch('https://api.individual.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'berean-cli/1.7.0',
        'Editor-Version': 'berean/1.7.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimers();
      const body = await response.text();
      throw new Error(`Copilot API error (${response.status}): ${body}`);
    }

    if (!response.body) {
      clearTimers();
      throw new Error('Copilot API returned no response body');
    }

    // Start the inactivity timer once we have the response headers
    resetInactivityTimer();

    // Parse the SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let contentBuffer = '';
    let sseBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Reset inactivity timer on every received chunk
        resetInactivityTimer();

        sseBuffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = sseBuffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            log(`[berean-http] Stream complete (${contentBuffer.length} chars)`);
            clearTimers();
            return contentBuffer;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const chunk = parsed?.choices?.[0]?.delta?.content ?? '';
            if (chunk) {
              contentBuffer += chunk;
            }
          } catch {
            // Log malformed SSE lines at verbose level to aid troubleshooting
            log(`[berean-http] Failed to parse SSE data: ${data.substring(0, 100)}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    clearTimers();
    log(`[berean-http] Stream ended (${contentBuffer.length} chars)`);
    return contentBuffer;
  } catch (error) {
    clearTimers();
    if (error instanceof Error && error.name === 'AbortError') {
      if (abortReason === 'inactivity timeout') {
        throw new Error(`Copilot API aborted: no data received for ${inactivityMs / 1000}s (inactivity timeout)`);
      }
      throw new Error(`Copilot API aborted: hard overall timeout of ${maxTotalMs / 1000}s exceeded`);
    }
    throw error;
  }
}
