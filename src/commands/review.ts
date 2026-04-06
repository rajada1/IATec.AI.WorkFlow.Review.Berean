import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  createProviderFromUrl,
  createProviderFromFlags,
  shouldIgnorePR,
  addReviewedCommitsTag,
  addReviewedIterationTag,
  type PRProvider,
} from '../services/pr-provider.js';
import { reviewCode, fetchModels, stopClient, generateRuleQueries, ReviewResult, ReviewIssue } from '../providers/github-copilot.js';
import { isAuthenticated } from '../services/copilot-auth.js';
import { getDefaultModel, getDefaultLanguage, getRulesPath } from '../services/credentials.js';
import { parseRuleSources, resolveRules, getBuiltInRulesPath } from '../services/rules.js';
import { getModelMaxRulesChars } from '../services/model-limits.js';

function log(msg: string): void {
  if (process.env.BEREAN_VERBOSE) {
    console.error(msg);
  }
}

export const reviewCommand = new Command('review')
  .description('Review a Pull Request')
  .argument('[url]', 'Pull Request URL (GitHub or Azure DevOps)')
  .option('--owner <owner>', 'GitHub repository owner')
  .option('--org <organization>', 'Azure DevOps organization')
  .option('--project <project>', 'Azure DevOps project')
  .option('--repo <repository>', 'Repository name')
  .option('--pr <id>', 'Pull Request ID')
  .option('--model <model>', 'AI model to use (default: gpt-4o)')
  .option('--language <lang>', 'Response language (default: English)')
  .option('--json', 'Output as JSON')
  .option('--list-models', 'List available models')
  .option('--post-comment', 'Post review as a comment on the PR')
  .option('--inline', 'Post inline comments on specific lines')
  .option('--skip-if-reviewed', 'Skip if PR was already reviewed by Berean')
  .option('--incremental', 'Only review new commits since last Berean review')
  .option('--force', 'Force review even if @berean: ignore is set')
  .option('--confidence-threshold <number>', 'Minimum confidence to report issues (0-100, default: 75)')
  .option(
    '--rules <sources>',
    'Comma-separated rule sources: file paths, directories, or URLs. ' +
    'URLs with {{query}} are queried dynamically by the LLM. ' +
    'E.g.: ./rules.md,https://host/doc?q={{query}} (or set BEREAN_RULES env)',
  )
  .option(
    '--skip-folders <folders>',
    'Comma-separated list of folders to exclude from review (e.g. node_modules,dist,src/generated)',
  )
  .option('--verbose', 'Show detailed debug output (sets BEREAN_VERBOSE=1)')
  .action(async (url, options) => {
    try {
      // Enable verbose logging early so providers pick it up
      if (options.verbose) {
        process.env.BEREAN_VERBOSE = '1';
      }

      // List models
      if (options.listModels) {
        await listModels();
        return;
      }

      // Check authentication
      if (!isAuthenticated()) {
        console.log(chalk.red('✗ Not authenticated. Run: berean auth login'));
        process.exit(1);
      }

      // Resolve PR provider (GitHub or Azure DevOps)
      let providerResult;

      if (url) {
        providerResult = createProviderFromUrl(url);
      } else {
        providerResult = createProviderFromFlags(options);
      }

      if (!providerResult.provider) {
        console.log(chalk.red(`✗ ${providerResult.error}`));
        process.exit(1);
      }

      const provider = providerResult.provider;
      log(`[berean] Provider: ${provider.platform} (source: ${url ? 'url' : 'flags'})`);

      // ── 1. Lightweight PR details fetch (for @berean: ignore check) ──────────
      const infoSpinner = ora('Fetching PR info...').start();
      const prBasicInfo = await provider.fetchPRBasicInfo();

      if (!prBasicInfo.success || !prBasicInfo.prDetails) {
        infoSpinner.fail('Failed to fetch PR info');
        console.log(chalk.red(`  ${prBasicInfo.error}`));
        process.exit(1);
      }

      infoSpinner.succeed(`PR: ${prBasicInfo.prDetails.title}`);

      // Check for @berean: ignore in PR description
      if (!options.force && shouldIgnorePR(prBasicInfo.prDetails.description)) {
        console.log(chalk.yellow('⏭️  Skipped: PR description contains @berean: ignore'));
        console.log(chalk.gray('   Use --force to review anyway'));
        process.exit(0);
      }

      // ── 2. Check for existing Berean reviews and determine scope ─────────────
      let existingReview: { threadId: number; commentId: number; reviewedIterationId?: number; content: string } | null = null;
      let reviewedCommits: string[] = [];
      let allCommits: string[] = [];
      let newCommits: string[] = [];
      let fromIterationId: number | undefined;

      if (options.skipIfReviewed || options.incremental) {
        const checkSpinner = ora('Checking for existing reviews...').start();

        const [bereanComments, prCommits] = await Promise.all([
          provider.findBereanComments(),
          provider.getPRCommits(),
        ]);

        allCommits = prCommits;

        if (bereanComments.length > 0) {
          // Use the most recent Berean comment
          const latest = bereanComments[bereanComments.length - 1];
          existingReview = {
            threadId: latest.threadId,
            commentId: latest.commentId,
            reviewedIterationId: latest.reviewedIterationId,
            content: latest.content,
          };
          reviewedCommits = latest.reviewedCommits ?? [];

          newCommits = allCommits.filter(c => !reviewedCommits.includes(c));

          if (options.skipIfReviewed && newCommits.length === 0) {
            checkSpinner.succeed('PR already reviewed by Berean (no new commits)');
            console.log(chalk.gray('   Use --force to review again'));
            process.exit(0);
          }

          if (options.incremental && newCommits.length === 0) {
            checkSpinner.succeed('No new commits since last review');
            process.exit(0);
          }

          // For incremental diff: use the iteration stored in the last review
          if (options.incremental && existingReview.reviewedIterationId) {
            fromIterationId = existingReview.reviewedIterationId;
          }

          if (newCommits.length > 0) {
            const iterNote = fromIterationId ? ` (from iteration ${fromIterationId})` : '';
            checkSpinner.succeed(`Found ${newCommits.length} new commits since last review${iterNote}`);
          } else {
            checkSpinner.succeed('No previous Berean review found');
          }
        } else {
          checkSpinner.succeed('No previous Berean review found');
        }
      } else {
        // Just get commits for tagging
        allCommits = await provider.getPRCommits();
      }

      // ── 3. Fetch diff (incremental scope when applicable) ────────────────────
      const diffSpinner = ora(
        fromIterationId
          ? `Fetching incremental diff (iteration ${fromIterationId} → latest)...`
          : 'Fetching PR diff...',
      ).start();

      const skipFolders = options.skipFolders
        ? (options.skipFolders as string).split(',').map((f: string) => f.trim()).filter(Boolean)
        : [];

      const diffResult = await provider.fetchPRDiff({ fromIterationId, skipFolders });

      if (!diffResult.success || !diffResult.diff) {
        diffSpinner.fail('Failed to fetch PR diff');
        console.log(chalk.red(`  ${diffResult.error}`));
        process.exit(1);
      }

      diffSpinner.succeed(
        fromIterationId
          ? `Incremental diff fetched (${diffResult.diff.length} chars)`
          : `Diff fetched (${diffResult.diff.length} chars)`,
      );

      if (diffResult.skippedFiles && diffResult.skippedFiles > 0) {
        console.log(chalk.gray(`  ⏭️  ${diffResult.skippedFiles} file(s) skipped (--skip-folders: ${skipFolders.join(', ')})`));
      }

      // ── 4. Load project rules (after diff — URL sources need the diff for LLM queries) ──
      const language = options.language || getDefaultLanguage();
      const model = options.model || getDefaultModel();

      let rules: string | undefined;
      const userRulesInput = options.rules || getRulesPath();
      const builtInRulesPath = getBuiltInRulesPath();
      const rulesInput = userRulesInput
        ? `${builtInRulesPath},${userRulesInput}`
        : builtInRulesPath;

        {
          const rulesSpinner = ora('Loading project rules...').start();
          try {
            const sources = parseRuleSources(rulesInput);
            const hasUrlSources = sources.some(s => s.type === 'url');

          if (hasUrlSources) {
            rulesSpinner.text = 'Loading project rules (fetching from URLs)...';
          }

          const maxRulesCharsDefault = await getModelMaxRulesChars(model);
          const result = await resolveRules(
            sources,
            diffResult.diff,
            (d) => generateRuleQueries(d, model),
            maxRulesCharsDefault,
          );

          if (result.rules) {
            rules = result.rules;

            const okCount = result.sources.filter(s => s.status === 'ok').length;
            const warnSources = result.sources.filter(s => s.status === 'warn');

            if (warnSources.length > 0) {
              rulesSpinner.warn(`Rules loaded from ${okCount} source(s), ${warnSources.length} warning(s)`);
              for (const w of warnSources) {
                if (w.message) console.log(chalk.gray(`    ⚠  ${w.label}: ${w.message}`));
              }
            } else {
              rulesSpinner.succeed(`Rules loaded from ${okCount} source(s)`);
            }
          } else {
            rulesSpinner.warn('No rules content loaded (all sources empty or failed)');
          }
        } catch (error) {
          rulesSpinner.warn(
            `Failed to load rules: ${error instanceof Error ? error.message : 'Unknown error'} (continuing without rules)`,
          );
        }
      }

      // ── 5. Review code ────────────────────────────────────────────────────────
      const reviewSpinner = ora(`Reviewing with ${model}...`).start();

      const reviewResult = await reviewCode(diffResult.diff, {
        model,
        language,
        rules,
        confidenceThreshold: options.confidenceThreshold ? parseInt(options.confidenceThreshold, 10) : undefined,
      });

      if (!reviewResult.success) {
        reviewSpinner.fail('Review failed');
        console.log(chalk.red(`  ${reviewResult.error}`));
        process.exit(1);
      }

      reviewSpinner.succeed('Review complete!');

      // ── 6. Post comments ──────────────────────────────────────────────────────
      let postFailed = false;

      if (options.postComment) {
        const success = await postGeneralComment(
          provider,
          reviewResult,
          allCommits,
          diffResult.currentIterationId,
          existingReview,
          options.incremental,
        );
        if (!success) {
          postFailed = true;
        }
      }

      if (options.inline && !postFailed) {
        const success = await postInlineIssues(provider, reviewResult);
        if (!success) {
          postFailed = true;
        }
      }

      // ── 7. Output ─────────────────────────────────────────────────────────────
      if (options.json) {
        console.log(JSON.stringify(reviewResult, null, 2));
      } else {
        printReviewToTerminal(reviewResult);
      }

      if (postFailed) {
        process.exitCode = 1;
      }
    } finally {
      await stopClient();
    }
  });

// ─── Comment helpers ──────────────────────────────────────────────────────────

async function postGeneralComment(
  provider: PRProvider,
  reviewResult: ReviewResult,
  commitIds: string[] = [],
  currentIterationId: number | undefined,
  existingReview: { threadId: number; commentId: number; content: string } | null = null,
  incremental = false,
): Promise<boolean> {
  const spinner = ora('Posting review comment to PR...').start();

  // Build the new review markdown
  let newComment = formatReviewAsMarkdown(reviewResult);

  // Embed tracking tags
  if (commitIds.length > 0) {
    newComment = addReviewedCommitsTag(newComment, commitIds);
  }
  if (currentIterationId) {
    newComment = addReviewedIterationTag(newComment, currentIterationId);
  }

  let result;

  if (incremental && existingReview) {
    // Preserve the previous review inside a collapsible <details> block
    const fullComment = buildIncrementalComment(newComment, existingReview.content);
    result = await provider.updatePRComment(existingReview.threadId, existingReview.commentId, fullComment);
    if (result.success) {
      spinner.succeed('Updated existing review comment with new findings!');
    } else {
      spinner.fail('Failed to update comment');
      console.log(chalk.red(`  ${result.error}`));
    }
  } else {
    result = await provider.postPRComment(newComment);
    if (result.success) {
      spinner.succeed('Review posted to PR!');
    } else {
      spinner.fail('Failed to post comment');
      console.log(chalk.red(`  ${result.error}`));
    }
  }

  return result.success;
}

/**
 * Wrap previous review content in a collapsible section and prepend the new review.
 */
function buildIncrementalComment(newContent: string, previousContent: string): string {
  // Strip hidden Berean tags from previous content to avoid nested tags
  const cleanPrevious = previousContent
    .replace(/<!-- berean-review -->/g, '')
    .replace(/<!-- berean-commits:.*?:berean-commits -->/gs, '')
    .replace(/<!-- berean-iteration:\d+:berean-iteration -->/g, '')
    .trim();

  const timestamp = new Date().toISOString().split('T')[0];

  return (
    `${newContent}\n\n` +
    `<details>\n<summary>📜 Previous review (${timestamp})</summary>\n\n${cleanPrevious}\n\n</details>`
  );
}

async function postInlineIssues(provider: PRProvider, reviewResult: ReviewResult): Promise<boolean> {
  const inlineIssues = (reviewResult.issues ?? []).filter(i => i.file && i.line);

  if (inlineIssues.length === 0) {
    console.log(chalk.yellow('  No issues with file/line info for inline comments'));
    return true;
  }

  const spinner = ora(`Posting ${inlineIssues.length} inline comments...`).start();

  const comments = inlineIssues.map(issue => ({
    filePath: issue.file!,
    line: issue.line!,
    content: formatIssueAsMarkdown(issue),
  }));

  const result = await provider.postInlineComments(comments);

  if (result.failed === 0) {
    spinner.succeed(`Posted ${result.success} inline comments!`);
    return true;
  } else if (result.success > 0) {
    spinner.warn(`Posted ${result.success} comments, ${result.failed} failed`);
    for (const err of result.errors.slice(0, 3)) {
      console.log(chalk.gray(`    ${err}`));
    }
    return false;
  } else {
    spinner.fail(`Failed to post inline comments`);
    for (const err of result.errors.slice(0, 3)) {
      console.log(chalk.red(`    ${err}`));
    }
    return false;
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatReviewAsMarkdown(reviewResult: ReviewResult): string {
  let md = '## 🔍 AI Code Review\n\n';

  if (reviewResult.summary) {
    md += `### Summary\n${reviewResult.summary}\n\n`;
  }

  if (reviewResult.recommendation) {
    const recEmoji: Record<string, string> = {
      'APPROVE': '✅',
      'APPROVE_WITH_SUGGESTIONS': '✅💡',
      'NEEDS_CHANGES': '⚠️',
      'NEEDS_DISCUSSION': '💬'
    };
    const emoji = recEmoji[reviewResult.recommendation] || '📋';
    md += `### ${emoji} Recommendation: ${reviewResult.recommendation.replace(/_/g, ' ')}\n\n`;
  }

  if (reviewResult.issues && reviewResult.issues.length > 0) {
    md += '### Issues Found\n\n';
    md += formatIssuesGroupedByFile(reviewResult.issues);
  } else if (!reviewResult.summary && reviewResult.review) {
    // Safety net: only show raw review content if it looks like a structured review (contains JSON).
    // If the content is just model "thinking" text (not JSON), show a fallback message instead.
    const reviewText = reviewResult.review.trim();
    if (reviewText.startsWith('{') || reviewText.includes('"summary"') || reviewText.includes('"issues"')) {
      md += reviewResult.review + '\n\n';
    } else {
      md += '⚠️ **Review could not be parsed.** The AI model returned a non-structured response. Please re-run the review.\n\n';
    }
  } else {
    md += '✅ **No issues found!** Code looks good.\n\n';
  }

  if (reviewResult.positives && reviewResult.positives.length > 0) {
    md += '### ✅ Good Practices\n';
    for (const positive of reviewResult.positives) {
      md += `- ${positive}\n`;
    }
    md += '\n';
  }

  if (reviewResult.recommendations && reviewResult.recommendations.length > 0) {
    md += '### 💡 Recommendations\n';
    for (const rec of reviewResult.recommendations) {
      md += `- ${rec}\n`;
    }
    md += '\n';
  }

  md += '\n---\n*Generated by [Berean](https://github.com/rajada1/berean) 🔍*';

  return md;
}

/**
 * Render issues grouped by file for cleaner markdown output.
 */
function formatIssuesGroupedByFile(issues: ReviewIssue[]): string {
  // Separate file-specific issues from general ones
  const byFile = new Map<string, ReviewIssue[]>();
  const general: ReviewIssue[] = [];

  for (const issue of issues) {
    if (issue.file) {
      if (!byFile.has(issue.file)) byFile.set(issue.file, []);
      byFile.get(issue.file)!.push(issue);
    } else {
      general.push(issue);
    }
  }

  let md = '';

  // File-grouped issues
  for (const [file, fileIssues] of byFile) {
    md += `#### \`${file}\`\n\n`;
    for (const issue of fileIssues) {
      md += renderIssueMarkdown(issue);
    }
  }

  // General issues (no specific file)
  if (general.length > 0) {
    if (byFile.size > 0) md += '#### General\n\n';
    for (const issue of general) {
      md += renderIssueMarkdown(issue);
    }
  }

  return md;
}

function renderIssueMarkdown(issue: ReviewIssue): string {
  const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '🟡' : '🔵';

  let md = `${icon} **${issue.severity.toUpperCase()}**`;
  if (issue.category) md += ` [${issue.category}]`;
  if (issue.confidence) md += ` (${issue.confidence}%)`;
  if (issue.line) md += ` — linha ${issue.line}`;
  md += '\n';
  if (issue.title) md += `**${issue.title}**\n`;
  md += `${issue.message}\n`;

  if (issue.suggestion) {
    md += `\n\`\`\`suggestion\n${issue.suggestion}\n\`\`\`\n`;
  }

  md += '\n';
  return md;
}

function formatIssueAsMarkdown(issue: ReviewIssue): string {
  const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '🟡' : '🔵';

  let md = `${icon} **${issue.severity.toUpperCase()}**`;
  if (issue.category) md += ` [${issue.category}]`;
  if (issue.confidence) md += ` (${issue.confidence}%)`;
  md += '\n';
  if (issue.title) md += `**${issue.title}**\n`;
  md += issue.message;

  if (issue.suggestion) {
    md += `\n\n\`\`\`suggestion\n${issue.suggestion}\n\`\`\``;
  }
  return md;
}

function printReviewToTerminal(reviewResult: ReviewResult) {
  console.log('\n' + chalk.blue.bold('═'.repeat(60)));
  console.log(chalk.blue.bold(' Code Review Results'));
  console.log(chalk.blue.bold('═'.repeat(60)) + '\n');

  if (reviewResult.summary) {
    console.log(chalk.white.bold('Summary:'));
    console.log(chalk.white(reviewResult.summary) + '\n');
  }

  if (reviewResult.recommendation) {
    const recColors: Record<string, (text: string) => string> = {
      'APPROVE': chalk.green,
      'APPROVE_WITH_SUGGESTIONS': chalk.green,
      'NEEDS_CHANGES': chalk.yellow,
      'NEEDS_DISCUSSION': chalk.cyan
    };
    const recEmoji: Record<string, string> = {
      'APPROVE': '✅',
      'APPROVE_WITH_SUGGESTIONS': '✅💡',
      'NEEDS_CHANGES': '⚠️',
      'NEEDS_DISCUSSION': '💬'
    };
    const colorFn = recColors[reviewResult.recommendation] || chalk.white;
    const emoji = recEmoji[reviewResult.recommendation] || '📋';
    console.log(colorFn(`${emoji} Recommendation: ${reviewResult.recommendation.replace(/_/g, ' ')}\n`));
  }

  if (reviewResult.issues && reviewResult.issues.length > 0) {
    console.log(chalk.white.bold('Issues Found:\n'));

    // Group by file in terminal output too
    const byFile = new Map<string, ReviewIssue[]>();
    const general: ReviewIssue[] = [];
    for (const issue of reviewResult.issues) {
      if (issue.file) {
        if (!byFile.has(issue.file)) byFile.set(issue.file, []);
        byFile.get(issue.file)!.push(issue);
      } else {
        general.push(issue);
      }
    }

    const printIssue = (issue: ReviewIssue) => {
      const [icon, color] =
        issue.severity === 'critical'
          ? ['🔴', chalk.red]
          : issue.severity === 'warning'
          ? ['🟡', chalk.yellow]
          : ['🔵', chalk.blue];

      let header = `${icon} ${color.bold(issue.severity.toUpperCase())}`;
      if (issue.category) {
        header += chalk.gray(` [${issue.category}]`);
      }
      if (issue.confidence) {
        header += chalk.gray(` (${issue.confidence}%)`);
      }
      console.log(header);
      if (issue.file) console.log(chalk.gray(`   ${issue.file}${issue.line ? `:${issue.line}` : ''}`));
      if (issue.title) {
        console.log(chalk.white.bold(`   ${issue.title}`));
      }
      console.log(chalk.white(`   ${issue.message}`));
      if (issue.suggestion) console.log(chalk.green(`   Suggestion: ${issue.suggestion}`));
      console.log();
    };

    for (const [file, fileIssues] of byFile) {
      console.log(chalk.cyan.bold(`  ${file}`));
      fileIssues.forEach(printIssue);
    }
    general.forEach(printIssue);
  } else if (reviewResult.review && !reviewResult.summary) {
    console.log(reviewResult.review);
  } else {
    console.log(chalk.green('✓ No issues found! Code looks good.'));
  }

  if (reviewResult.positives && reviewResult.positives.length > 0) {
    console.log(chalk.white.bold('Good Practices:\n'));
    for (const positive of reviewResult.positives) {
      console.log(chalk.green(`  ✓ ${positive}`));
    }
    console.log();
  }

  if (reviewResult.recommendations && reviewResult.recommendations.length > 0) {
    console.log(chalk.white.bold('Recommendations:\n'));
    for (const rec of reviewResult.recommendations) {
      console.log(chalk.cyan(`  💡 ${rec}`));
    }
    console.log();
  }

  console.log(chalk.blue.bold('═'.repeat(60)));
}

async function listModels() {
  if (!isAuthenticated()) {
    console.log(chalk.red('✗ Not authenticated. Run: berean auth login'));
    process.exit(1);
  }

  const spinner = ora('Fetching available models...').start();

  try {
    const models = await fetchModels();
    spinner.succeed('Available models:\n');

    for (const model of models) {
      const defaultBadge = model.isDefault ? chalk.green(' (default)') : '';
      console.log(`  ${chalk.cyan(model.id)}${defaultBadge}`);
      if (model.name !== model.id) {
        console.log(chalk.gray(`    ${model.name}`));
      }
    }
  } catch (error) {
    spinner.fail('Failed to fetch models');
    console.log(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
    process.exit(1);
  }
}
