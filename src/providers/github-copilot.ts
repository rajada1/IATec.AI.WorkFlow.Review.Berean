import { CopilotClient } from '@github/copilot-sdk';
import { getGitHubTokenFromAzure } from '../services/credentials.js';
import { chatCompletion } from './copilot-http.js';

export interface ReviewIssue {
  severity: 'critical' | 'warning' | 'suggestion';
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  success: boolean;
  review?: string;
  summary?: string;
  issues?: ReviewIssue[];
  positives?: string[];
  recommendations?: string[];
  error?: string;
  model?: string;
}

export interface ReviewOptions {
  model?: string;
  language?: string;
  maxTokens?: number;
  rules?: string;
  /** Raw content of the MEMORY.md index, used for Phase 1 context discovery */
  memoryIndex?: string;
  /** Topic file contents resolved from Phase 1, keyed by topic label */
  topicFiles?: Record<string, string>;
}

// ─── Verbose logger ───────────────────────────────────────────────────────────

function log(msg: string): void {
  if (process.env.BEREAN_VERBOSE) {
    console.error(msg);
  }
}

// ─── Client singleton ─────────────────────────────────────────────────────────

let _client: CopilotClient | null = null;

async function getClient(): Promise<CopilotClient> {
  if (_client) return _client;

  const token = getGitHubTokenFromAzure();

  const options: Record<string, unknown> = {};
  if (token) {
    options.githubToken = token;
    options.useLoggedInUser = false;
  }
  // If no token, SDK will try: env vars (COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN) → stored CLI credentials → gh auth

  _client = new CopilotClient(options);
  return _client;
}

export async function stopClient(): Promise<void> {
  if (_client) {
    await _client.stop();
    _client = null;
  }
}

// ─── Review ───────────────────────────────────────────────────────────────────

export async function reviewCode(diff: string, options: ReviewOptions = {}): Promise<ReviewResult> {
  const { model = 'gpt-4o', language = 'English', rules, topicFiles } = options;

  try {
    const client = await getClient();

    const systemPrompt = buildReviewPrompt(language, rules, topicFiles);
    const prompt = `${systemPrompt}\n\n---\n\nHere is the code diff to review:\n\n${diff}`;

    log(`[berean] Token source: ${getGitHubTokenFromAzure() ? 'env var' : 'SDK default'}`);
    log(`[berean] Node version: ${process.version}`);
    log(`[berean] Prompt size: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);

    // Quick connectivity test via SDK (30s) — if it fails, go straight to HTTP
    log(`[berean] Starting client...`);
    await client.start();
    log(`[berean] Client started, testing SDK connectivity...`);

    let sdkWorks = false;
    const testSession = await client.createSession({ model, streaming: false });
    try {
      const testResponse = await testSession.sendAndWait({ prompt: 'Reply with just: OK' }, 30_000);
      const testContent = testResponse?.data?.content ?? '';
      if (testContent) {
        sdkWorks = true;
        log(`[berean] ✓ SDK works (test response: ${testContent.substring(0, 20)})`);
      }
    } catch (testErr) {
      log(`[berean] ✗ SDK failed: ${testErr instanceof Error ? testErr.message : testErr}`);
    }

    let content = '';
    const TIMEOUT_MS = 300_000; // 5 min

    if (sdkWorks) {
      log(`[berean] Using SDK for review...`);
      const session = await client.createSession({ model, streaming: false });

      content = await new Promise<string>((resolve, reject) => {
        let result = '';
        let gotMessage = false;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;

        const timeoutId = setTimeout(() => {
          unsubscribe();
          if (gotMessage && result) {
            log(`[berean] Timeout reached but got response, using it`);
            resolve(result);
          } else {
            reject(new Error(`No response received after ${TIMEOUT_MS / 1000}s`));
          }
        }, TIMEOUT_MS);

        const settle = () => {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            if (result) {
              clearTimeout(timeoutId);
              unsubscribe();
              log(`[berean] Response settled (no new events for 5s)`);
              resolve(result);
            }
          }, 5_000);
        };

        const unsubscribe = session.on((event: Record<string, unknown>) => {
          const eventType = event.type as string;
          log(`[berean] Event: ${eventType}`);

          if (eventType === 'assistant.message') {
            const data = event.data as Record<string, unknown>;
            result = (data?.content as string) ?? result;
            gotMessage = true;
            settle();
          } else if (eventType === 'session.idle') {
            if (settleTimer) clearTimeout(settleTimer);
            clearTimeout(timeoutId);
            unsubscribe();
            log(`[berean] session.idle received`);
            resolve(result);
          } else if (eventType === 'session.error') {
            if (settleTimer) clearTimeout(settleTimer);
            clearTimeout(timeoutId);
            unsubscribe();
            const data = event.data as Record<string, string>;
            reject(new Error(data?.message ?? 'Session error'));
          } else {
            if (gotMessage) settle();
          }
        });

        log(`[berean] Sending prompt (${prompt.length} chars)...`);
        session.send({ prompt }).catch((e: Error) => {
          if (settleTimer) clearTimeout(settleTimer);
          clearTimeout(timeoutId);
          unsubscribe();
          reject(e);
        });
      });
    } else {
      // SDK doesn't work — use direct HTTP API
      const token = getGitHubTokenFromAzure();
      if (!token) {
        return { success: false, error: 'No GitHub token available for HTTP fallback', model };
      }
      log(`[berean] Using direct HTTP API for review...`);
      content = await chatCompletion(token, model, prompt, TIMEOUT_MS);
    }

    if (!content) {
      // SDK returned empty — try direct HTTP as fallback
      const token = getGitHubTokenFromAzure();
      if (token) {
        log(`[berean] SDK returned empty, trying direct HTTP API...`);
        content = await chatCompletion(token, model, prompt, TIMEOUT_MS);
      }
    }

    if (!content) {
      return { success: false, error: 'Empty response from API', model };
    }

    return parseReviewResponse(content, model);
  } catch (error) {
    // If SDK fails completely, try direct HTTP fallback
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    const token = getGitHubTokenFromAzure();

    if (
      token &&
      (errMsg.includes('Timeout') || errMsg.includes('No response') || errMsg.includes('session.idle'))
    ) {
      log(`[berean] SDK failed (${errMsg}), falling back to direct HTTP API...`);
      try {
        const systemPromptFallback = buildReviewPrompt(options.language ?? 'English', options.rules, options.topicFiles);
        const promptFallback = `${systemPromptFallback}\n\n---\n\nHere is the code diff to review:\n\n${diff}`;
        const content = await chatCompletion(token, model, promptFallback, 300_000);
        if (content) return parseReviewResponse(content, model);
      } catch (httpError) {
        log(`[berean] HTTP fallback also failed: ${httpError instanceof Error ? httpError.message : httpError}`);
      }
    }

    return { success: false, error: errMsg, model };
  }
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseReviewResponse(content: string, model: string): ReviewResult {
  try {
    let jsonContent = content;

    // Extract JSON if wrapped in markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonContent = jsonMatch[1].trim();
    }

    let parsed: {
      summary?: string;
      issues?: ReviewResult['issues'];
      positives?: string[];
      recommendations?: string[];
    } | null = null;

    try {
      parsed = JSON.parse(jsonContent);
    } catch {
      // Try to fix truncated JSON
      let fixedJson = jsonContent;

      const openBraces = (fixedJson.match(/{/g) ?? []).length;
      const closeBraces = (fixedJson.match(/}/g) ?? []).length;
      const openBrackets = (fixedJson.match(/\[/g) ?? []).length;
      const closeBrackets = (fixedJson.match(/\]/g) ?? []).length;

      fixedJson = fixedJson.replace(/,\s*"[^"]*$/, '');
      fixedJson = fixedJson.replace(/,\s*$/, '');
      fixedJson = fixedJson.replace(/:\s*"[^"]*$/, ': ""');

      for (let i = 0; i < openBrackets - closeBrackets; i++) fixedJson += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) fixedJson += '}';

      try {
        parsed = JSON.parse(fixedJson);
      } catch {
        // Still failed — return raw
      }
    }

    if (parsed) {
      return {
        success: true,
        summary: parsed.summary,
        issues: parsed.issues,
        positives: parsed.positives,
        recommendations: parsed.recommendations,
        review: content,
        model,
      };
    }

    return { success: true, review: content, model };
  } catch {
    return { success: true, review: content, model };
  }
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildReviewPrompt(language: string, rules?: string, topicFiles?: Record<string, string>): string {
  let prompt = `You are an expert code reviewer. Analyze the provided code changes (git diff) and provide a comprehensive review.

You MUST respond with ONLY a valid JSON object (no markdown, no code blocks, no extra text). The JSON must contain:

{
  "summary": "Brief summary of what the changes do (2-3 sentences)",
  "issues": [
    {
      "severity": "critical|warning|suggestion",
      "file": "/path/to/file.ts",
      "line": 42,
      "message": "Description of the issue and how to fix it",
      "suggestion": "Optional: corrected code snippet if applicable"
    }
  ],
  "positives": ["List of good practices observed"],
  "recommendations": ["General recommendations for improvement"]
}

CRITICAL RULES:
1. Response must be ONLY the JSON object - no markdown, no \`\`\`json blocks, just raw JSON
2. "file" must be the EXACT file path as shown in the diff (e.g., "/src/services/api.ts")
3. "line" must be a specific line number from the NEW version of the file
4. "issues" array can be empty [] if there are no problems
5. All text content must be in ${language}

Severity levels:
- critical: Security vulnerabilities, bugs that will cause crashes, data loss
- warning: Code smells, potential bugs, performance issues
- suggestion: Style improvements, refactoring opportunities

Be specific and actionable. If the code is good, return empty issues array and list positives.`;

  if (rules) {
    prompt += `\n\n---\n\nPROJECT-SPECIFIC RULES AND GUIDELINES (use these to evaluate the code):\n\n${rules}`;
  }

  if (topicFiles && Object.keys(topicFiles).length > 0) {
    const sections = Object.entries(topicFiles)
      .map(([topic, content]) => `### ${topic}\n\n${content}`)
      .join('\n\n---\n\n');
    prompt += `\n\n---\n\n## Project Context (from memory)\n\nThe following topic files were identified as relevant to this review:\n\n${sections}`;
  }

  return prompt;
}

// ─── Context discovery (Phase 1) ──────────────────────────────────────────────

/**
 * Phase 1 of the two-phase agentic review.
 *
 * Sends the diff + MEMORY.md index to the model and asks it to identify
 * which topic files are most relevant to review.  Returns a list of relative
 * paths (as listed in MEMORY.md) to load for Phase 2.
 *
 * Uses the HTTP path exclusively (fast 30 s call).  On any failure returns [].
 */
export async function discoverNeededContext(
  diff: string,
  memoryIndex: string,
  model: string,
): Promise<string[]> {
  const token = getGitHubTokenFromAzure();
  if (!token) return [];

  const prompt = `You are helping prepare a code review. Below is:
1. A MEMORY.md index listing project documentation files
2. A code diff to be reviewed

Based on the diff, identify which topic files from the MEMORY.md index would provide the most useful context for a thorough code review.

Respond with ONLY a valid JSON object — no markdown, no explanation.
Format: { "needed_files": ["relative/path1.md", "relative/path2.md"] }
Return at most 5 files. If no files are relevant, return: { "needed_files": [] }

MEMORY.md INDEX:
${memoryIndex.substring(0, 3_000)}

CODE DIFF (excerpt):
${diff.substring(0, 2_000)}`;

  try {
    const content = await chatCompletion(token, model, prompt, 30_000);
    if (!content) return [];

    // Extract JSON object from response
    const match = content.match(/\{[\s\S]*?\}/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'needed_files' in parsed &&
      Array.isArray((parsed as Record<string, unknown>).needed_files)
    ) {
      return ((parsed as { needed_files: unknown[] }).needed_files)
        .filter((f): f is string => typeof f === 'string')
        .slice(0, 5);
    }
  } catch (e) {
    log(`[berean] discoverNeededContext failed: ${e instanceof Error ? e.message : e}`);
  }

  return [];
}

// ─── Rule query generation ────────────────────────────────────────────────────

/**
 * Ask the LLM to generate search queries relevant to the provided diff.
 * Used by dynamic URL rule sources (those with a {{query}} placeholder).
 *
 * Tries HTTP first (if a GitHub token is available), falls back to the SDK.
 * Returns up to 5 concise search queries, or [] on failure.
 */
export async function generateRuleQueries(diff: string, model: string): Promise<string[]> {
  const prompt = `Analyze the following code diff and generate 3 to 5 concise search queries to find the most relevant coding guidelines, architectural rules, or best practices that should be applied during code review.

Focus on:
- Technologies, frameworks, and libraries visible in the code
- Design patterns and architectural decisions
- Potential concern areas (security, performance, error handling, naming conventions)

Respond with ONLY a valid JSON array of strings — no markdown, no explanation, just the array.
Example: ["query about topic A", "query about topic B", "query about topic C"]

CODE DIFF (excerpt):
${diff.substring(0, 2_000)}`;

  let content = '';

  // Try HTTP first — lighter and faster
  const token = getGitHubTokenFromAzure();
  if (token) {
    try {
      content = await chatCompletion(token, model, prompt, 30_000);
    } catch (e) {
      log(`[berean] generateRuleQueries HTTP failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // SDK fallback
  if (!content) {
    try {
      const client = await getClient();
      await client.start();
      const session = await client.createSession({ model, streaming: false });
      const response = await session.sendAndWait({ prompt }, 30_000);
      content = (response?.data?.content as string) ?? '';
    } catch (e) {
      log(`[berean] generateRuleQueries SDK failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  if (!content) return [];

  try {
    // Extract the first JSON array from the response
    const match = content.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as unknown;
      return Array.isArray(parsed)
        ? (parsed as unknown[]).filter(q => typeof q === 'string').slice(0, 5) as string[]
        : [];
    }
  } catch {
    log(`[berean] generateRuleQueries failed to parse response: ${content.substring(0, 100)}`);
  }

  return [];
}

// ─── Model listing ────────────────────────────────────────────────────────────

export interface ModelDetail {
  id: string;
  name: string;
  isDefault: boolean;
  isPremium?: boolean;
  multiplier?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsToolCalls?: boolean;
  supportsStreaming?: boolean;
  supportsReasoning?: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  policyState?: string;
}

export async function fetchModels(): Promise<ModelDetail[]> {
  try {
    const client = await getClient();
    await client.start();
    const models = await client.listModels();

    return models.map(m => {
      const caps = m.capabilities as unknown as Record<string, unknown>;
      const limits = (caps?.limits ?? {}) as Record<string, unknown>;
      const supports = (caps?.supports ?? {}) as Record<string, unknown>;
      const billing = (m.billing ?? {}) as unknown as Record<string, unknown>;

      return {
        id: m.id,
        name: m.name,
        isDefault: m.id === 'gpt-4o',
        isPremium: (billing.is_premium as boolean) ?? false,
        multiplier: m.billing?.multiplier ?? 0,
        maxContextTokens: limits.max_context_window_tokens as number | undefined,
        maxOutputTokens: limits.max_output_tokens as number | undefined,
        supportsVision: m.capabilities?.supports?.vision ?? false,
        supportsToolCalls: (supports.tool_calls as boolean) ?? false,
        supportsStreaming: (supports.streaming as boolean) ?? false,
        supportsReasoning: m.capabilities?.supports?.reasoningEffort ?? false,
        reasoningEfforts: m.supportedReasoningEfforts as string[] | undefined,
        defaultReasoningEffort: m.defaultReasoningEffort as string | undefined,
        policyState: m.policy?.state,
      };
    });
  } catch {
    return FALLBACK_MODELS;
  }
}

const FALLBACK_MODELS: ModelDetail[] = [
  { id: 'gpt-4o', name: 'GPT-4o', isDefault: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', isDefault: false },
  { id: 'gpt-4.1', name: 'GPT-4.1', isDefault: false },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', isDefault: false },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', isDefault: false },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', isDefault: false },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', isDefault: false },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)', isDefault: false },
  { id: 'o3-mini', name: 'o3-mini', isDefault: false },
];
