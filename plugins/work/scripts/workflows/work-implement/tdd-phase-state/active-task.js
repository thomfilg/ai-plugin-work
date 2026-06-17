'use strict';

/**
 * tdd-phase-state/active-task.js
 *
 * On-disk tasks.md reading + `--docs-exempt` allow-check extracted from
 * tdd-phase-state.js (GH-610 static-quality refactor). The trust model,
 * fail-open/fail-closed semantics, and returned shapes are unchanged.
 *
 * GH-528 round-2 follow-up (Cursor[bot] HIGH): the recorder reads the active
 * task's Type from on-disk tasks.md to gate `record-skip-red` and
 * `--red-skip-file-guard`. tasks.md is the same source-of-truth the hook
 * layer uses, and the Type-line edit guard (protect-task-scope.js) blocks
 * mid-implement Type flips, so reading it here is trust-equivalent to the
 * planner's authored value.
 */

const fs = require('fs');
const path = require('path');
const { resolveTasksBaseWithFallback } = require('../../lib/ticket-validation');
const { sanitizeId } = require('./state-path');

let taskTypes;
try {
  taskTypes = require('../../../../skills/split-in-tasks/lib/task-types');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  taskTypes = null;
}

/**
 * Find the [start, end) line range for `## Task <taskNum>` in `lines`.
 * Returns null when the task header is absent.
 */
function findTaskRange(lines, taskNum) {
  const headerRe = new RegExp(`^##\\s+Task\\s+${taskNum}\\b`, 'i');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Read the first non-blank value line following a `### Type` heading.
 * Returns the lowercase Type, or null when the next content is another
 * heading (empty section).
 */
function readTypeValue(lines, from, end) {
  for (let j = from; j < end; j += 1) {
    const next = lines[j].trim();
    if (!next) continue;
    if (next.startsWith('#')) return null;
    return next.toLowerCase();
  }
  return null;
}

/**
 * Collect the bullet list under a `### Files in scope` heading until the
 * next heading. Each bullet is stripped of backticks and trailing `# ...`
 * comments. Mutates `scope` in place.
 */
function collectScopeBullets(lines, from, end, scope) {
  for (let j = from; j < end; j += 1) {
    const next = lines[j].trim();
    if (!next) continue;
    if (/^###\s+/.test(next) || /^##\s+/.test(next)) break;
    const bullet = next.match(/^[-*+]\s+(.*)$/);
    if (!bullet) continue;
    const cleaned = bullet[1]
      .replace(/`/g, '')
      .replace(/\s+#.*$/, '')
      .trim();
    if (cleaned) scope.push(cleaned);
  }
}

function parseTaskBlock(lines, start, end) {
  let type = null;
  const scope = [];
  for (let i = start + 1; i < end; i += 1) {
    const trimmed = lines[i].trim();
    if (/^###\s+Type\s*$/i.test(trimmed)) {
      type = readTypeValue(lines, i + 1, end);
      continue;
    }
    if (/^###\s+Files in scope\b/i.test(trimmed)) {
      collectScopeBullets(lines, i + 1, end, scope);
    }
  }
  return { type, scope };
}

/**
 * Read the declared `### Type` value and `### Files in scope` bullets for the
 * active task from on-disk tasks.md.
 *
 * Returns `{ type, scope }` where `type` is the lowercase Type string (or
 * null) and `scope` is an array of path strings. Returns `{ type: null,
 * scope: [] }` when tasks.md is missing, the task block is missing, or
 * parsing fails. Callers MUST handle a null `type` as "Type unknown, fail
 * closed at the gate".
 */
function readActiveTaskBlock(ticketId, taskNum) {
  if (!ticketId || !Number.isInteger(taskNum) || taskNum < 1) {
    return { type: null, scope: [] };
  }
  try {
    const base = resolveTasksBaseWithFallback();
    const safeId = sanitizeId(ticketId);
    const tasksMdPath = path.resolve(base, safeId, 'tasks.md');
    if (!fs.existsSync(tasksMdPath)) return { type: null, scope: [] };
    const lines = fs.readFileSync(tasksMdPath, 'utf8').split(/\r?\n/);
    const range = findTaskRange(lines, taskNum);
    if (!range) return { type: null, scope: [] };
    return parseTaskBlock(lines, range.start, range.end);
  } catch {
    return { type: null, scope: [] };
  }
}

// Backward-compatible helper — returns only the Type, used by the existing
// record-skip-red and --red-skip-file-guard gates.
function readActiveTaskType(ticketId, taskNum) {
  return readActiveTaskBlock(ticketId, taskNum).type;
}

// Visual-only Storybook detection (mirrors task-next.js isVisualOnlyTask).
// When every scope entry matches `*.stories.[jt]sx?`, the task has no
// executable test surface and `--docs-exempt` is legitimate even for
// Type=tdd-code. See split-in-tasks SKILL.md Rule 10.
function isVisualOnlyScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return false;
  return scope.every((p) => typeof p === 'string' && /\.stories\.[jt]sx?$/i.test(p));
}

function contractAllowsDocsExempt(type) {
  if (!type || !taskTypes || typeof taskTypes.gateContractFor !== 'function') return false;
  const contract = taskTypes.gateContractFor(type);
  return !!(contract && contract.rcdEmptyTrap === false);
}

/**
 * GH-528 round-2 follow-up (Cursor[bot] HIGH/Medium): single allow-check
 * for `--docs-exempt`. Mirrors the orchestrator's `docsExemptForward`
 * discriminator (task-next.js):
 *     docsExemptForward = contractAllowsDocsExempt || visualOnly
 *
 * `--docs-exempt` is legitimate iff EITHER:
 *   - gateContractFor(type).rcdEmptyTrap === false
 *     (docs / config / ci / file-move / checkpoint), OR
 *   - the task's scope is visual-only Storybook (any Type).
 *
 * Returns { allowed: boolean, type: string|null, reason: string }.
 * `reason` carries an operator-facing message when allowed=false.
 */
function isDocsExemptAllowed(ticketId, taskNum) {
  // GH-528 round-2 follow-up (Cursor[bot] HIGH): the gate fires for ALL
  // callers, including those that omit --task. An earlier draft fell
  // through for no-task callers under the assumption that legacy
  // ticket-root state was vestigial, but that left a self-report surface
  // intact: a tokened agent could simply omit --task to bypass the gate.
  // Now: missing --task fails closed. The orchestrator always passes
  // --task (task-next.js recordEvidence builds the argv with it); test
  // fixtures that need --docs-exempt must seed tasks.md and pass --task.
  if (!Number.isInteger(taskNum) || taskNum < 1) {
    return {
      allowed: false,
      type: null,
      reason:
        '--docs-exempt requires --task <N> so the recorder can verify the ' +
        "active task's Type against on-disk tasks.md. Re-run with --task <N>.",
    };
  }
  const { type, scope } = readActiveTaskBlock(ticketId, taskNum);
  if (isVisualOnlyScope(scope)) {
    return { allowed: true, type, reason: 'visual-only Storybook scope' };
  }
  if (contractAllowsDocsExempt(type)) {
    return { allowed: true, type, reason: 'contract rcdEmptyTrap=false' };
  }
  return {
    allowed: false,
    type,
    reason:
      `--docs-exempt is restricted to Types whose contract sets ` +
      `rcdEmptyTrap=false (docs / config / ci / file-move / checkpoint) ` +
      `or to visual-only Storybook scope. ` +
      `Task ${taskNum || '?'} has Type="${type || 'unknown'}" and non-visual scope; ` +
      `the RC-D empty-output trap and RED file guard stay armed. ` +
      `Either fix the \`### Type\` line in tasks.md or drop --docs-exempt.`,
  };
}

module.exports = {
  taskTypes,
  readActiveTaskBlock,
  readActiveTaskType,
  isVisualOnlyScope,
  isDocsExemptAllowed,
};
