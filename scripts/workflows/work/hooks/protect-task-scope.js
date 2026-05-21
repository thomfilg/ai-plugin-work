#!/usr/bin/env node

/**
 * PreToolUse hook — Gate D: block file writes outside the active task's
 * declared scope.
 *
 * Looks up:
 *   - Active ticket via .git/HEAD ([A-Z]+-\d+ match)
 *   - tasksDir = TASKS_BASE/safeTicketId(ticket)
 *   - .work-state.json → tasksMeta.currentTaskIndex
 *   - tasks.md → active task → filesInScope / filesOutOfScope
 *
 * For every Write / Edit / MultiEdit / NotebookEdit / Bash tool call, runs
 * the scope-protection policy. Blocks (exit 2) when:
 *   - The target path matches `filesOutOfScope` (sibling-owned), OR
 *   - The target path is not matched by any `filesInScope` glob.
 *
 * Fail-open in all error paths (missing state, parse error, missing config) —
 * agents on legitimate non-implement steps must not be blocked by this hook.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
const { decideEdit } = require(
  path.join(__dirname, '..', '..', 'lib', 'hooks', 'policies', 'scope-protection')
);
const { parseTasks } = require(path.join(__dirname, '..', '..', 'work', 'lib', 'task-parser'));

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ─── Active-ticket discovery (mirrors enforce-step-workflow.getTicketId) ────

function readGitHead(cwd) {
  try {
    const gitPath = path.join(cwd, '.git');
    const st = fs.statSync(gitPath);
    if (st.isFile()) {
      // worktree pointer
      const raw = fs.readFileSync(gitPath, 'utf8').trim();
      if (raw.startsWith('gitdir: ')) {
        const gitDir = raw.slice('gitdir: '.length);
        const headPath = path.isAbsolute(gitDir)
          ? path.join(gitDir, 'HEAD')
          : path.join(cwd, gitDir, 'HEAD');
        return fs.readFileSync(headPath, 'utf8').trim();
      }
    }
    return fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
}

function getTicketId(cwd) {
  if ('PROTECT_TASK_SCOPE_TICKET_ID' in process.env) {
    return process.env.PROTECT_TASK_SCOPE_TICKET_ID || null;
  }
  const head = readGitHead(cwd);
  if (!head) return null;
  const ref = head.startsWith('ref: ') ? head.slice(5) : head;
  const m = ref.match(/[A-Z]+-\d+/i);
  return m ? m[0] : null;
}

// ─── State + tasks resolution ───────────────────────────────────────────────

function getTasksDir(ticketId) {
  if (!ticketId) return null;
  const base = config.TASKS_BASE;
  if (!base) return null;
  const safe = typeof config.safeTicketId === 'function' ? config.safeTicketId(ticketId) : ticketId;
  return path.join(base, safe);
}

function loadWorkState(tasksDir) {
  try {
    const p = path.join(tasksDir, '.work-state.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function getActiveTask(tasksDir) {
  const ws = loadWorkState(tasksDir);
  if (!ws) return null;

  // Only enforce during the implement step. Other steps may write tasks.md,
  // brief.md, etc., and shouldn't be blocked by Gate D.
  const currentStep =
    typeof ws.currentStep === 'string'
      ? ws.currentStep
      : ws.stepStatus && Object.keys(ws.stepStatus).find((k) => ws.stepStatus[k] === 'in_progress');
  if (currentStep && currentStep !== 'implement') return { skip: true };

  const meta = ws.tasksMeta;
  if (!meta || !Array.isArray(meta.tasks)) return null;
  const idx = typeof meta.currentTaskIndex === 'number' ? meta.currentTaskIndex : 0;

  let tasks;
  try {
    tasks = parseTasks(tasksDir);
  } catch {
    return null;
  }
  if (!tasks) return null;

  const taskNum = idx + 1;
  const task = tasks.find((t) => t.num === taskNum);
  if (!task) return null;
  return {
    taskNum,
    label: `Task ${task.num}${task.title ? ' — ' + task.title : ''}`,
    filesInScope: Array.isArray(task.filesInScope) ? task.filesInScope : [],
    filesOutOfScope: Array.isArray(task.filesOutOfScope) ? task.filesOutOfScope : [],
  };
}

// ─── Bash command file-path extraction ──────────────────────────────────────
// Subset of vectors covered by createFileProtector in protect-state-files —
// we look for write redirects, tee, cp/mv targets, and node/python -e/-c
// scripts that reference target paths.

const BASH_WRITE_TOKEN =
  /(?:>>?\s*|tee(?:\s+-a)?\s+|\bof=|\bcp\s+\S+\s+|\bmv\s+\S+\s+)([^\s;|&>]+)/g;

/**
 * Characters that NEVER appear in a real file path but DO appear in shell
 * expressions, JS arrow functions, comparison operators, etc. If a captured
 * "token" contains any of these, it is not a filename — it's syntax bleed-
 * through from quoted code like `node -e "x=>y"` or `bash -c "test a > b"`.
 *
 * This prevents the gate from blocking commands whose inline interpreter
 * code happens to contain `>` (arrow functions, comparators, redirects
 * inside quoted strings).
 */
const NON_PATH_CHAR = /[()=+{}[\]<>$`!*?]/;

function looksLikePath(token) {
  if (!token) return false;
  if (NON_PATH_CHAR.test(token)) return false;
  // Reject pure-numeric tokens (file descriptors after redirects like `2>&1`
  // get caught here even though `>` is excluded above) and dot/dotdot.
  if (/^\d+$/.test(token)) return false;
  if (token === '.' || token === '..') return false;
  return true;
}

/**
 * Strip the body of single- and double-quoted strings before scanning so
 * shell operators inside `"..."` or `'...'` don't trigger false positives.
 * This is intentionally approximate (no shell escape handling, no `$(...)`
 * nesting) — the hook fails open and the protect-state-files protector
 * still catches real bypass attempts via Vector 2/3/4.
 */
function stripQuotedStrings(cmd) {
  return String(cmd || '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function extractBashWriteTargets(cmd) {
  if (!cmd || typeof cmd !== 'string') return [];
  const out = new Set();
  const scanCmd = stripQuotedStrings(cmd);
  BASH_WRITE_TOKEN.lastIndex = 0;
  let m;
  while ((m = BASH_WRITE_TOKEN.exec(scanCmd)) !== null) {
    const tok = (m[1] || '').replace(/^["']|["']$/g, '');
    if (!tok || tok.startsWith('-')) continue;
    if (!looksLikePath(tok)) continue;
    out.add(tok);
  }
  return Array.from(out);
}

// ─── Main hook ──────────────────────────────────────────────────────────────

function evaluateTool(toolName, toolInput, active, workDir) {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const filePath = toolInput && toolInput.file_path;
    if (!filePath) return null;
    return decideEdit({
      filePath,
      workDir,
      filesInScope: active.filesInScope,
      filesOutOfScope: active.filesOutOfScope,
      activeTask: active.label,
    });
  }
  if (toolName === 'Bash') {
    const cmd = toolInput && toolInput.command;
    if (!cmd) return null;
    const targets = extractBashWriteTargets(String(cmd));
    for (const tgt of targets) {
      const d = decideEdit({
        filePath: tgt,
        workDir,
        filesInScope: active.filesInScope,
        filesOutOfScope: active.filesOutOfScope,
        activeTask: active.label,
      });
      if (d.blocked) return d;
    }
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    process.exit(0); // fail-open
  }

  const cwd = process.cwd();
  const ticketId = getTicketId(cwd);
  if (!ticketId) process.exit(0); // no /work context

  const tasksDir = getTasksDir(ticketId);
  if (!tasksDir || !fs.existsSync(tasksDir)) process.exit(0);

  const active = getActiveTask(tasksDir);
  if (!active || active.skip) process.exit(0);
  if (active.filesInScope.length === 0 && active.filesOutOfScope.length === 0) process.exit(0);

  const decision = evaluateTool(hookData.tool_name || '', hookData.tool_input || {}, active, cwd);
  if (decision && decision.blocked) {
    process.stderr.write(decision.reason + '\n');
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    try {
      logHookError(__filename, err);
    } catch {
      /* swallow */
    }
    process.exit(0);
  });
}

module.exports = { evaluateTool, extractBashWriteTargets, getTicketId, getActiveTask };
