#!/usr/bin/env node

import { Command } from 'commander';
import { authCommand } from './commands/auth.js';
import { reviewCommand } from './commands/review.js';
import { configCommand } from './commands/config.js';
import { updateCommand } from './commands/update.js';
import { modelsCommand } from './commands/models.js';
import { stopClient } from './providers/github-copilot.js';

// Enable verbose logging early so providers receive the flag before any action runs
if (process.argv.includes('--verbose')) {
  process.env.BEREAN_VERBOSE = '1';
}

const program = new Command();

program
  .name('berean')
  .description('🔍 AI-powered code review for GitHub and Azure DevOps PRs using GitHub Copilot')
  .version('0.2.0', '-v, --version', 'Show current version');

program.addCommand(authCommand);
program.addCommand(reviewCommand);
program.addCommand(configCommand);
program.addCommand(updateCommand);
program.addCommand(modelsCommand);

// Cleanup on exit
process.on('beforeExit', async () => {
  await stopClient();
});

program.parse();
