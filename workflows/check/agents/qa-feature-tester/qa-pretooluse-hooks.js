#!/usr/bin/env node
/**
 * PreToolUse Hook: Restrict QA Agent Source Code Access
 *
 * This hook only runs in qa-feature-tester context (defined in agent frontmatter).
 * No agent detection needed - we're always in QA context when this executes.
 *
 * POLICY: No validation via code — reading code to decide PASS/FAIL is forbidden.
 * Navigation hints are allowed (route defs, configs, seeds, docs).
 *
 * ALLOWED:
 * - .md, .json, .yaml, .yml, .txt, .env files (configs, data, docs)
 * - Route definition files (routes.ts, router.ts, etc.) — for URL discovery
 * - Seed/fixture/migration files — for test data understanding
 * - Screenshots, reports, logs
 *
 * BLOCKED:
 * - General .ts/.tsx/.js/.jsx source code files (components, services, hooks, utils)
 * - git diff, git show, git blame (shows implementation)
 */

const fs = require('fs');

// Block source code file extensions
const BLOCKED_EXTENSIONS = [
  /\.tsx?$/,
  /\.jsx?$/,
  /\.vue$/,
  /\.svelte$/,
  /\.mjs$/,
  /\.cjs$/,
];

// Block glob patterns that would match code files
const BLOCKED_GLOB_PATTERNS = [
  /\*\.tsx?/,
  /\*\.jsx?/,
  /\*\.vue/,
  /\*\.svelte/,
  /\*\.mjs/,
  /\*\.cjs/,
];

// Block searches in source directories
const BLOCKED_DIRECTORIES = [
  /\/src\//,
  /\/components\//,
  /\/hooks\//,
  /\/utils\//,
  /\/lib\//,
  /\/services\//,
  /\/routes\//,
  /\/pages\//,
  /\/api\//,
];

// Source directories for Bash commands
const CODE_DIRECTORIES = [
  /\bapps\//,
  /\bpackages\//,
  /\/src\//,
  /\/components\//,
  /\/hooks\//,
  /\/utils\//,
  /\/lib\//,
  /\/services\//,
  /\/routes\//,
  /\/pages\//,
];

// Commands that can read file contents
const READ_COMMANDS = [
  /\bcat\s+/,
  /\bhead\s+/,
  /\btail\s+/,
  /\bless\s+/,
  /\bmore\s+/,
  /\bsed\s+/,
  /\bawk\s+/,
];

// Git commands that show code
const GIT_CODE_COMMANDS = [
  /\bgit\s+diff\b/,
  /\bgit\s+show\b/,
  /\bgit\s+log\s+.*-p/,
  /\bgit\s+log\s+.*--patch/,
  /\bgit\s+blame\b/,
];

// Navigation hints: allowed even if they match blocked extensions/directories
// These help QA discover URLs, ports, feature flags, and test data — not validate code
const ALLOWED_FILE_PATTERNS = [
  /routes?\.(ts|js|tsx|jsx)$/i,          // Route definitions (URL discovery)
  /router\.(ts|js|tsx|jsx)$/i,           // Router config
  /\.env/i,                               // Environment files
  /\.config\.(ts|js|mjs|cjs)$/i,         // Config files (vite, next, etc.)
  /[\\/]seeds?[\\/]/i,                      // Seed directories (test data)
  /[\\/]fixtures?[\\/]/i,                  // Fixture directories (test data)
  /[\\/]migrations?[\\/]/i,               // Migration directories (schema understanding)
  /[\\/]mocks?[\\/]/i,                    // Mock data directories
  /\.json$/i,                             // JSON data files
  /\.yaml$/i,                             // YAML config files
  /\.yml$/i,                              // YML config files
  /\.md$/i,                               // Documentation
  /\.txt$/i,                              // Text files
  /README/i,                              // README files
  /package\.json$/i,                      // Package manifest
]; // All patterns are directory-anchored or extension-specific to prevent overly broad matching

function isAllowedNavHint(filePath) {
  return ALLOWED_FILE_PATTERNS.some(p => p.test(filePath));
}

function checkFileOperation(toolName, toolInput) {
  let targetPath = '';

  if (toolName === 'Read') {
    targetPath = toolInput.file_path || '';
  } else if (toolName === 'Glob') {
    targetPath = toolInput.pattern || toolInput.path || '';
  } else if (toolName === 'Grep') {
    targetPath = toolInput.path || '';
  } else {
    return null;
  }

  // Allow navigation hint files even in blocked directories
  if (isAllowedNavHint(targetPath)) {
    return null;
  }

  const isBlockedExtension = BLOCKED_EXTENSIONS.some(p => p.test(targetPath));
  const isBlockedGlobPattern = BLOCKED_GLOB_PATTERNS.some(p => p.test(targetPath));
  const isBlockedDirectory = BLOCKED_DIRECTORIES.some(p => p.test(targetPath));

  let blockReason = null;
  if (isBlockedExtension) {
    blockReason = 'source code file extension';
  } else if (isBlockedGlobPattern) {
    blockReason = 'glob pattern that matches source code';
  } else if (isBlockedDirectory) {
    blockReason = 'source code directory';
  }

  if (!blockReason) return null;

  // Soft-block: directory is blocked but file extension is not code — warn instead of block
  if (blockReason === 'source code directory') {
    const hasBlockedExtension = BLOCKED_EXTENSIONS.some(p => p.test(targetPath));
    if (!hasBlockedExtension) {
      process.stderr.write(
        `QA: WARNING — ${targetPath} is in a source directory but doesn't have a code extension.\n` +
        `Allowing read, but remember: use Playwright to verify behavior, not code inspection.\n`
      );
      return null; // Allow through with warning
    }
  }

  return `QA: BLOCKED reading ${targetPath} (${blockReason})\n\nYou may read route/config/seed files for URL discovery, but not source code for validation.\nUse Playwright or Chrome MCP to test the running app.\nAllowed: route files, .env, .json, .yaml, .md, seed/fixture files`;
}

function checkBashCommand(toolInput) {
  const command = toolInput?.command || '';

  const isGitCodeCommand = GIT_CODE_COMMANDS.some(p => p.test(command));
  if (isGitCodeCommand) {
    return `QA: BLOCKED git command that shows code\n\nUse Playwright to test the running app instead.`;
  }

  const isReadCommand = READ_COMMANDS.some(p => p.test(command));
  const hasCodeTarget = BLOCKED_EXTENSIONS.some(p => p.test(command)) ||
                        CODE_DIRECTORIES.some(p => p.test(command));

  if (isReadCommand && hasCodeTarget) {
    return `QA: BLOCKED reading source code via Bash\n\nUse Playwright to test the running app instead.`;
  }

  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // Check file operations (Read, Glob, Grep)
  if (['Read', 'Glob', 'Grep'].includes(toolName)) {
    const result = checkFileOperation(toolName, toolInput);
    if (result) {
      process.stderr.write(result + '\n');
      process.exit(2);
    }
  }

  // Check Bash commands
  if (toolName === 'Bash') {
    const result = checkBashCommand(toolInput);
    if (result) {
      process.stderr.write(result + '\n');
      process.exit(2);
    }
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
