import { Command } from 'commander';
import chalk from 'chalk';
import { saveConfig, getConfigDir, getAzureDevOpsPATFromPipeline, getGitHubTokenFromAzure, getDefaultModel, getDefaultLanguage, getDefaultModelSource, getDefaultLanguageSource, getMaxRulesChars } from '../services/credentials.js';
import { getModelMaxRulesChars } from '../services/model-limits.js';
import { stopClient } from '../providers/github-copilot.js';

export const configCommand = new Command('config')
  .description('Manage configuration');

const VALID_CONFIG_KEYS = ['azure-pat', 'default-model', 'language', 'max-rules-chars'];

configCommand
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    const validKeys = VALID_CONFIG_KEYS;
    
    if (!validKeys.includes(key)) {
      console.log(chalk.red(`✗ Unknown config key: ${key}`));
      console.log(chalk.gray(`  Valid keys: ${validKeys.join(', ')}`));
      process.exit(1);
    }

    switch (key) {
      case 'azure-pat':
        saveConfig({ azure_devops_pat: value });
        console.log(chalk.green('✓ Azure DevOps PAT saved.'));
        break;
      case 'default-model':
        saveConfig({ default_model: value });
        console.log(chalk.green(`✓ Default model set to: ${value}`));
        break;
      case 'language':
        saveConfig({ language: value });
        console.log(chalk.green(`✓ Language set to: ${value}`));
        break;
      case 'max-rules-chars': {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed) || parsed <= 0) {
          console.log(chalk.red('✗ max-rules-chars must be a positive number'));
          process.exit(1);
        }
        saveConfig({ max_rules_chars: value });
        console.log(chalk.green(`✓ Max rules chars set to: ${value}`));
        break;
      }
    }
  });

configCommand
  .command('get [key]')
  .description('Get configuration value(s)')
  .action(async (key?: string) => {
    let resolvedMaxRulesChars: number | null = null;

    const getResolvedMaxRulesChars = async (): Promise<number> => {
      if (resolvedMaxRulesChars !== null) return resolvedMaxRulesChars;
      const model = getDefaultModel();
      const modelMaxRulesChars = await getModelMaxRulesChars(model);
      resolvedMaxRulesChars = getMaxRulesChars(modelMaxRulesChars);
      return resolvedMaxRulesChars;
    };

    try {
      if (key) {
        switch (key) {
          case 'azure-pat': {
            const pat = getAzureDevOpsPATFromPipeline();
            if (pat) {
              const masked = pat.substring(0, 6) + '...' + pat.slice(-4);
              console.log(chalk.white(`azure-pat: ${masked}`));
            } else {
              console.log(chalk.gray('azure-pat: (not set)'));
            }
            break;
          }
          case 'default-model':
            console.log(chalk.white(`default-model: ${getDefaultModel()}`));
            console.log(chalk.gray(`  (from ${getDefaultModelSource()})`));
            break;
          case 'language':
            console.log(chalk.white(`language: ${getDefaultLanguage()}`));
            console.log(chalk.gray(`  (from ${getDefaultLanguageSource()})`));
            break;
          case 'max-rules-chars':
            console.log(chalk.white(`max-rules-chars: ${await getResolvedMaxRulesChars()}`));
            break;
          default:
            console.log(chalk.red(`✗ Unknown config key: ${key}`));
        }
      } else {
        // Show all config
        console.log(chalk.blue.bold('Configuration:\n'));
        
        console.log(chalk.white('  Config directory:'), chalk.gray(getConfigDir()));
        console.log();
        
        const hasPat = !!getAzureDevOpsPATFromPipeline();
        const hasToken = !!getGitHubTokenFromAzure();
        
        console.log(chalk.white('  azure-pat:'), hasPat 
          ? chalk.green('configured') 
          : chalk.yellow('not set'));
        
        console.log(chalk.white('  github-auth:'), hasToken 
          ? chalk.green('via environment variable') 
          : chalk.yellow('using Copilot CLI'));
        
        console.log();
        console.log(chalk.white('  default-model:'), chalk.cyan(getDefaultModel()));
        console.log(chalk.gray(`                  (from ${getDefaultModelSource()})`));
        console.log(chalk.white('  language:'), chalk.cyan(getDefaultLanguage()));
        console.log(chalk.gray(`             (from ${getDefaultLanguageSource()})`));
        console.log(chalk.white('  max-rules-chars:'), chalk.cyan(String(await getResolvedMaxRulesChars())));
      }
    } finally {
      await stopClient();
    }
  });

configCommand
  .command('path')
  .description('Show config directory path')
  .action(() => {
    console.log(getConfigDir());
  });
