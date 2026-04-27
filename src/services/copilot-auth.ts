import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { getGitHubTokenFromAzure } from './credentials.js';

const COPILOT_CONFIG_DIR = path.join(os.homedir(), '.copilot');
const COPILOT_CONFIG_FILE = path.join(COPILOT_CONFIG_DIR, 'config.json');

type CopilotConfig = {
  lastLoggedInUser?: {
    host?: string;
    login?: string;
  };
  loggedInUsers?: Array<{
    host?: string;
    login?: string;
  }>;
};

function readCopilotConfig(): CopilotConfig | null {
  if (!fs.existsSync(COPILOT_CONFIG_FILE)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(COPILOT_CONFIG_FILE, 'utf-8');
    const sanitized = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .trim();

    if (!sanitized) {
      return null;
    }

    return JSON.parse(sanitized) as CopilotConfig;
  } catch {
    return null;
  }
}

export function hasCopilotCliSession(): boolean {
  const config = readCopilotConfig();

  if (!config) {
    return false;
  }

  if (config.lastLoggedInUser?.login) {
    return true;
  }

  return Array.isArray(config.loggedInUsers) && config.loggedInUsers.length > 0;
}

export function isNonInteractiveEnvironment(): boolean {
  return !process.stdin.isTTY || !!process.env.CI;
}

export function getNonInteractiveAuthError(): string {
  return [
    'Non-interactive authentication requires an explicit GitHub token.',
    'Set one of these environment variables before running Berean: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, or GITHUBTOKEN.',
    'Accepted token types for Copilot token exchange: fine-grained PAT with the "Copilot Requests" permission, Copilot CLI OAuth token, or GitHub CLI OAuth token.',
    'Classic personal access tokens (ghp_) are not supported.',
    'Interactive login is disabled in CI/non-TTY environments.',
  ].join(' ');
}

/**
 * Check if user is authenticated (has a GitHub token available)
 */
export function isAuthenticated(): boolean {
  if (getGitHubTokenFromAzure()) return true;

  return hasCopilotCliSession();
}

/**
 * Get auth status with details
 */
export async function getAuthStatus(): Promise<{
  authenticated: boolean;
  method: 'env' | 'cli' | 'none';
  token?: string;
  error?: string;
}> {
  const token = getGitHubTokenFromAzure();

  if (token) {
    const masked = token.substring(0, 8) + '...' + token.slice(-4);
    return {
      authenticated: true,
      method: 'env',
      token: masked
    };
  }

  if (hasCopilotCliSession()) {
    return { authenticated: true, method: 'cli' };
  }

  return { authenticated: false, method: 'none' };
}

/**
 * Login via Copilot CLI OAuth device flow
 */
export function loginViaCLI(): void {
  if (isNonInteractiveEnvironment()) {
    throw new Error(getNonInteractiveAuthError());
  }

  try {
    execSync('copilot login', { stdio: 'inherit' });
  } catch (error) {
    throw new Error('Copilot CLI login failed. Make sure @github/copilot is installed and complete the OAuth device flow shown by "copilot login".');
  }

  if (!hasCopilotCliSession() && !getGitHubTokenFromAzure()) {
    throw new Error('Copilot CLI did not create a usable session. Run "copilot login" manually and complete the browser/device flow, or set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN.');
  }
}

/**
 * Logout from Copilot CLI.
 *
 * The current Copilot CLI (@github/copilot) does not expose a `logout`
 * subcommand (only `login`). To end the local session we clear the
 * session fields in ~/.copilot/config.json. Other keys (e.g.
 * `firstLaunchAt`) are preserved. If the JSON cannot be safely rewritten,
 * the file is removed entirely — the CLI recreates it on next login.
 *
 * Errors are swallowed so that calling logout when no session exists is
 * a no-op.
 */
export function logoutViaCLI(): void {
  if (!fs.existsSync(COPILOT_CONFIG_FILE)) {
    return;
  }

  const config = readCopilotConfig();

  if (config && typeof config === 'object') {
    try {
      const cleaned: Record<string, unknown> = { ...(config as Record<string, unknown>) };
      delete cleaned.lastLoggedInUser;
      delete cleaned.loggedInUsers;

      fs.writeFileSync(
        COPILOT_CONFIG_FILE,
        JSON.stringify(cleaned, null, 2),
        { mode: 0o600 }
      );
      return;
    } catch {
      // Fall through to full removal below.
    }
  }

  try {
    fs.unlinkSync(COPILOT_CONFIG_FILE);
  } catch {
    // File already gone or permission issue — treat as logged out.
  }
}
