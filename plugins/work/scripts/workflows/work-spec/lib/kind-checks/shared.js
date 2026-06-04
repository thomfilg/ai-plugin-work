/**
 * Shared helpers for kind-check modules.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function sliceSection(text, headerRe) {
  if (!text) return '';
  const m = text.match(headerRe);
  if (!m) return '';
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

/** Returns the raw text of brief.md, or '' if absent. */
function readBrief(tasksDir) {
  return readFile(path.join(tasksDir, 'brief.md')) || '';
}

/** Returns the raw text of spec.md, or '' if absent. */
function readSpec(tasksDir) {
  return readFile(path.join(tasksDir, 'spec.md')) || '';
}

/** Returns the raw text of tasks.md (if produced), or '' if absent. */
function readTasks(tasksDir) {
  return readFile(path.join(tasksDir, 'tasks.md')) || '';
}

/**
 * Pull file paths out of the `## Files to Create/Modify` section of spec.md.
 * Greps backticked paths AND bare-word paths that look like
 * filename-with-extension or `slash/separated/paths`.
 */
function filesInFilesToModify(specText) {
  const block = sliceSection(specText, /^##\s+Files to Create\/Modify(?=\s|$)/im);
  if (!block) return [];
  const out = new Set();
  // Backticked paths.
  const re1 = /`([^`\n]+)`/g;
  let m;
  while ((m = re1.exec(block)) !== null) {
    const t = m[1].trim();
    if (
      /^[\w./@-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|sql|sh|prisma|mjs|cjs)$/i.test(t) ||
      /\//.test(t)
    ) {
      out.add(t);
    }
  }
  // Bullets with obvious paths.
  const re2 = /(?:^|\s)([a-zA-Z][\w./@-]*\/[\w./@-]+(?:\.[a-zA-Z0-9]+)?)/g;
  while ((m = re2.exec(block)) !== null) {
    out.add(m[1].trim());
  }
  return [...out];
}

/**
 * Detect which task kinds are present by parsing structured `### Type`
 * headers in tasks.md. Each `## Task` block declares its kind via either:
 *   - `### Type` on one line, value on the next non-empty line, OR
 *   - `### Type: <kind>` inline.
 *
 * Spec.md is intentionally NOT scanned — it's prose/design. Only the
 * explicit per-task declarations count. This eliminates the entire class
 * of false-positives from prose, gherkin tables, scope notes, and
 * deferral annotations (no keyword scan, no suppression surface).
 *
 * Three outcomes are distinguished:
 *   1. tasks.md absent OR no `## Task` blocks → returns []
 *      (legitimately empty — caller decides what that means).
 *   2. `## Task` blocks present, each has a `### Type` header, but no
 *      header value matches the kind axis → returns []. The header
 *      exists; it just carries a work-type value (e.g. `feature`,
 *      `implementation`, `checkpoint`) instead of a kind. Legitimate.
 *   3. `## Task` blocks present, ZERO have a `### Type` header at all
 *      → THROWS `MalformedTasksError`. The header is the contract;
 *      its complete absence is malformed. Returning [] silently here
 *      would let any task ship without a kind check by simply omitting
 *      the Type header.
 *
 * Why the distinction matters: `### Type` is overloaded across this
 * codebase. Some flows use it for the kind axis (frontend/backend/…),
 * others use it for the work-type axis (feature/implementation/
 * checkpoint). `detectKinds` only cares about the kind axis. A
 * non-kind value is not malformed — it just means the task doesn't
 * participate in kind-specific validators.
 */
const KIND_NAMES = ['frontend', 'backend', 'wiring', 'e2e', 'devops', 'fullstack'];

// Align with task-parser.js (`/^## Task (\d+)/m`): only numbered `## Task N`
// headings count as real task blocks. The capture group is consumed inline
// in `tallyTaskManifest` to record the task number.
const TASK_BLOCK_RE = /^##\s+Task\s+(\d+)\b/i;
const SECTION_BREAK_RE = /^##\s/; // any ## heading (including next ## Task) closes the current scope
const TYPE_HEADER_RE = /^###\s+Type\s*:?\s*(.*)$/i;
const BARE_TYPE_HEADER_RE = /^###\s+Type\b/i;

/**
 * Look ahead from `startIndex` for the first non-empty, non-heading line
 * and return its lowercased trimmed value. Returns '' if none found.
 */
function findNextValueLine(lines, startIndex) {
  for (let j = startIndex; j < lines.length; j++) {
    const next = lines[j].trim();
    if (!next) continue;
    if (next.startsWith('#')) return '';
    return next.toLowerCase();
  }
  return '';
}

function extractKindFromHeader(lines, i) {
  const m = lines[i].match(TYPE_HEADER_RE);
  if (!m) return '';
  const inline = m[1].trim().toLowerCase();
  return inline || findNextValueLine(lines, i + 1);
}

class MalformedTasksError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MalformedTasksError';
  }
}

/**
 * Walk tasks.md lines and tally `## Task N` blocks, the kind values they
 * declare, and the per-task numbers that lack a `### Type` header. Only
 * headers INSIDE a `## Task` block contribute — a floating `### Type`
 * (file scope, under some other `##` section, or above the first
 * `## Task`) is not a task declaration and would contradict the
 * "no `## Task` blocks → []" rule.
 *
 * Per-task tracking matters: a global "at least one Type header" guard
 * lets tasks without `### Type` slip through if any sibling task has one.
 * We instead record which task numbers are missing the header.
 */
function tallyTaskManifest(lines) {
  const found = new Set();
  const tasksMissingType = [];
  let taskBlocks = 0;
  let currentTask = null; // { num, sawType }

  const closeTask = () => {
    if (currentTask && !currentTask.sawType) tasksMissingType.push(currentTask.num);
    currentTask = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const taskMatch = lines[i].match(TASK_BLOCK_RE);
    if (taskMatch) {
      closeTask();
      taskBlocks++;
      currentTask = { num: Number(taskMatch[1]), sawType: false };
      continue;
    }
    if (SECTION_BREAK_RE.test(lines[i])) {
      closeTask();
      continue;
    }
    if (!currentTask) continue;
    if (BARE_TYPE_HEADER_RE.test(lines[i])) currentTask.sawType = true;
    const value = extractKindFromHeader(lines, i);
    if (value && KIND_NAMES.includes(value)) found.add(value);
  }
  closeTask();
  return { found, taskBlocks, tasksMissingType };
}

function detectKinds(tasksDir) {
  const text = readTasks(tasksDir);
  if (!text) return [];

  const { found, taskBlocks, tasksMissingType } = tallyTaskManifest(text.split('\n'));

  if (taskBlocks > 0 && tasksMissingType.length > 0) {
    throw new MalformedTasksError(
      `tasks.md in ${tasksDir} has ${tasksMissingType.length} of ${taskBlocks} task block(s) ` +
        `missing a "### Type" header: ${tasksMissingType.map((n) => `Task ${n}`).join(', ')}. ` +
        `Every task must declare its type via "### Type: <value>" or a "### Type" header followed ` +
        `by a value line. A non-kind value (e.g. "feature", "implementation", "checkpoint") is ` +
        `legitimate and produces no kinds — but omitting the header would let those tasks bypass ` +
        `kind checks.`
    );
  }

  return [...found];
}

/**
 * Pre-flight check for kind-check phase orchestrators. Calls `detectKinds`
 * once, surfaces `MalformedTasksError` as a structured result rather than
 * a throw so the phase's `validate()` can fail loudly via its return value
 * (the per-handler try/catch in orchestrators otherwise swallows throws
 * from `appliesTo`, defeating the bypass guard).
 */
function preflightTasksManifest(tasksDir) {
  try {
    detectKinds(tasksDir);
    return { ok: true };
  } catch (e) {
    if (e instanceof MalformedTasksError) return { ok: false, error: e.message };
    throw e;
  }
}

/** True if brief.md explicitly forbids backend changes. */
function briefForbidsBackend(briefText) {
  if (!briefText) return false;
  return /no\s+backend\s+changes/i.test(briefText);
}

/** Heuristic: is a file path "backend-like"? */
function isBackendFile(p) {
  return (
    /(^|\/)app\/api\//.test(p) ||
    /(^|\/)lib\/.*\/schemas?\.(ts|js)$/.test(p) ||
    /(^|\/)prisma\//.test(p) ||
    /(^|\/)server\//.test(p)
  );
}

/** Heuristic: is a file path "frontend-like"? */
function isFrontendFile(p) {
  return (
    /(^|\/)components\//.test(p) ||
    /(^|\/)app\/.*\.(tsx|jsx)$/.test(p) ||
    /(^|\/)hooks\//.test(p) ||
    /(^|\/)pages\//.test(p)
  );
}

/** Heuristic: is a file path "e2e-like"? */
function isE2eFile(p) {
  return /(^|\/)tests\/e2e\//.test(p) || /\.spec\.(ts|tsx|js|jsx)$/.test(p);
}

/** Heuristic: is a file path "devops/infra-like"? */
function isDevopsFile(p) {
  return (
    /^\.github\//.test(p) ||
    /(^|\/)scripts\//.test(p) ||
    /(^|\/)\.?ci\//.test(p) ||
    /\.(yml|yaml)$/.test(p) ||
    /(^|\/)Dockerfile/.test(p)
  );
}

/** Heuristic: is a file path an "app-source" path (so devops should NOT touch it)? */
function isAppSourceFile(p) {
  return /(^|\/)app\//.test(p) || /(^|\/)lib\//.test(p) || /(^|\/)components\//.test(p);
}

module.exports = {
  readBrief,
  readSpec,
  readTasks,
  sliceSection,
  filesInFilesToModify,
  detectKinds,
  MalformedTasksError,
  preflightTasksManifest,
  briefForbidsBackend,
  isBackendFile,
  isFrontendFile,
  isE2eFile,
  isDevopsFile,
  isAppSourceFile,
  KIND_NAMES,
};
