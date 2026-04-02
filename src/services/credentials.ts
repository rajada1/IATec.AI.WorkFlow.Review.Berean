import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.berean');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface Config {
  default_model?: string;
  language?: string;
  azure_devops_pat?: string;
  max_rules_chars?: string;
  [key: string]: string | undefined;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Get GitHub token for GitHub REST API usage.
 *
 * For GitHub PR operations, prefer the conventional GITHUB_TOKEN first,
 * then fall back to the other compatible variable names.
 */
export function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN
    || process.env.GH_TOKEN
    || process.env.COPILOT_GITHUB_TOKEN
    || process.env.GITHUBTOKEN
    || null;
}

/**
 * Get the source env var for the GitHub REST API token (if any)
 */
export function getGitHubTokenSource(): string | null {
   if (process.env.GITHUB_TOKEN) return 'GITHUB_TOKEN';
   if (process.env.GH_TOKEN) return 'GH_TOKEN';
   if (process.env.COPILOT_GITHUB_TOKEN) return 'COPILOT_GITHUB_TOKEN';
   if (process.env.GITHUBTOKEN) return 'GITHUBTOKEN';
   return null;
}

/**
 * Get Azure DevOps PAT from env or config
 */
export function getAzureDevOpsPAT(): string | null {
  return getAzureDevOpsPATFromPipeline();
}

/**
 * Get the source for the current Azure DevOps PAT (if any)
 */
export function getAzureDevOpsPATSource(): string | null {
  if (process.env.AZURE_DEVOPS_PAT) return 'AZURE_DEVOPS_PAT';
  if (process.env.AZUREDEVOPSPAT) return 'AZUREDEVOPSPAT';
  if (process.env.SYSTEM_ACCESSTOKEN) return 'SYSTEM_ACCESSTOKEN';
  if (getConfig().azure_devops_pat) return 'config file';
  return null;
}

/**
 * Get default model from env or config
 * Priority: BEREAN_MODEL → BEREAN.MODEL (Azure DevOps format) → config file → 'gpt-4o'
 * 
 * Azure DevOps transforms variable names:
 *   - Pipeline variable "BEREAN_MODEL" → env var "BEREAN_MODEL"
 *   - Pipeline variable "berean.model" → env var "BEREAN_MODEL" (dots→underscores, uppercased)
 *   - Variable group "BereanModel" → env var "BEREANMODEL"
 */
export function getDefaultModel(): string {
  return process.env.BEREAN_MODEL
    || process.env.BEREANMODEL
    || getConfig().default_model 
    || 'gpt-4o';
}

/**
 * Get the source of the current model config (for display)
 */
export function getDefaultModelSource(): string {
  if (process.env.BEREAN_MODEL) return 'BEREAN_MODEL env';
  if (process.env.BEREANMODEL) return 'BEREANMODEL env';
  if (getConfig().default_model) return 'config file';
  return 'default';
}

/**
 * Get default language from env or config
 * Priority: BEREAN_LANGUAGE → BEREANLANGUAGE → config file → 'English'
 */
export function getDefaultLanguage(): string {
  return process.env.BEREAN_LANGUAGE
    || process.env.BEREANLANGUAGE
    || getConfig().language 
    || 'English';
}

/**
 * Get the source of the current language config (for display)
 */
export function getDefaultLanguageSource(): string {
  if (process.env.BEREAN_LANGUAGE) return 'BEREAN_LANGUAGE env';
  if (process.env.BEREANLANGUAGE) return 'BEREANLANGUAGE env';
  if (getConfig().language) return 'config file';
  return 'default';
}

/**
 * Get rules file path from env or config
 * Priority: BEREAN_RULES → BEREANRULES → config file → null
 */
export function getRulesPath(): string | null {
  return process.env.BEREAN_RULES
    || process.env.BEREANRULES
    || getConfig().rules_path
    || null;
}

/**
 * Get memory index file path from env or auto-discover local MEMORY.md.
 * Priority: BEREAN_MEMORY → BEREANMEMORY → ./MEMORY.md (if it exists) → null
 */
export function getMemoryFilePath(): string | null {
  const envPath = process.env.BEREAN_MEMORY || process.env.BEREANMEMORY;
  if (envPath) return envPath;

  const localMemory = path.join(process.cwd(), 'MEMORY.md');
  if (fs.existsSync(localMemory)) return localMemory;

  return null;
}

/**
 * Get maximum total rules characters from env or config
 * Priority: BEREAN_MAX_RULES_CHARS → BEREANMAXRULESCHARS → config file → defaultMax → 50000
 *
 * @param defaultMax Optional default when no env/config is set.
 */
export function getMaxRulesChars(defaultMax?: number): number {
  const DEFAULT_MAX = 50_000;
  const fallbackMax = defaultMax && defaultMax > 0 ? Math.floor(defaultMax) : DEFAULT_MAX;

  const envValue = process.env.BEREAN_MAX_RULES_CHARS
    || process.env.BEREANMAXRULESCHARS;

  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  const configValue = getConfig().max_rules_chars;
  if (configValue) {
    const parsed = parseInt(configValue, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return fallbackMax;
}

/**
 * Get GitHub token for Copilot/SDK flows.
 *
 * Keeps the existing priority used by the Copilot integration.
 */
export function getGitHubTokenFromAzure(): string | null {
  return process.env.COPILOT_GITHUB_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_TOKEN
    || process.env.GITHUBTOKEN
    || null;
}

/**
 * Get Azure DevOps PAT - also checks Azure pipeline system token
 */
export function getAzureDevOpsPATFromPipeline(): string | null {
  return process.env.AZURE_DEVOPS_PAT
    || process.env.AZUREDEVOPSPAT
    || process.env.SYSTEM_ACCESSTOKEN
    || getConfig().azure_devops_pat
    || null;
}

export function getConfig(): Config {
  ensureConfigDir();
  
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function saveConfig(config: Partial<Config>): void {
  ensureConfigDir();
  
  const existing = getConfig();
  const merged = { ...existing, ...config };
  
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(merged, null, 2),
    { mode: 0o600 }
  );
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

// Legacy compat - clear old credentials file if it exists
export function clearCredentials(): void {
  const credFile = path.join(CONFIG_DIR, 'credentials.json');
  if (fs.existsSync(credFile)) {
    fs.unlinkSync(credFile);
  }
}
