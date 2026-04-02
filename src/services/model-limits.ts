import { fetchModels } from '../providers/github-copilot.js';

const CHARS_PER_TOKEN = 4;
const DEFAULT_RULES_BUDGET_RATIO = 0.65;

export async function getModelMaxRulesChars(
  modelId: string,
  rulesBudgetRatio = DEFAULT_RULES_BUDGET_RATIO,
): Promise<number | undefined> {
  try {
    const models = await fetchModels();
    const match = models.find(m => m.id === modelId);
    if (match?.maxContextTokens && match.maxContextTokens > 0) {
      const ratio = rulesBudgetRatio > 0 && rulesBudgetRatio <= 1 ? rulesBudgetRatio : DEFAULT_RULES_BUDGET_RATIO;
      return Math.floor(match.maxContextTokens * CHARS_PER_TOKEN * ratio);
    }
  } catch {
    return undefined;
  }

  return undefined;
}
