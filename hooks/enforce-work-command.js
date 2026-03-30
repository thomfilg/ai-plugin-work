#!/usr/bin/env node

/**
 * PreToolUse hook: Enforce /work workflow via file-based state.
 *
 * Blocks Edit/Write/MultiEdit when a work-state folder exists for the
 * current branch, meaning /work has been initiated and should manage edits.
 *
 * State directory: $HOME/.claude/work-state/<branch-name>/
 * Transition file: $HOME/.claude/work-state/<branch-name>/active
 *
 * The /work command creates the state folder. This hook enforces it.
 * No state folder = no enforcement (free edits allowed).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORK_STATE_DIR = path.join(process.env.HOME, '.claude', 'work-state');

// Files allowed without /work (config/non-code files)
const ALLOWED_PATTERNS = [
  /\.md$/,
  /\.json$/,
  /\.ya?ml$/,
  /\.env/,
  /\.gitignore$/,
  /\.eslintrc/,
  /\.prettierrc/,
  /package\.json$/,
  /tsconfig/,
  /\/home\/node\/worktrees\/tasks\//,
  /\.task-/,
  /\.claude\//,
  /plan[-_]?\w*\./i,
];

const WORK_PATTERNS = [
  /<command-name>\/work<\/command-name>/,
  /"skill"\s*:\s*"work"/,
];

function getCurrentBranch() {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function hasWorkStateFile(branch) {
  if (!branch) return false;
  const stateFile = path.join(WORK_STATE_DIR, branch, 'active');
  return fs.existsSync(stateFile);
}

function isWorkActiveInTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    return WORK_PATTERNS.some(p => p.test(content));
  } catch {
    return false;
  }
}

function isFileAllowed(filePath) {
  if (!filePath) return false;
  return ALLOWED_PATTERNS.some(p => p.test(filePath));
}

function hasSkipWorkBypass(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    return /no \/work|skip \/work/i.test(content);
  } catch {
    return false;
  }
}

function isInsideSubagent(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const agentTypes = [
      'developer-nodejs-tdd',
      'developer-react-senior',
      'developer-react-ui-architect',
      'developer-devops',
      ...(process.env.WORK_ARCHITECT_ENABLED === '1' ? ['code-architect'] : []),
      'code-checker',
      'commit-writer',
      'pr-generator',
    ];
    for (const agent of agentTypes) {
      if (new RegExp(`^name:\\s*${agent}`, 'm').test(content)) return true;
      if (new RegExp(`"subagent_type"\\s*:\\s*"(work-workflow:)?${agent}"`, 'i').test(content)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolInput = hookData.tool_input || {};
  const transcriptPath = hookData.transcript_path;
  const filePath = toolInput.file_path || toolInput.path || '';

  // 1. Get current branch
  const branch = getCurrentBranch();
  if (!branch) {
    process.exit(0);
  }

  // 2. Only enforce if work-state folder exists for this branch
  if (!hasWorkStateFile(branch)) {
    process.exit(0);
  }

  // 3. Allow config/non-code files
  if (isFileAllowed(filePath)) {
    process.exit(0);
  }

  // 4. Allow if /work is active in this session
  if (isWorkActiveInTranscript(transcriptPath)) {
    process.exit(0);
  }

  // 5. Allow inside subagents
  if (isInsideSubagent(transcriptPath)) {
    process.exit(0);
  }

  // 6. Escape hatch
  if (hasSkipWorkBypass(transcriptPath)) {
    process.exit(0);
  }

  // Block — work-state exists but /work not active in this session
  process.stderr.write(`╔══════════════════════════════════════════════════════════════════════╗
║  ⚠️  /work workflow is managing this branch                          ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  Branch: ${branch.padEnd(58)}║
║  Direct code edits are blocked — use /work to continue.             ║
║                                                                      ║
║  Options:                                                            ║
║    /work <ticket>        Resume the orchestrated workflow            ║
║    "skip /work"          Bypass enforcement for this session         ║
║                                                                      ║
║  /work ensures: Jira transitions, quality checks, code review,      ║
║  requirements verification, and proper PR generation.                ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`);
  process.exit(2);
}

main().catch(err => {
  console.error('Hook error:', err.message);
  process.exit(0);
});
