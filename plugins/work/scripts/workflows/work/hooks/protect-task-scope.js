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
 * Escape hatches (GH-392 Task 8 + follow-up):
 *   1. Env var PAIR — `PROTECT_TASK_SCOPE_BYPASS_REASON` AND
 *      `PROTECT_TASK_SCOPE_BYPASS_TARGET` must BOTH be set, AND
 *      `WORK_OPERATOR_TOKEN=1` must also be present in the environment
 *      (GH-528 round-2 follow-up ITEM 1). The bypass only fires when the
 *      relativized target matches `BYPASS_TARGET` exactly OR via the same
 *      `findMatch` glob logic used elsewhere (so glob patterns like
 *      `src/shared/**` are honoured). One-shot by design: REASON alone opens
 *      a hole for any path; pairing it with TARGET pins the bypass to a
 *      single planned edit. When fired, appends a `scope-bypass` audit row
 *      via `appendEnforcementAudit` (spec §P0#6) carrying both the configured
 *      TARGET and the actual write path.
 *
 *      WORK_OPERATOR_TOKEN gate (GH-528 round-2 ITEM 1): bypass env vars
 *      inherit into every child process the agent spawns, so an agent that
 *      can set REASON+TARGET in its own shell would otherwise be able to
 *      flip the bypass on without operator intent. The token is an
 *      operator-only env var (same pattern as the `exception` subcommand
 *      in tdd-phase-state.js) that the agent's harness never carries. When
 *      the token is missing AND REASON+TARGET match the write target, the
 *      hook treats the env pair as unset (block stays) and appends a
 *      `scope-bypass-rejected` audit row carrying the configured target
 *      and reason — so the rejected attempt is visible without trusting
 *      caller-supplied state.
 *   2. `### Cross-Task Dependencies` — paths in the active task's
 *      `crossTaskDeps` list bypass the would-be block and append a
 *      `cross-task-dep-allow` audit row (spec §P0#7b).
 *
 * Security: bypass paths fail closed on missing ticket identity (no ticket →
 * no bypass; the early `if (!ticketId) process.exit(0)` rejects un-scoped
 * invocations before either escape hatch is evaluated).
 *
 * Fail-open in all error paths (missing state, parse error, missing config) —
 * agents on legitimate non-implement steps must not be blocked by this hook.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
const { decideEdit, relativizePath, findMatch } = require(
  path.join(__dirname, '..', '..', 'lib', 'hooks', 'policies', 'scope-protection')
);
const { parseTasks } = require(path.join(__dirname, '..', '..', 'work', 'lib', 'task-parser'));
const { matchesTypeScope, scopeRulesFor, isTestFilePath } = require(
  path.join(__dirname, '..', '..', '..', '..', 'skills', 'split-in-tasks', 'lib', 'task-types')
);
const { appendEnforcementAudit } = require(
  path.join(__dirname, '..', '..', 'work', 'lib', 'work-actions')
);

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// GH-528 round-2 ITEM 1: WORK_OPERATOR_TOKEN gate on env-bypass.
// Centralised so all three bypass call sites stay in lockstep.
function isOperatorTokenPresent() {
  return process.env.WORK_OPERATOR_TOKEN === '1';
}

/**
 * Append a `scope-bypass-rejected` audit row recording that the env-var pair
 * matched the write target but WORK_OPERATOR_TOKEN was missing. We log this
 * regardless of guard so an operator can see every rejected attempt across
 * the three layers.
 */
function auditScopeBypassRejected({
  ticketId,
  active,
  relTarget,
  bypassReason,
  bypassTargetCfg,
  guard,
}) {
  try {
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: active.taskNum,
      phase: null,
      action: 'scope-bypass-rejected',
      allow: false,
      reason: bypassReason,
      outputPath: relTarget,
      meta: {
        taskNum: active.taskNum,
        target: relTarget,
        configuredTarget: bypassTargetCfg,
        guard,
        rejectReason: 'WORK_OPERATOR_TOKEN missing',
      },
    });
  } catch (err) {
    try {
      logHookError(__filename, err);
    } catch {
      /* swallow */
    }
  }
}

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
    // GH-392 Task 8 / spec §P0#7b: cross-task allow-list. Files declared here
    // are out of the task's primary scope but are legitimately needed (owned
    // by sibling tasks). decideEdit blocks would be overridden to exit 0 with
    // a `cross-task-dep-allow` audit row.
    crossTaskDeps: Array.isArray(task.crossTaskDeps) ? task.crossTaskDeps : [],
    // GH-528 item 5: per-Type allowlist layer. tdd-code / checkpoint /
    // mechanical-refactor / file-move keep existing behavior (no per-Type
    // restriction beyond the filesInScope/filesOutOfScope check). The
    // closed-allowlist types (tests-only, docs, config, ci) additionally
    // require the write target to match their per-Type pattern set in
    // skills/split-in-tasks/lib/task-types.js.
    type: typeof task.type === 'string' ? task.type : '',
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

// ─── GH-528 item 5: per-Type allowlist + Type-line edit guard ───────────────

/**
 * Per-Type closed-allowlist types. For these, the write target must match
 * the Type's scopePatterns regex in addition to the active task's filesInScope.
 * Types not in this set keep the existing behavior (filesInScope check only).
 */
const TYPE_ENFORCED_KINDS = new Set(['tests-only', 'docs', 'config', 'ci']);

function typeAllowlistDecision(type, relTarget) {
  if (!type || !TYPE_ENFORCED_KINDS.has(type)) return { blocked: false };
  const rules = scopeRulesFor(type);
  if (!rules || !rules.scopePatterns) return { blocked: false };
  if (matchesTypeScope(type, relTarget)) {
    // For tests-only also require the target to be a test file. matchesTypeScope
    // already enforces this via the TEST_FILE_PATTERN pattern but keep an
    // explicit check so the error message is precise.
    if (type === 'tests-only' && !isTestFilePath(relTarget)) {
      return {
        blocked: true,
        reason:
          `Type=tests-only restricts writes to *.test.* / *.spec.* files. ` +
          `Target "${relTarget}" is not a test file.`,
      };
    }
    return { blocked: false };
  }
  return {
    blocked: true,
    reason:
      `Type=${type} restricts writes to a closed allowlist (see ` +
      `plugins/work/skills/split-in-tasks/lib/task-types.js). ` +
      `Target "${relTarget}" is not in the ${type} allowlist.`,
  };
}

/**
 * Detect attempts to edit the `### Type` line inside a tasks.md write. The
 * planner authors `### Type`; the implementer must not be able to flip it
 * mid-implement (which would let them switch from tdd-code to docs to bypass
 * the TDD gate). For Write tool calls targeting tasks.md, reject when the
 * new content's `### Type` line differs from the on-disk version.
 *
 * Returns `{ blocked: true, reason }` to block, `{ blocked: false }` to allow.
 *
 * Scope: only triggers when the target relative path ends with `tasks.md`.
 * Edit / MultiEdit tools that operate via `old_string` / `new_string` patches
 * are checked by scanning the patches for the `### Type` line.
 */
function checkWriteTypeLines(toolInput, onDiskTypes) {
  const newContent = (toolInput.content || '').toString();
  const newTypes = extractTypeLines(newContent);
  if (typesEqual(onDiskTypes, newTypes)) return { blocked: false };
  return {
    blocked: true,
    reason:
      `protect-task-scope: refusing to modify \`### Type\` lines in tasks.md ` +
      `mid-implement. The planner sets Type; the implementer cannot change it ` +
      `(would bypass the per-Type TDD contract). On disk: ${JSON.stringify(onDiskTypes)} ` +
      `→ new: ${JSON.stringify(newTypes)}.`,
  };
}

/**
 * Apply a single Edit patch in memory using the same semantics Claude Code's
 * Edit tool uses: literal string replacement, first occurrence only unless
 * `replace_all` is true. Returns the patched content, or null when the patch
 * cannot be applied (old_string not found) — caller treats null as a fall-
 * through (no change simulated, the real tool would error).
 */
// GH-528 round-2 follow-up note: when an Edit/MultiEdit's `old_string` is
// not found, applyEditPatch returns null and the caller skips that single
// patch in the simulation. The real Edit tool errors on missing
// `old_string` and aborts the whole tool call, so the simulator's "skip
// and continue" can diverge if a later patch in a MultiEdit was authored
// against the expected post-first-patch state. In practice the divergence
// can only ALLOW patches the real tool would reject (the real tool errors
// before applying anything; the simulator might allow a residual
// Type-flipping patch through if it happens to apply against the
// unchanged file). The block-direction risk is the one we care about —
// the Type-line guard's final equality check still compares the simulated
// post-state Type lines against on-disk, so a Type flip still gets
// caught regardless of upstream patch sequencing. Worth a note for
// future maintainers.
function applyEditPatch(content, edit) {
  const oldStr = (edit.old_string || '').toString();
  const newStr = (edit.new_string || '').toString();
  if (!oldStr) return content;
  if (edit.replace_all) {
    return content.split(oldStr).join(newStr);
  }
  const idx = content.indexOf(oldStr);
  if (idx === -1) return null;
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

/**
 * Cursor[bot] Comment 5 (GH-528): value-only patches must be detected.
 *
 * The old heuristic (string-match `### Type` in patch text) missed:
 *   - `old: "tdd-code", new: "docs"` (no header in patch strings)
 *   - whitespace tricks (`old: "tdd-code  ", new: "docs"`)
 *   - MultiEdit split across two edits that combine to flip the value
 *
 * The source of truth is "what does the resolved file look like after the
 * patch?" — so we read tasks.md from disk, simulate the Edit/MultiEdit, and
 * compare extracted `### Type` lines before vs after. If they differ, block.
 *
 * This function is invoked only when the write target IS tasks.md (caller
 * guarantees), so the cost of reading + simulating is bounded.
 */
function checkEditTypeLines(toolName, toolInput, onDiskContent, onDiskTypes) {
  const edits =
    toolName === 'Edit' ? [toolInput] : Array.isArray(toolInput.edits) ? toolInput.edits : [];
  if (edits.length === 0) return { blocked: false };

  let simulated = onDiskContent;
  for (const edit of edits) {
    const next = applyEditPatch(simulated, edit);
    // null = old_string not found; the real tool would error, so the file
    // wouldn't change. Skip this edit in the simulation.
    if (next !== null) simulated = next;
  }

  const newTypes = extractTypeLines(simulated);
  if (typesEqual(onDiskTypes, newTypes)) return { blocked: false };

  return {
    blocked: true,
    reason:
      `protect-task-scope: refusing to edit \`### Type\` line in tasks.md ` +
      `mid-implement. Type is planner-authored. On disk: ${JSON.stringify(onDiskTypes)} ` +
      `→ after patch: ${JSON.stringify(newTypes)}.`,
  };
}

/**
 * Honor the one-shot env-var escape hatch for the Type-line guard. Returns
 * true when the bypass fired (audit appended, caller should exit 0).
 */
function tryTypeLineBypass(toolName, toolInput, cwd, ticketId, active) {
  const rel = relativizePath(extractTargetPath(toolName, toolInput) || '', cwd);
  const bypassReason = (process.env.PROTECT_TASK_SCOPE_BYPASS_REASON || '').trim();
  const bypassTargetCfg = (process.env.PROTECT_TASK_SCOPE_BYPASS_TARGET || '').trim();
  if (!bypassReason || !bypassTargetCfg || !rel) return false;
  const matched = rel === bypassTargetCfg || findMatch(rel, [bypassTargetCfg]) !== null;
  if (!matched) return false;
  // GH-528 ITEM 1: WORK_OPERATOR_TOKEN gate — bypass env pair matched the
  // write target but the operator token is missing. Treat as unset (block
  // stays) and audit the rejected attempt.
  if (!isOperatorTokenPresent()) {
    auditScopeBypassRejected({
      ticketId,
      active,
      relTarget: rel,
      bypassReason,
      bypassTargetCfg,
      guard: 'type-line',
    });
    return false;
  }
  try {
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: active.taskNum,
      phase: null,
      action: 'scope-bypass',
      allow: true,
      reason: bypassReason,
      outputPath: rel,
      meta: {
        taskNum: active.taskNum,
        target: rel,
        configuredTarget: bypassTargetCfg,
        guard: 'type-line',
      },
    });
  } catch (err) {
    try {
      logHookError(__filename, err);
    } catch {
      /* swallow */
    }
  }
  return true;
}

function typeLineGuard(toolName, toolInput, workDir, tasksDir) {
  if (!toolInput || !tasksDir) return { blocked: false };
  const target = (toolInput.file_path || '').toString();
  if (!target) return { blocked: false };
  const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(workDir, target);
  const tasksMdPath = path.resolve(tasksDir, 'tasks.md');
  if (resolvedTarget !== tasksMdPath) return { blocked: false };

  let onDisk = '';
  try {
    onDisk = fs.readFileSync(tasksMdPath, 'utf8');
  } catch {
    return { blocked: false };
  }
  const onDiskTypes = extractTypeLines(onDisk);

  if (toolName === 'Write') return checkWriteTypeLines(toolInput, onDiskTypes);
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    return checkEditTypeLines(toolName, toolInput, onDisk, onDiskTypes);
  }
  return { blocked: false };
}

// GH-528 round-2 follow-up note: extracted Type values are normalized to
// lowercase. typesEqual is a case-sensitive string compare against the
// already-normalized arrays, so case-only patches (e.g. `tdd-code` →
// `TDD-Code`) are treated as no-ops. That is intentional — every
// downstream Type consumer (gateContractFor, lint-type-ac-consistency,
// readActiveTaskType in tdd-phase-state.js) also lowercases the value
// before comparing against the closed enum. Blocking case-only edits
// would create false positives without closing any real bypass.
function extractTypeLines(md) {
  const out = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s+Type\s*$/i.test(lines[i].trim())) {
      // Find the next non-blank line.
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next.startsWith('#')) {
          out.push('');
          break;
        }
        out.push(next.toLowerCase());
        break;
      }
    }
  }
  return out;
}

function typesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

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

  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // GH-528 item 5: Type-line edit guard runs before scope evaluation.
  // tasks.md is generally out of scope already, but this specifically
  // blocks the bypass of flipping `### Type` mid-implement.
  const typeLineDecision = typeLineGuard(toolName, toolInput, cwd, tasksDir);
  if (typeLineDecision.blocked) {
    if (tryTypeLineBypass(toolName, toolInput, cwd, ticketId, active)) process.exit(0);
    process.stderr.write(typeLineDecision.reason + '\n');
    process.exit(2);
  }

  const decision = evaluateTool(toolName, toolInput, active, cwd);
  if (decision && decision.blocked) {
    const target = extractTargetPath(toolName, toolInput) || '';
    const relTarget = relativizePath(target, cwd);

    // GH-392 Task 8 / spec §P0#6 + follow-up: env-var escape hatch.
    //
    // BOTH `PROTECT_TASK_SCOPE_BYPASS_REASON` and
    // `PROTECT_TASK_SCOPE_BYPASS_TARGET` must be set, and the relativized
    // write target must match `BYPASS_TARGET` (exact match OR via the same
    // findMatch glob logic). REASON alone is NOT enough — that originally
    // opened a hole for any path in any tool call while the var was set.
    // Pinning to TARGET makes the bypass one-shot: the operator declares
    // exactly which file they intend to touch.
    //
    // Checked after the `decision.blocked` gate so we only audit genuinely
    // bypassed blocks. We fail closed when no ticket was detected (early
    // exit above), so identity is established here.
    const bypassReason = (process.env.PROTECT_TASK_SCOPE_BYPASS_REASON || '').trim();
    const bypassTargetCfg = (process.env.PROTECT_TASK_SCOPE_BYPASS_TARGET || '').trim();
    if (bypassReason && bypassTargetCfg && relTarget) {
      const matched =
        relTarget === bypassTargetCfg || findMatch(relTarget, [bypassTargetCfg]) !== null;
      if (matched) {
        // GH-528 ITEM 1: WORK_OPERATOR_TOKEN gate — bypass env pair matched
        // the write target but the operator token is missing. Treat as unset
        // (block stays) and audit the rejected attempt.
        if (!isOperatorTokenPresent()) {
          auditScopeBypassRejected({
            ticketId,
            active,
            relTarget,
            bypassReason,
            bypassTargetCfg,
            guard: 'files-in-scope',
          });
        } else {
          try {
            appendEnforcementAudit(ticketId, {
              origin: 'ai-subtask',
              task: active.taskNum,
              phase: null,
              action: 'scope-bypass',
              allow: true,
              reason: bypassReason,
              outputPath: relTarget,
              meta: {
                taskNum: active.taskNum,
                target: relTarget,
                configuredTarget: bypassTargetCfg,
              },
            });
          } catch (err) {
            try {
              logHookError(__filename, err);
            } catch {
              /* swallow */
            }
          }
          process.exit(0);
        }
      }
      // REASON+TARGET set but TARGET didn't match — fall through to the
      // block. NO audit row: a mis-targeted bypass is indistinguishable
      // from a typo and we don't want to log noise for unintentional uses.
    }

    // GH-392 Task 8 / spec §P0#7b: cross-task allow-list. If the would-be-
    // blocked target matches an entry in `active.crossTaskDeps`, audit it
    // and exit 0.
    if (
      relTarget &&
      Array.isArray(active.crossTaskDeps) &&
      active.crossTaskDeps.length > 0 &&
      findMatch(relTarget, active.crossTaskDeps)
    ) {
      try {
        appendEnforcementAudit(ticketId, {
          origin: 'ai-subtask',
          task: active.taskNum,
          phase: null,
          action: 'cross-task-dep-allow',
          allow: true,
          reason: 'matched ### Cross-Task Dependencies',
          outputPath: relTarget,
          meta: { taskNum: active.taskNum, target: relTarget },
        });
      } catch (err) {
        try {
          logHookError(__filename, err);
        } catch {
          /* swallow */
        }
      }
      process.exit(0);
    }
    process.stderr.write(decision.reason + '\n');
    process.exit(2);
  }

  const typeBlock = checkPerTypeAllowlist(active, toolName, toolInput, cwd, ticketId);
  if (typeBlock.blocked) {
    process.stderr.write(typeBlock.reason + '\n');
    process.exit(2);
  }
  process.exit(0);
}

/**
 * GH-528 item 5: per-Type closed-allowlist check. Runs after the standard
 * filesInScope decision has allowed the write. For tdd-code / checkpoint /
 * mechanical-refactor / file-move, returns {blocked:false} unconditionally
 * (their existing behavior). Honors the one-shot env-var bypass pair so
 * operators can still pin a single override target across this layer.
 */
function checkPerTypeAllowlist(active, toolName, toolInput, cwd, ticketId) {
  if (!active.type || !TYPE_ENFORCED_KINDS.has(active.type)) return { blocked: false };
  const target = extractTargetPath(toolName, toolInput) || '';
  if (!target) return { blocked: false };
  const relTarget = relativizePath(target, cwd);
  if (!relTarget) return { blocked: false };
  const bypassReason = (process.env.PROTECT_TASK_SCOPE_BYPASS_REASON || '').trim();
  const bypassTargetCfg = (process.env.PROTECT_TASK_SCOPE_BYPASS_TARGET || '').trim();
  const bypassMatched =
    bypassReason &&
    bypassTargetCfg &&
    (relTarget === bypassTargetCfg || findMatch(relTarget, [bypassTargetCfg]) !== null);
  if (bypassMatched) {
    // GH-528 ITEM 1: WORK_OPERATOR_TOKEN gate — env pair matched but token
    // missing. Treat as unset (fall through to allowlist decision = block)
    // and audit the rejected attempt.
    if (!isOperatorTokenPresent()) {
      if (ticketId) {
        auditScopeBypassRejected({
          ticketId,
          active,
          relTarget,
          bypassReason,
          bypassTargetCfg,
          guard: 'type-allowlist',
        });
      }
      return typeAllowlistDecision(active.type, relTarget);
    }
    // Mirror the scope-bypass audit pattern (see main() around L519 and the
    // type-line guard's tryTypeLineBypass) so a closed-allowlist override is
    // never silent. Discriminator: meta.guard='type-allowlist'.
    if (ticketId) {
      try {
        appendEnforcementAudit(ticketId, {
          origin: 'ai-subtask',
          task: active.taskNum,
          phase: null,
          action: 'scope-bypass',
          allow: true,
          reason: bypassReason,
          outputPath: relTarget,
          meta: {
            taskNum: active.taskNum,
            target: relTarget,
            configuredTarget: bypassTargetCfg,
            guard: 'type-allowlist',
          },
        });
      } catch (err) {
        try {
          logHookError(__filename, err);
        } catch {
          /* swallow */
        }
      }
    }
    return { blocked: false };
  }
  return typeAllowlistDecision(active.type, relTarget);
}

/**
 * Best-effort extraction of the primary write target for an audit log row.
 * Returns the first plausible path, or empty string.
 */
function extractTargetPath(toolName, toolInput) {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return (toolInput && toolInput.file_path) || '';
  }
  if (toolName === 'Bash') {
    const cmd = toolInput && toolInput.command;
    if (!cmd) return '';
    const targets = extractBashWriteTargets(String(cmd));
    return targets[0] || '';
  }
  return '';
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

module.exports = {
  evaluateTool,
  extractBashWriteTargets,
  getTicketId,
  getActiveTask,
  typeAllowlistDecision,
  typeLineGuard,
  extractTypeLines,
  TYPE_ENFORCED_KINDS,
};
