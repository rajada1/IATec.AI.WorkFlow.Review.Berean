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
 * Exchange GitHub PAT for a Copilot API token (cached with 60s expiry buffer)
 */
async function getCopilotToken(githubToken: string): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now() / 1000 + 60) {
    return cachedToken.token;
  }

  log(`[berean-http] Exchanging GitHub token for Copilot token...`);

  const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/json',
      'User-Agent': 'berean-cli/0.2.0',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 403 && body.includes('Resource not accessible by personal access token')) {
      throw new Error(
        'Token exchange failed (403): the configured GitHub token is a personal access token, and this Copilot endpoint does not accept PATs. Remove GITHUB_TOKEN/GH_TOKEN/COPILOT_GITHUB_TOKEN and authenticate with `berean auth login`, or provide a GitHub token type that is allowed to exchange for a Copilot token.',
      );
    }
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const data = await response.json() as CopilotToken;
  cachedToken = data;
  log(`[berean-http] Copilot token obtained (expires: ${new Date(data.expires_at * 1000).toISOString()})`);
  return data.token;
}

// ─── Chat completions ─────────────────────────────────────────────────────────

/**
 * Call Copilot Chat Completions API directly via HTTP
 *
 * @param githubToken GitHub PAT used to exchange for a Copilot token.
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
  const copilotToken = await getCopilotToken(githubToken);

  log(`[berean-http] Sending chat completion request (model: ${model}, system: ${systemPrompt.length} chars, user: ${userPrompt.length} chars)...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.individual.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'berean-cli/0.2.0',
        'Editor-Version': 'berean/0.2.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
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
