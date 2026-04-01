#!/usr/bin/env node
/**
 * PreToolUse Hook: Block QA Agent from Reading Source Code
 *
 * This hook only runs in qa-feature-tester context (defined in agent frontmatter).
 * No agent detection needed - we're always in QA context when this executes.
 *
 * ALLOWED: .md, .json, .yaml, .txt, configs, screenshots, reports
 *
 * BLOCKED:
 * - Extensions: .ts, .tsx, .js, .jsx, .vue, .svelte, .mjs, .cjs
 * - Directories: /src/, /components/, /hooks/, /utils/, /lib/, /services/, /routes/, /pages/, /api/
 * - Bash commands: git diff, git show, cat, head, tail (when targeting code)
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

  return `QA: BLOCKED reading ${targetPath} (${blockReason})\n\nUse Playwright to test the running app, not read source code.\nAllowed: mcp__playwright__browser_navigate, browser_snapshot, browser_click\nAllowed: curl for API testing\nAllowed: .md files for documentation`;
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
