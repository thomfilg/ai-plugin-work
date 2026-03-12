#!/usr/bin/env node

/**
 * Enforce screenshot requirement for UI changes.
 *
 * PreToolUse on Task/Skill:
 *   If TSX/JSX source files changed vs base branch and no screenshots
 *   exist in the tasks folder, BLOCK QA-completing agents and skills.
 *
 * PostToolUse on AskUserQuestion:
 *   If user chose to skip, writes skip marker to unblock.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MARKER_DIR = '/tmp';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Per-process cache to avoid re-fetching/re-diffing within same invocation
let _cachedTsxChanges = undefined;
let _cachedRepoRoot = undefined;

function getRepoRoot() {
  if (_cachedRepoRoot !== undefined) return _cachedRepoRoot;
  try {
    _cachedRepoRoot = execSync('git rev-parse --show-toplevel 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch {
    _cachedRepoRoot = null;
  }
  return _cachedRepoRoot;
}

function getScreenshotDir(ticketId) {
  const repoRoot = getRepoRoot();
  if (repoRoot) {
    return path.join(path.dirname(repoRoot), 'tasks', ticketId, 'screenshots');
  }
  // Fallback: use cwd parent
  return path.join(process.cwd(), '..', 'tasks', ticketId, 'screenshots');
}

function getTicketId() {
  try {
    const branch = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf8' }).trim();
    const match = branch.match(/[A-Z]+-\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function skipMarkerPath(ticketId) {
  return path.join(MARKER_DIR, `check-skip-screenshots-${ticketId}`);
}

/**
 * Resolve the base branch ref. Fetches default branch refs, then probes candidates.
 * Returns the ref string or null if none found.
 */
function resolveBaseRef() {
  try {
    execSync('git fetch origin --depth=1 2>/dev/null', { timeout: 15000 });
  } catch { /* offline or no remote */ }

  const candidates = ['origin/main', 'origin/HEAD', 'main', 'master'];
  for (const ref of candidates) {
    try {
      execSync(`git rev-parse --verify ${ref} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
      return ref;
    } catch { /* try next */ }
  }
  return null;
}

function hasTsxChanges() {
  if (_cachedTsxChanges !== undefined) return _cachedTsxChanges;

  const baseRef = resolveBaseRef();
  if (!baseRef) {
    _cachedTsxChanges = true; // fail closed
    return true;
  }

  try {
    const diff = execSync(`git diff --name-only ${baseRef}...HEAD -- "*.tsx" "*.jsx" 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 10000
    }).trim();
    if (!diff) {
      _cachedTsxChanges = false;
      return false;
    }
    _cachedTsxChanges = diff.split('\n').some(f =>
      !f.includes('.test.') &&
      !f.includes('.spec.') &&
      !f.includes('.stories.') &&
      !f.includes('__tests__') &&
      !f.includes('.d.ts')
    );
    return _cachedTsxChanges;
  } catch {
    _cachedTsxChanges = true; // fail closed
    return true;
  }
}

/**
 * Stack-based recursive directory walk for screenshot detection.
 * Compatible with Node < 18.17 (no recursive readdirSync needed).
 */
function hasScreenshots(ticketId) {
  const root = getScreenshotDir(ticketId);
  try {
    if (!fs.existsSync(root)) return false;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          stack.push(path.join(dir, ent.name));
        } else if (IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function blockIfNoScreenshots(hookData) {
  const ticketId = getTicketId();
  if (!ticketId) return;
  if (fs.existsSync(skipMarkerPath(ticketId))) return;
  if (!hasTsxChanges()) return;
  if (hasScreenshots(ticketId)) return;

  const toolName = hookData.tool_name || '';
  const prompt = (hookData.tool_input?.prompt || '').toLowerCase();
  const skill = (hookData.tool_input?.skill || '').toLowerCase();
  const subagentType = hookData.tool_input?.subagent_type || '';
  const normalizedSubagentType = subagentType.replace(/^work-workflow:/, '');

  const isQaAgent = toolName === 'Task' && (
    normalizedSubagentType === 'qa-feature-tester' ||
    normalizedSubagentType === 'pr-generator' ||
    normalizedSubagentType === 'pr-post-generator' ||
    /screenshot|qa.*report/i.test(prompt)
  );

  const isCompletingSkill = toolName === 'Skill' && (
    /work-pr|check-qa|check-browser/i.test(skill)
  );

  if (!isQaAgent && !isCompletingSkill) return;

  const screenshotDir = getScreenshotDir(ticketId);
  process.stderr.write(
    'BLOCKED: TSX/JSX files changed but NO screenshots found in ' +
    `${screenshotDir}/. ` +
    'You MUST capture screenshots before completing QA or creating a PR. ' +
    'Call AskUserQuestion with options: ' +
    '"Capture screenshots now" (use Playwright to take screenshots) | ' +
    '"Skip screenshots" (continue without, mark as SKIPPED) | ' +
    '"Abort" (stop workflow). ' +
    'Do NOT proceed without user input.\n'
  );
  process.exit(2);
}

function unblockAfterChoice(hookData) {
  const ticketId = getTicketId();
  if (!ticketId) return;
  if (hasScreenshots(ticketId)) return;
  if (!hasTsxChanges()) return;

  const output = hookData.tool_output ?? hookData.tool_result ?? hookData.tool_response ?? '';
  const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

  const choseSkip = /skip/i.test(outputStr) && /screenshot/i.test(outputStr);
  if (choseSkip) {
    fs.writeFileSync(skipMarkerPath(ticketId), JSON.stringify({
      ticketId,
      timestamp: new Date().toISOString()
    }));
    process.stderr.write('Skip-screenshots marker written. Workflow unblocked.\n');
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const hookType = process.env.CLAUDE_HOOK_TYPE || 'PostToolUse';
  const toolName = hookData.tool_name || '';

  if (hookType === 'PreToolUse' && (toolName === 'Task' || toolName === 'Skill')) {
    blockIfNoScreenshots(hookData);
  } else if (hookType === 'PostToolUse' && toolName === 'AskUserQuestion') {
    unblockAfterChoice(hookData);
  }
}

main().catch(() => {});
