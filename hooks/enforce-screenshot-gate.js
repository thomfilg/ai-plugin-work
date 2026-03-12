#!/usr/bin/env node

/**
 * PostToolUse hook (Skill: work-pr) — Screenshot Gate
 *
 * After /work-pr completes, checks if:
 *   1. TSX/JSX source files (not test files) were changed vs origin/main
 *   2. No screenshot files exist in the tasks folder
 *
 * If both true, blocks and requires screenshots before marking complete.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let didBlock = false;
process.on('uncaughtException', () => process.exit(didBlock ? 2 : 0));
process.on('unhandledRejection', () => process.exit(didBlock ? 2 : 0));

let config;
try {
  config = require('../lib/config');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\.\/lib\/config['"]/.test(err.message)) {
    config = null;
  } else {
    throw err;
  }
}
if (!config) process.exit(0);

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    process.stderr.write(`SCREENSHOT GATE: Failed to parse hook input: ${err.message}\n`);
    didBlock = true;
    process.exit(2);
  }

  // Only run for work-pr skill
  const toolName = hookData.tool_name || '';
  const skillName = hookData.tool_input?.skill || hookData.input?.skill || '';

  if (toolName !== 'Skill' || skillName !== 'work-pr') {
    process.exit(0);
  }

  // Check if --force was passed as args
  const skillArgs = hookData.tool_input?.args || hookData.input?.args || '';
  if (skillArgs.includes('--force')) {
    process.exit(0);
  }

  // Get the current working directory / git root
  let gitRoot;
  try {
    gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    process.exit(0);
  }

  // Check for TSX/JSX source file changes (exclude test files)
  let tsxChanged = [];
  try {
    const diff = execSync('git diff --name-only origin/main...HEAD -- "*.tsx" "*.jsx"', {
      encoding: 'utf8',
      timeout: 10000,
      cwd: gitRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (diff) {
      tsxChanged = diff.split('\n').filter(f =>
        !f.includes('.test.') &&
        !f.includes('.spec.') &&
        !f.includes('.stories.') &&
        !f.includes('__tests__') &&
        !f.includes('.d.ts')
      );
    }
  } catch {
    process.exit(0);
  }

  // No UI source files changed — no screenshots required
  if (tsxChanged.length === 0) {
    process.exit(0);
  }

  // Extract ticket ID from branch name
  let ticketId;
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const match = branch.match(new RegExp(config.TICKET_PROJECT_KEY + '-\\d+'));
    ticketId = match ? match[0] : null;
  } catch {
    ticketId = null;
  }

  // Check for screenshots in tasks folder
  const tasksDir = ticketId ? config.tasksDir(ticketId) : null;
  let screenshotCount = 0;

  if (tasksDir) {
    const screenshotDir = path.join(tasksDir, 'screenshots');
    try {
      if (fs.existsSync(screenshotDir)) {
        const files = fs.readdirSync(screenshotDir, { recursive: true });
        screenshotCount = files.filter(f => {
          const ext = path.extname(String(f)).toLowerCase();
          return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
        }).length;
      }
    } catch {
      // ignore
    }
  }

  if (screenshotCount > 0) {
    process.exit(0);
  }

  // BLOCK: TSX changed but no screenshots
  const fileList = tsxChanged.slice(0, 10).map(f => `  - ${f}`).join('\n');
  const moreFiles = tsxChanged.length > 10 ? `\n  ... and ${tsxChanged.length - 10} more` : '';

  process.stderr.write(`
╔══════════════════════════════════════════════════════════════════════╗
║  📸 SCREENSHOT GATE: UI changes require visual documentation         ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  /work-pr completed but TSX/JSX source files were modified           ║
║  without screenshots.                                                ║
║                                                                      ║
║  Changed UI files:                                                   ║
${fileList}${moreFiles}
║                                                                      ║
║  REQUIRED before marking PR complete:                                ║
║    1. Run /check-qa or /check-browser to capture screenshots         ║
║    2. Or add screenshots to:                                         ║
║       ${tasksDir ? tasksDir + '/screenshots/' : 'tasks/<TICKET>/screenshots/'}
║    3. Then re-run /work-pr to update the PR                          ║
║                                                                      ║
║  To bypass (non-visual TSX changes only):                            ║
║    /work-pr <TICKET> --force                                         ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`);
  didBlock = true;
  process.exit(2);
}

main().catch(() => process.exit(didBlock ? 2 : 0));
