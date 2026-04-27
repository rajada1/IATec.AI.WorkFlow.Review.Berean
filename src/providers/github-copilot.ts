import { CopilotClient, type PermissionHandler } from '@github/copilot-sdk';
import { getGitHubTokenFromAzure } from '../services/credentials.js';
import { isNonInteractiveEnvironment } from '../services/copilot-auth.js';
import { chatCompletion } from './copilot-http.js';

// `approveAll` era exportado por versões anteriores do @github/copilot-sdk
// (<= 0.1.x antigo) como um PermissionHandler pronto que aprovava todas as
// solicitações de permissão vindas do agente. A versão atualmente instalada
// (0.1.25) não exporta mais esse helper, mas mantém o contrato de
// PermissionHandler retornando { kind: "approved" }. Reimplementamos aqui
// localmente para preservar o comportamento original (auto-aprovar tool calls).
const approveAll: PermissionHandler = () => ({ kind: 'approved' });

export interface ReviewIssue {
  severity: 'critical' | 'warning' | 'suggestion';
  category: 'security' | 'bug' | 'performance' | 'error-handling' | 'maintainability' | 'data-integrity' | 'concurrency' | 'resource-leak';
  confidence: number; // 0-100
  file?: string;
  line?: number;
  title: string;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  success: boolean;
  review?: string;
  summary?: string;
  recommendation?: 'APPROVE' | 'APPROVE_WITH_SUGGESTIONS' | 'NEEDS_CHANGES' | 'NEEDS_DISCUSSION';
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
  rules?: string; // Custom rules/guidelines content to include in the prompt
  confidenceThreshold?: number; // default 75
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
  const { model = 'gpt-4o', language = 'English', rules } = options;
  const confidenceThreshold = options.confidenceThreshold ?? 75;
  const reviewScope = extractReviewScope(diff);

  try {
    const token = getGitHubTokenFromAzure();
    const { system, user } = buildReviewPrompt(language, diff, rules);
    const promptSize = system.length + user.length;

    log(`[berean] Token source: ${token ? 'env var' : 'SDK default'}`);
    log(`[berean] Node version: ${process.version}`);
    log(`[berean] Prompt size: ${promptSize} chars (~${Math.round(promptSize / 4)} tokens)`);

    let content = '';
    const TIMEOUT_MS = 300_000; // 5 min
    let sdkWorks = false;
    let client: CopilotClient | null = null;

    // SDK is the primary path in all environments (including CI), as long as a token
    // or valid session is available. The SDK natively accepts `githubToken` for CI use
    // (see @github/copilot-sdk typings: CopilotClientOptions.githubToken).
    // HTTP is kept only as a last-resort fallback if the SDK throws/times out.
    try {
      client = await getClient();

      // Quick connectivity test via SDK (30s) — if it fails, fall through to HTTP
      log(`[berean] Starting client...`);
      await client.start();
      log(`[berean] Client started, testing SDK connectivity...`);

      const testSession = await client.createSession({ model, streaming: false, onPermissionRequest: approveAll });
      try {
        const testResponse = await testSession.sendAndWait({ prompt: 'Reply with just: OK' }, 30_000);
        const testContent = testResponse?.data?.content ?? '';
        if (testContent) {
          sdkWorks = true;
          log(`[berean] ✓ SDK works (test response: ${testContent.substring(0, 20)})`);
        }
      } catch (testErr) {
        log(`[berean] ✗ SDK connectivity test failed: ${testErr instanceof Error ? testErr.message : testErr}`);
      }
    } catch (startErr) {
      log(`[berean] ✗ SDK initialization failed: ${startErr instanceof Error ? startErr.message : startErr}`);
    }

    if (sdkWorks) {
      log(`[berean] Using SDK for review...`);
      const session = await client!.createSession({
        model,
        streaming: false,
        systemMessage: { content: system },
        onPermissionRequest: approveAll,
      });

      content = await new Promise<string>((resolve, reject) => {
        const messages: string[] = [];
        let gotMessage = false;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;

        // Pick the best captured message: prefer JSON-like content over plain text
        const pickBestMessage = (): string => {
          // First pass: prefer a message that starts with '{'
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].trimStart().startsWith('{')) return messages[i];
          }
          // Second pass: prefer a message that contains '{' (JSON may be embedded)
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].includes('{')) return messages[i];
          }
          // Fallback: last message received
          return messages[messages.length - 1] || '';
        };

        function gotJsonLikeMessage(): boolean {
          return messages.some(m => m.trimStart().startsWith('{'));
        }

        const timeoutId = setTimeout(() => {
          unsubscribe();
          if (gotMessage && messages.length > 0) {
            log(`[berean] Timeout reached but got response, using best of ${messages.length} message(s)`);
            resolve(pickBestMessage());
          } else {
            reject(new Error(`No response received after ${TIMEOUT_MS / 1000}s`));
          }
        }, TIMEOUT_MS);

        const settle = () => {
          if (settleTimer) clearTimeout(settleTimer);
          // Use shorter settle time if we already have JSON-like content, longer if we only have thinking text
          const delay = gotJsonLikeMessage() ? 5_000 : 15_000;
          settleTimer = setTimeout(() => {
            if (messages.length > 0) {
              clearTimeout(timeoutId);
              unsubscribe();
              const best = pickBestMessage();
              log(`[berean] Response settled (no new events for ${delay / 1000}s), picked best of ${messages.length} message(s)`);
              resolve(best);
            }
          }, delay);
        };

        const unsubscribe = session.on((event: Record<string, unknown>) => {
          const eventType = event.type as string;
          log(`[berean] Event: ${eventType}`);

          if (eventType === 'assistant.message') {
            const data = event.data as Record<string, unknown>;
            const msgContent = data?.content as string;
            if (msgContent) {
              messages.push(msgContent);
              log(`[berean] Message #${messages.length} received (${msgContent.length} chars, json-like: ${msgContent.trimStart().startsWith('{')})`);
            }
            gotMessage = true;
            settle();
          } else if (eventType === 'session.idle') {
            if (settleTimer) clearTimeout(settleTimer);
            clearTimeout(timeoutId);
            unsubscribe();
            log(`[berean] session.idle received`);
            resolve(pickBestMessage());
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

        log(`[berean] Sending prompt (${user.length} chars)...`);
        session.send({ prompt: user }).catch((e: Error) => {
          if (settleTimer) clearTimeout(settleTimer);
          clearTimeout(timeoutId);
          unsubscribe();
          reject(e);
        });
      });
    } else {
      // SDK doesn't work — use direct HTTP API
      if (!token) {
        return { success: false, error: 'No GitHub token available for HTTP fallback', model };
      }
      log(`[berean] Using direct HTTP API for review...`);
      content = await chatCompletion(token, model, system, user, TIMEOUT_MS);
    }

    if (!content || !looksLikeReviewJson(content)) {
      // SDK returned empty or non-JSON (e.g. model "thinking" text) — try direct HTTP as fallback
      if (token) {
        const reason = !content ? 'empty' : 'non-JSON (possible model thinking text)';
        log(`[berean] SDK returned ${reason}, trying direct HTTP API...`);
        const httpContent = await chatCompletion(token, model, system, user, TIMEOUT_MS);
        if (httpContent) content = httpContent;
      }
    }

    if (!content) {
      return { success: false, error: 'Empty response from API', model };
    }

    // Parse the JSON response
    const result = parseReviewResponse(content, model, reviewScope);
    if (result.issues && confidenceThreshold) {
      result.issues = result.issues.filter(i => (i.confidence || 100) >= confidenceThreshold);
    }
    return result;
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
        const { system: systemFallback, user: userFallback } = buildReviewPrompt(
          options.language ?? 'English',
          diff,
          options.rules,
        );
        const content = await chatCompletion(token, model, systemFallback, userFallback, 300_000);
        if (content) {
          const result = parseReviewResponse(content, model, reviewScope);
          if (result.issues && confidenceThreshold) {
            result.issues = result.issues.filter(i => (i.confidence || 100) >= confidenceThreshold);
          }
          return result;
        }
      } catch (httpError) {
        log(`[berean] HTTP fallback also failed: ${httpError instanceof Error ? httpError.message : httpError}`);
      }
    }

    return { success: false, error: errMsg, model };
  }
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseReviewResponse(content: string, model: string, reviewScope: ReviewScope): ReviewResult {
  try {
    let jsonContent = content;

    // Extract JSON if wrapped in markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonContent = jsonMatch[1].trim();
    }

    type ParsedReview = {
      summary?: string;
      recommendation?: ReviewResult['recommendation'];
      issues?: ReviewResult['issues'];
      positives?: string[];
      recommendations?: string[];
    };

    let parsed: ParsedReview | null = null;

    parsed = tryParseJson(jsonContent);

    // If direct parsing failed, try to extract a JSON object from within the text.
    // This handles cases where the model prepends thinking/reasoning text before the JSON.
    if (!parsed) {
      parsed = extractJsonFromMixedContent(content);
    }

    if (parsed) {
      return {
        success: true,
        summary: parsed.summary,
        recommendation: parsed.recommendation,
        issues: filterIssuesToReviewScope(parsed.issues, reviewScope),
        positives: parsed.positives,
        recommendations: parsed.recommendations,
        review: content,
        model,
      };
    }

    log(`[berean] ⚠ Could not parse review response as JSON (${content.length} chars). Content starts with: "${content.substring(0, 120)}..."`);
    return { success: true, review: content, model };
  } catch {
    return { success: true, review: content, model };
  }
}

/**
 * Try to parse a string as JSON, with automatic repair for truncated responses.
 */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    // Try to fix truncated JSON
    let fixedJson = text;

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
      return JSON.parse(fixedJson);
    } catch {
      return null;
    }
  }
}

/**
 * Extract a JSON object from mixed content where the model may have prepended
 * thinking/reasoning text before the actual JSON response.
 * Searches for `{` characters and attempts to parse from each position.
 */
function extractJsonFromMixedContent(content: string): Record<string, unknown> | null {
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const braceIndex = content.indexOf('{', searchFrom);
    if (braceIndex === -1) break;

    const candidate = content.substring(braceIndex);
    const result = tryParseJson(candidate);
    if (result && typeof result === 'object' && !Array.isArray(result) && ('summary' in result || 'issues' in result || 'recommendation' in result)) {
      log(`[berean] Extracted JSON from mixed content at position ${braceIndex}`);
      return result;
    }

    searchFrom = braceIndex + 1;
  }
  return null;
}

/**
 * Check if content looks like it could be valid review JSON (or contains JSON).
 * Used to decide whether to fall back to HTTP API.
 */
function looksLikeReviewJson(content: string): boolean {
  const trimmed = content.trim();
  // Direct JSON object
  if (trimmed.startsWith('{')) return true;
  // JSON inside markdown code block
  if (trimmed.includes('```json') || trimmed.includes('```\n{')) return true;
  // Contains a JSON-like structure with expected review fields
  if (trimmed.includes('"summary"') && trimmed.includes('"recommendation"')) return true;
  return false;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildReviewPrompt(
  language: string,
  diff: string,
  rules?: string,
): { system: string; user: string } {
  let system = `You are an expert code reviewer with deep expertise in software engineering best practices, security vulnerabilities, performance optimization, and code quality. Your role is advisory — provide clear, actionable feedback on code quality and potential issues.

You MUST respond with ONLY a valid JSON object (no markdown, no code blocks, no extra text). The JSON must follow this exact schema:

{
  "summary": "2-3 sentences describing what the changes do and overall assessment",
  "recommendation": "APPROVE | APPROVE_WITH_SUGGESTIONS | NEEDS_CHANGES | NEEDS_DISCUSSION",
  "issues": [
    {
      "severity": "critical | warning | suggestion",
      "category": "security | bug | performance | error-handling | maintainability | data-integrity | concurrency | resource-leak",
      "confidence": 85,
      "file": "/path/to/file.ts",
      "line": 42,
      "title": "Brief one-line title of the issue",
      "message": "Detailed description of the issue, why it matters, and how to fix it",
      "suggestion": "Optional: ONLY the corrected code that should replace the problematic code. Must be clean, ready-to-apply code — NO explanatory comments like '// remove this line', '// add this', '// changed from X to Y', etc. The suggestion must contain ONLY the final code the developer should use. IMPORTANT: Preserve the original indentation of the code exactly as it appears in the diff."
    }
  ],
  "positives": ["List of good practices observed in the code"],
  "recommendations": ["General recommendations for improvement"]
}

CONFIDENCE THRESHOLDS — Only report issues where you have high confidence:
- CRITICAL (95%+): Security vulnerabilities, data loss risks, crashes, authentication bypasses
- WARNING (85%+): Bugs, logic errors, performance issues, unhandled errors
- SUGGESTION (75%+): Code quality improvements, best practices, maintainability
- Below 75%: Do NOT report — insufficient confidence

CATEGORIES:
- security: Injection, auth issues, data exposure, insecure defaults
- bug: Logic errors, null/undefined handling, race conditions, incorrect behavior
- performance: Inefficient algorithms, memory leaks, unnecessary computations
- error-handling: Missing try-catch, unhandled promises, silent failures
- maintainability: Code complexity, duplication, poor abstractions
- data-integrity: Data validation, type coercion issues, boundary conditions
- concurrency: Race conditions, deadlocks, thread safety
- resource-leak: Unclosed connections, file handles, event listeners

DO NOT REPORT:
- Style preferences that don't affect functionality
- Minor naming suggestions unless severely misleading
- Import ordering or grouping preferences
- Whitespace or formatting issues
- Patterns that are conventional in the language/framework being used
- Minor refactoring that doesn't improve readability or performance meaningfully
- Personal coding preferences
- Files or folders that were excluded from the diff — do NOT mention that any folder or file was skipped, excluded, or not analyzed

RECOMMENDATION CRITERIA:
- APPROVE: No issues found, or only minor suggestions with confidence < 80
- APPROVE_WITH_SUGGESTIONS: Only suggestions (no warnings/critical), code is safe to merge
- NEEDS_CHANGES: Has warnings or critical issues that should be fixed before merge
- NEEDS_DISCUSSION: Has architectural concerns or trade-offs that need team discussion

CRITICAL RULES:
1. Response must be ONLY the JSON object — no markdown, no \`\`\`json blocks, just raw JSON
2. "file" must be the EXACT file path as shown in the diff headers
3. "line" must be a line number from the NEW version of the file (lines with + prefix)
4. "issues" array can be empty [] if there are no problems above confidence threshold
5. All text content must be in ${language}
6. Be specific and actionable — vague suggestions are worse than no suggestions
7. Each issue MUST have a "title" field with a brief one-line description
8. "suggestion" must contain ONLY executable code ready to replace the problematic code. If you cannot provide exact replacement code, OMIT the "suggestion" field entirely — do NOT put explanatory text, instructions, or pseudo-code in it. The "message" field is where explanations belong.
9. The suggestion will be rendered inside a \`\`\`suggestion code block in the review — it MUST preserve correct indentation exactly as it should appear in the source file. Never use other block types (e.g. xml, csharp, etc.) and never mix comments with code inside the suggestion.
10. SCOPE: Review ONLY the lines that were changed in this diff (lines prefixed with + for additions or - for removals). Do NOT report issues for unchanged context lines (those with no prefix or a space prefix) or for code that was not modified in this pull request. Your observations must be exclusively about the user's changes.
11. You MAY inspect surrounding context and directly related dependencies only to validate whether the changed code introduces a real problem. However, any reported issue must still point to the changed file and to a changed line from this diff. Never anchor findings to untouched files.
12. If a single issue requires multiple code changes in different locations, create SEPARATE issues (each with its own "suggestion" field) — one for each change location. Each suggestion block must correspond to exactly one replacement.

SUGGESTION FIELD EXAMPLES:

GOOD suggestion (exact replacement code with preserved indentation):
{
  "title": "Missing null check",
  "message": "The variable 'user' can be null when the API returns 404. Add a null check before accessing properties.",
  "suggestion": "    if (user == null) {\\n      throw new Error('User not found');\\n    }"
}
→ Indentation matches the original source file. The suggestion contains ONLY the final corrected code.

BAD suggestion (descriptive text — DO NOT do this):
{
  "title": "Missing null check",
  "message": "The variable 'user' can be null...",
  "suggestion": "Add a null check before accessing user properties and handle the null case appropriately"
}
→ This is wrong because 'suggestion' contains text instructions, not code. Either provide exact code or omit the field.

BAD suggestion (mixed code and comments — DO NOT do this):
{
  "title": "Hardcoded token",
  "message": "Token should come from token manager...",
  "suggestion": "// Remove the line below\\n// const tk = 'token';\\nfinal token = await getToken();\\noptions.headers['Auth'] = 'Bearer $token';"
}
→ This is wrong because it includes instructional comments. The suggestion should contain ONLY the final code.

GOOD (when you can't provide exact code — omit the field):
{
  "title": "Complex refactoring needed",
  "message": "The authentication flow should use the token manager instead of hardcoded tokens. Replace the hardcoded 'tk' constant with a call to _tokenManager.getValidToken() and update the Authorization header accordingly.",
  "confidence": 90
}
→ No "suggestion" field at all — this is correct when exact replacement code would be complex or context-dependent.`;

  if (rules) {
    system += `\n\n---\n\nPROJECT-SPECIFIC RULES AND GUIDELINES (use these to evaluate the code, they take priority over general rules):\n\n${rules}`;
  }

  const user = `Here is the pull request diff to review (only analyze the changed lines):\n\n${diff}`;

  return { system, user };
}

interface ReviewScope {
  changedFiles: Set<string>;
  changedLinesByFile: Map<string, Set<number>>;
}

function extractReviewScope(diff: string): ReviewScope {
  const changedFiles = new Set<string>();
  const changedLinesByFile = new Map<string, Set<number>>();

  let currentFile: string | null = null;
  let currentLine: number | null = null;
  let currentChangeType: string | null = null;

  for (const rawLine of diff.split('\n')) {
    const fileMatch = rawLine.match(/^## ([^:]+): (.+)$/);
    if (fileMatch) {
      currentChangeType = fileMatch[1].trim();
      currentFile = fileMatch[2].trim();
      changedFiles.add(currentFile);
      if (!changedLinesByFile.has(currentFile)) {
        changedLinesByFile.set(currentFile, new Set<number>());
      }
      currentLine = currentChangeType === 'Add' ? 1 : null;
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!currentFile || currentLine == null) {
      continue;
    }

    if (rawLine.startsWith('```')) {
      continue;
    }

    if (rawLine.startsWith('+ ')) {
      changedLinesByFile.get(currentFile)?.add(currentLine);
      currentLine += 1;
      continue;
    }

    if (rawLine.startsWith('- ')) {
      continue;
    }

    if (rawLine.startsWith('  ')) {
      currentLine += 1;
    }
  }

  return { changedFiles, changedLinesByFile };
}

function filterIssuesToReviewScope(
  issues: ReviewResult['issues'],
  reviewScope: ReviewScope,
): ReviewResult['issues'] {
  if (!issues || issues.length === 0) {
    return issues;
  }

  return issues.filter(issue => {
    if (!issue.file) {
      return true;
    }

    if (!reviewScope.changedFiles.has(issue.file)) {
      return false;
    }

    if (issue.line == null) {
      return true;
    }

    const changedLines = reviewScope.changedLinesByFile.get(issue.file);
    if (!changedLines || changedLines.size === 0) {
      return false;
    }

    return changedLines.has(issue.line);
  });
}

// ─── Rule query generation ────────────────────────────────────────────────────

/**
 * Ask the LLM to generate search queries relevant to the provided diff.
 * Used by dynamic URL rule sources (those with a {{query}} placeholder).
 *
 * Tries HTTP first (if a GitHub token is available), falls back to the SDK.
 * Returns up to 5 concise search queries, or [] on failure.
 *
 * @param diff PR diff used to derive queries.
 * @param model Model identifier used for query generation.
 */
export async function generateRuleQueries(diff: string, model: string): Promise<string[]> {
  const systemPrompt = 'You are a helpful assistant that generates concise search queries for code review guidelines.';

  const userPrompt = `Analyze the following code diff and generate 3 to 5 concise search queries to find the most relevant coding guidelines, architectural rules, or best practices that should be applied during code review.

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
      content = await chatCompletion(token, model, systemPrompt, userPrompt, 30_000);
    } catch (e) {
      log(`[berean] generateRuleQueries HTTP failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // SDK fallback
  if (!content && !isNonInteractiveEnvironment()) {
    try {
      const client = await getClient();
      await client.start();
      const session = await client.createSession({ model, streaming: false, onPermissionRequest: approveAll });
      const response = await session.sendAndWait({ prompt: userPrompt }, 30_000);
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
