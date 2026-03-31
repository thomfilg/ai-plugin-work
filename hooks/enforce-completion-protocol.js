#!/usr/bin/env node

/**
 * Stop hook to enforce Task Completion Protocol
 *
 * Blocks Claude from declaring tasks complete without proper verification:
 * - Lint/typecheck output (for code changes)
 * - Test output (for code changes)
 * - requirements-verifier agent called
 * - Functional testing evidence (for config changes)
 *
 * Dynamically determines required checks based on files modified.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logHookError } = require(path.join(__dirname, '..', 'lib', 'hook-error-log'));

// Completion phrases to detect
const COMPLETION_PHRASES = [
  /\bimplementation\s+(?:is\s+)?complete/i,
  /\btask\s+(?:is\s+)?complete/i,
  /\bwork\s+(?:is\s+)?complete/i,
  /\ball\s+(?:tasks?\s+)?(?:are\s+)?done/i,
  /\bfinished\s+(?:the\s+)?implementation/i,
  /\bcompleted\s+(?:the\s+)?(?:task|work|implementation)/i,
  /\btask\s+(?:has\s+been\s+)?finished/i,
  /\bchanges\s+(?:are\s+)?complete/i,
  /\bready\s+for\s+review/i,
  /\bready\s+to\s+(?:merge|commit|push)/i,
  /\bI(?:'ve|'m)\s+(?:now\s+)?(?:done|finished|completed)/i,
  /\bthat\s+(?:completes?|finishes?)/i,
  /\bthe\s+(?:feature|fix|change|documentation|update)\s+is\s+(?:now\s+)?(?:complete|done|ready)/i,
  /\bdocumentation\s+(?:is\s+)?(?:complete|done|updated)/i,
  /\bupdates?\s+(?:are\s+)?(?:complete|done)/i,
  /\bthis\s+(?:is\s+)?(?:complete|done|finished)/i,
  /\beverything\s+(?:is\s+)?(?:complete|done|ready)/i,
  /\b(?:code|feature|fix)\s+(?:is\s+)?(?:complete|done|ready)/i,
];

// Phrases that indicate ongoing work (NOT completion)
const ONGOING_PHRASES = [
  /\blet\s+me\s+(?:now\s+)?(?:run|check|verify|test)/i,
  /\bnow\s+(?:I(?:'ll|'m going to))\s+(?:run|check|verify|test)/i,
  /\bI(?:'ll|'m going to)\s+(?:run|verify|check)/i,
  /\bstarting\s+(?:to\s+)?(?:run|check|verify)/i,
  /\bmarking.*(?:in.progress|pending)/i,
  /\bnext\s+(?:step|I(?:'ll|'m going to))/i,
  /\bcontinue\s+(?:by|with|to)/i,
];

// File extensions and their categories
const FILE_CATEGORIES = {
  code: ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.cs', '.php', '.rb'],
  config: ['vite.config', 'webpack.config', 'tsconfig', 'eslint', 'prettier', 'jest.config', 'vitest.config'],
  docs: ['.md', '.mdx', '.txt', '.rst'],
  ci: ['.yml', '.yaml', '.github'],
  test: ['.test.', '.spec.', '__tests__', 'test/', 'tests/'],
  migration: ['migration/', 'migrations/'],
};

// Required checks by category
const REQUIRED_CHECKS = {
  code: ['lint', 'typecheck', 'test', 'requirements-verifier', 'steps-done'],
  config: ['lint', 'typecheck', 'functional-test', 'requirements-verifier', 'steps-done'],
  docs: ['requirements-verifier', 'steps-done'],
  ci: ['requirements-verifier', 'steps-done'],
  test: ['lint', 'typecheck', 'test', 'requirements-verifier', 'steps-done'],
  migration: ['migration-test', 'requirements-verifier', 'steps-done'],
};

/**
 * Check if a file path is inside a git repository
 */
function isInsideGitRepo(filePath) {
  try {
    const dirPath = path.dirname(filePath);
    // Check if directory exists
    if (!fs.existsSync(dirPath)) {
      return false;
    }
    // Try to run git rev-parse to check if we're in a git repo
    execSync('git rev-parse --git-dir', { cwd: dirPath, stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Categorize a file based on its path/extension
 */
function categorizeFile(filePath) {
  const lowerPath = filePath.toLowerCase();

  // Check for migration files first
  if (FILE_CATEGORIES.migration.some(pattern => lowerPath.includes(pattern))) {
    return 'migration';
  }

  // Check for test files
  if (FILE_CATEGORIES.test.some(pattern => lowerPath.includes(pattern))) {
    return 'test';
  }

  // Check for CI files
  if (FILE_CATEGORIES.ci.some(pattern => lowerPath.includes(pattern))) {
    return 'ci';
  }

  // Check for docs
  if (FILE_CATEGORIES.docs.some(ext => lowerPath.endsWith(ext))) {
    return 'docs';
  }

  // Check for config files
  if (FILE_CATEGORIES.config.some(pattern => lowerPath.includes(pattern))) {
    return 'config';
  }

  // Check for code files
  if (FILE_CATEGORIES.code.some(ext => lowerPath.endsWith(ext))) {
    return 'code';
  }

  return 'other';
}

/**
 * Determine what checks are required based on modified files
 */
function determineRequiredChecks(modifiedFiles) {
  const categories = new Set();

  for (const file of modifiedFiles) {
    categories.add(categorizeFile(file));
  }

  // Aggregate required checks
  const checks = new Set();

  for (const category of categories) {
    const categoryChecks = REQUIRED_CHECKS[category] || [];
    for (const check of categoryChecks) {
      checks.add(check);
    }
  }

  // If we have any code/config, add lint/typecheck
  if (categories.has('code') || categories.has('config') || categories.has('test')) {
    checks.add('lint');
    checks.add('typecheck');
  }

  // Always require requirements-verifier for non-trivial changes
  if (modifiedFiles.length > 0 && !categories.has('other')) {
    checks.add('requirements-verifier');
  }

  return Array.from(checks);
}

/**
 * Parse transcript and extract relevant information
 */
function parseTranscript(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) {
    return { modifiedFiles: [], checks: {} };
  }

  const content = fs.readFileSync(transcriptPath, 'utf8');
  const lines = content.trim().split('\n');

  const modifiedFiles = new Set();
  const checks = {
    lint: false,
    typecheck: false,
    test: false,
    'functional-test': false,
    'migration-test': false,
    'requirements-verifier': false,
    'code-checker': false,
    'steps-done': false,  // Always marked as done if we got this far (assistant is declaring completion)
  };

  // Evidence patterns
  const lintPatterns = [
    /pnpm\s+lint/i,
    /npm\s+run\s+lint/i,
    /eslint/i,
    /0\s+(?:errors?|warnings?)/i,
    /no\s+(?:lint\s+)?(?:errors?|issues?)/i,
  ];

  const typecheckPatterns = [
    /pnpm\s+typecheck/i,
    /npm\s+run\s+typecheck/i,
    /tsc/i,
    /no\s+(?:type\s*)?errors?/i,
    /type\s*check(?:ing)?\s+(?:passed|succeeded|complete)/i,
  ];

  const testPatterns = [
    /pnpm\s+test/i,
    /npm\s+run\s+test/i,
    /vitest/i,
    /jest/i,
    /tests?\s+passed/i,
    /\d+\s+passed/i,
  ];

  const migrationPatterns = [
    /pnpm\s+run\s+migration/i,
    /npm\s+run\s+migration/i,
    /migration:(?:up|down|run|test)/i,
    /db:migrate/i,
    /migrate(?::\w+)?/i,
  ];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msgContent = entry.message?.content;

      if (!msgContent) continue;

      // Convert to string for pattern matching
      const contentStr = typeof msgContent === 'string' ? msgContent : JSON.stringify(msgContent);

      // Check for modified files from Edit/Write tool calls
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block.type === 'tool_use') {
            if (block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') {
              const filePath = block.input?.file_path || block.input?.path;
              if (filePath) {
                modifiedFiles.add(filePath);
              }
            }

            // Check for requirements-verifier agent call
            if (block.name === 'Task' && block.input?.subagent_type) {
              const agentType = block.input.subagent_type.toLowerCase();
              if (agentType.includes('requirements') || agentType.includes('verifier') || agentType.includes('completion-checker')) {
                checks['requirements-verifier'] = true;
              }
              if (agentType.includes('code-checker') || agentType.includes('quality')) {
                checks['code-checker'] = true;
              }
            }

            // Check for quality check commands
            if (block.name === 'Bash' && block.input?.command) {
              const cmd = block.input.command;

              if (lintPatterns.some(p => p.test(cmd))) {
                checks.lint = true;
              }
              if (typecheckPatterns.some(p => p.test(cmd))) {
                checks.typecheck = true;
              }
              if (testPatterns.some(p => p.test(cmd))) {
                checks.test = true;
              }
              if (migrationPatterns.some(p => p.test(cmd))) {
                checks['migration-test'] = true;
              }
            }
          }
        }
      }

      // Also check tool results for success indicators
      if (entry.type === 'tool_result') {
        const resultStr = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content || '');

        if (lintPatterns.some(p => p.test(resultStr))) {
          checks.lint = true;
        }
        if (typecheckPatterns.some(p => p.test(resultStr))) {
          checks.typecheck = true;
        }
        if (testPatterns.some(p => p.test(resultStr))) {
          checks.test = true;
        }
      }

    } catch (e) {
      // Skip malformed lines
    }
  }

  return {
    modifiedFiles: Array.from(modifiedFiles),
    checks,
  };
}

/**
 * Check if the assistant message contains completion language
 */
function containsCompletionLanguage(message) {
  // First check for ongoing work phrases (not completion)
  for (const pattern of ONGOING_PHRASES) {
    if (pattern.test(message)) {
      return false;
    }
  }

  // Then check for completion phrases
  for (const pattern of COMPLETION_PHRASES) {
    if (pattern.test(message)) {
      return true;
    }
  }

  return false;
}

/**
 * Get the last assistant message from hook data
 */
function getAssistantMessage(hookData) {
  // Check the assistant_message field
  if (hookData.assistant_message) {
    const content = hookData.assistant_message.content;
    return typeof content === 'string' ? content : JSON.stringify(content || '');
  }

  // Fallback to reading from transcript
  if (hookData.transcript_path && fs.existsSync(hookData.transcript_path)) {
    const content = fs.readFileSync(hookData.transcript_path, 'utf8');
    const lines = content.trim().split('\n');

    // Get last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' || entry.message?.role === 'assistant') {
          const msgContent = entry.message?.content;
          return typeof msgContent === 'string' ? msgContent : JSON.stringify(msgContent || '');
        }
      } catch (e) {}
    }
  }

  return '';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (e) {
    process.exit(0);
  }

  // Prevent infinite loops
  if (hookData.stop_hook_active) {
    process.exit(0);
  }

  // Get the assistant message
  const assistantMessage = getAssistantMessage(hookData);

  // Check if message contains completion language
  if (!containsCompletionLanguage(assistantMessage)) {
    process.exit(0);
  }

  // Parse transcript for evidence
  const transcriptPath = hookData.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  const { modifiedFiles: allModifiedFiles, checks } = parseTranscript(transcriptPath);

  // Filter to only files inside git repositories
  const modifiedFiles = allModifiedFiles.filter(f => isInsideGitRepo(f));

  // If no files modified in git repos, allow completion
  if (modifiedFiles.length === 0) {
    process.exit(0);
  }

  // Determine required checks based on files modified
  const requiredChecks = determineRequiredChecks(modifiedFiles);

  // Filter out checks that aren't required for docs-only changes
  const allDocs = modifiedFiles.every(f => categorizeFile(f) === 'docs');
  if (allDocs) {
    // For docs-only, just need requirements-verifier
    const docsRequired = requiredChecks.filter(c => c === 'requirements-verifier');
    requiredChecks.length = 0;
    requiredChecks.push(...docsRequired);
  }

  // Determine what categories of files we have
  const hasCodeFiles = modifiedFiles.some(f => {
    const cat = categorizeFile(f);
    return cat === 'code' || cat === 'test' || cat === 'config';
  });
  const hasMigrationFiles = modifiedFiles.some(f => categorizeFile(f) === 'migration');

  // Build the checklist items with status
  const checklist = [];

  // Lint (if code)
  if (hasCodeFiles) {
    const status = checks.lint ? '[x]' : '[ ]';
    checklist.push(`${status} lint only on changed files (code changes detected)`);
  }

  // Typecheck (if code)
  if (hasCodeFiles) {
    const status = checks.typecheck ? '[x]' : '[ ]';
    checklist.push(`${status} typecheck only on changed files (code changes detected)`);
  }

  // Tests (if code)
  if (hasCodeFiles) {
    const status = checks.test ? '[x]' : '[ ]';
    checklist.push(`${status} tests only on changed files (code changes detected)`);
  }

  // Migration test (if migration files changed)
  if (hasMigrationFiles) {
    const status = checks['migration-test'] ? '[x]' : '[ ]';
    checklist.push(`${status} tested migration with appropriate command (migration/** changed)`);
  }

  // Requirements verifier (always)
  const reqStatus = checks['requirements-verifier'] ? '[x]' : '[ ]';
  checklist.push(`${reqStatus} req verifier (always required)`);

  // Steps done (always - will be shown but we don't track this automatically)
  checklist.push(`[ ] steps done to achieve (always required - describe what you did)`);

  // Check what's actually missing
  const missing = [];

  if (hasCodeFiles && !checks.lint) {
    missing.push('lint');
  }
  if (hasCodeFiles && !checks.typecheck) {
    missing.push('typecheck');
  }
  if (hasCodeFiles && !checks.test) {
    missing.push('tests');
  }
  if (hasMigrationFiles && !checks['migration-test']) {
    missing.push('migration test');
  }
  if (!checks['requirements-verifier']) {
    missing.push('requirements verifier');
  }

  if (missing.length > 0) {
    const fileCategories = modifiedFiles.map(f => `  - ${f} (${categorizeFile(f)})`).join('\n');

    process.stderr.write(`BLOCKED: Task Completion Protocol Violation\n\nYou declared the task complete, but verification is missing!\n\nFiles Modified:\n${fileCategories}\n\nVerification Checklist:\n${checklist.join('\n')}\n\nMissing: ${missing.join(', ')}\n\nREQUIRED: Complete all unchecked items above, then declare the task done.\n`);
    process.exit(2);
  }

  // All checks passed
  process.exit(0);
}

main().catch(err => {
  logHookError(__filename, err);
  process.exit(0);
});
