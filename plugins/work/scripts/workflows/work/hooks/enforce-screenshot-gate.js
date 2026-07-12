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

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { readStdin } = require(path.join(__dirname, '..', '..', 'lib', 'hookEntrypoint'));

process.on('uncaughtException', (err) => (logHookError(__filename, err), process.exit(0)));
process.on('unhandledRejection', (err) => (logHookError(__filename, err), process.exit(0)));

function loadConfigOrNull() {
  try {
    return require('../../lib/config');
  } catch (err) {
    const isConfigMiss =
      err?.code === 'MODULE_NOT_FOUND' && /['"]\.\.\/\.\.\/lib\/config['"]/.test(err.message);
    if (isConfigMiss) return null;
    throw err;
  }
}

const config = loadConfigOrNull();
if (!config) process.exit(0);

/** Exit 2 on malformed input — this fail-fast contract is pinned by tests. */
function parseInputOrExit(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`SCREENSHOT GATE: Failed to parse hook input: ${err.message}\n`);
    process.exit(2);
  }
}

function skillInputField(hookData, field) {
  return hookData.tool_input?.[field] || hookData.input?.[field] || '';
}

/** Gate only /work-pr skill invocations without --force. */
function isGatedInvocation(hookData) {
  if ((hookData.tool_name || '') !== 'Skill') return false;
  if (skillInputField(hookData, 'skill') !== 'work-pr') return false;
  return !skillInputField(hookData, 'args').includes('--force');
}

function resolveGitRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Changed non-test TSX/JSX sources vs the base branch; null when git fails
 * (the gate stands down rather than blocking on a broken repo).
 * execFileSync array args (no shell): the env-derived base branch can never
 * be parsed as a git option or shell metacharacters.
 */
function changedUiSources(gitRoot) {
  try {
    const baseBranch = config.getBaseBranch({ cwd: gitRoot });
    const diff = execFileSync(
      'git',
      ['diff', '--name-only', `${baseBranch}...HEAD`, '--', '*.tsx', '*.jsx'],
      { encoding: 'utf8', timeout: 10000, cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (!diff) return [];
    return diff
      .split('\n')
      .filter(
        (f) =>
          !f.includes('.test.') &&
          !f.includes('.spec.') &&
          !f.includes('.stories.') &&
          !f.includes('__tests__') &&
          !f.includes('.d.ts')
      );
  } catch {
    return null;
  }
}

function ticketIdFromBranch() {
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = branch.match(new RegExp(config.TICKET_PROJECT_KEY + '-\\d+'));
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function countScreenshots(tasksDir) {
  if (!tasksDir) return 0;
  const screenshotDir = path.join(tasksDir, 'screenshots');
  try {
    if (!fs.existsSync(screenshotDir)) return 0;
    const files = fs.readdirSync(screenshotDir, { recursive: true });
    return files.filter((f) => {
      const ext = path.extname(String(f)).toLowerCase();
      return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
    }).length;
  } catch {
    return 0;
  }
}

function screenshotBanner(tsxChanged, tasksDir) {
  const fileList = tsxChanged
    .slice(0, 10)
    .map((f) => `  - ${f}`)
    .join('\n');
  const moreFiles = tsxChanged.length > 10 ? `\n  ... and ${tsxChanged.length - 10} more` : '';
  return `
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
`;
}

async function main() {
  const hookData = parseInputOrExit(await readStdin());
  if (!isGatedInvocation(hookData)) process.exit(0);

  const gitRoot = resolveGitRoot();
  if (!gitRoot) process.exit(0);

  const tsxChanged = changedUiSources(gitRoot);
  if (!tsxChanged || tsxChanged.length === 0) process.exit(0);

  const ticketId = ticketIdFromBranch();
  const tasksDir = ticketId ? config.tasksDir(ticketId) : null;
  if (countScreenshots(tasksDir) > 0) process.exit(0);

  // BLOCK: TSX changed but no screenshots
  process.stderr.write(screenshotBanner(tsxChanged, tasksDir));
  process.exit(2);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0);
});
