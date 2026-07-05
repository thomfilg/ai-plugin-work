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
 * Detect which DOMAIN kinds a ticket touches by classifying each task's
 * `### Files in scope` paths in tasks.md (GH-652).
 *
 * Domain (where the code lives: frontend/backend/e2e/devops/…) and gate
 * contract (`### Type`, HOW the task is verified — the closed enum in
 * skills/split-in-tasks/lib/task-types.js: tdd-code | tests-only | docs |
 * config | ci | mechanical-refactor | file-move | checkpoint) are
 * orthogonal axes. The closed Type enum can never produce a domain kind,
 * so domain MUST be derived from the declared file scope, not from the
 * Type value. The one Type value that carries domain signal is `ci`,
 * which maps to the `devops` domain.
 *
 * Spec.md prose is intentionally NOT scanned, and neither is the
 * `### Files explicitly out of scope` section — an out-of-scope mention
 * of e.g. `tests/e2e/**` means the OPPOSITE of "this ticket does e2e
 * work" (GH-393). Only `### Files in scope` entries count.
 *
 * Three outcomes are distinguished:
 *   1. tasks.md absent OR no `## Task` blocks → returns []
 *      (legitimately empty — caller decides what that means).
 *   2. `## Task` blocks present, each has a `### Type` header, but no
 *      scope path classifies into a domain → returns []. Legitimate
 *      (e.g. a docs-only ticket).
 *   3. Any `## Task` block lacks a `### Type` header entirely
 *      → THROWS `MalformedTasksError`. The header is the contract;
 *      its absence is malformed. Returning [] silently here would let
 *      any task ship without its gate contract by omitting the header.
 *
 * Derived kinds:
 *   - backend   — scope touches `app/api/`, schemas, `prisma/`, `server/`
 *   - frontend  — scope touches `components/`, `app/**.(tsx|jsx)`, `hooks/`, `pages/`
 *   - e2e       — scope touches `tests/e2e/**` code/globs or `*.spec.*`
 *                 (fixtures/ and helpers/ subtrees excluded)
 *   - devops    — scope touches `.github/`, `scripts/`, CI/yaml, Dockerfile,
 *                 OR the task declares `### Type: ci`
 *   - fullstack + wiring — ticket composes BOTH frontend and backend
 */
const KIND_NAMES = ['frontend', 'backend', 'wiring', 'e2e', 'devops', 'fullstack'];

// Align with task-parser.js (`/^## Task (\d+)/m`): only numbered `## Task N`
// headings count as real task blocks. The capture group is consumed inline
// in `tallyTaskManifest` to record the task number.
const TASK_BLOCK_RE = /^##\s+Task\s+(\d+)\b/i;
const SECTION_BREAK_RE = /^##\s/; // any ## heading (including next ## Task) closes the current scope
const TYPE_HEADER_RE = /^###\s+Type\s*:?\s*(.*)$/i;
const BARE_TYPE_HEADER_RE = /^###\s+Type\b/i;
const SCOPE_HEADER_RE = /^###\s+Files in scope\b/i;
const SUBSECTION_HEADER_RE = /^###\s/;

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
 * Extract the path token from a scope-section bullet line. Prefers the
 * backticked token (`- \`path/to/file.ts\` (NEW) — comment`); falls back
 * to the first bare word. Returns '' for non-bullet / empty lines.
 */
function scopeEntryPath(line) {
  const trimmed = line.trim();
  if (!/^[-*]\s+/.test(trimmed)) return '';
  const backticked = trimmed.match(/`([^`\n]+)`/);
  if (backticked) return backticked[1].trim();
  const bare = trimmed.replace(/^[-*]\s+/, '').split(/\s+/)[0] || '';
  return bare.trim();
}

/**
 * True when a `### Files in scope` entry signals e2e work. Accepts what
 * `isE2eFile` accepts, plus extension-less globs under `tests/e2e/`
 * (e.g. `tests/e2e/specs/admin/**`). Fixture/helper subtrees never count.
 */
function isE2eScopePath(p) {
  if (isE2eFile(p)) return true;
  return /(^|\/)tests\/e2e\//.test(p) && /\*/.test(p) && !/(^|\/)(fixtures|helpers)(\/|$)/i.test(p);
}

/**
 * Map one scope path/glob to the domain kinds it evidences. e2e wins
 * outright (an e2e spec under `tests/e2e/` is not devops just because
 * of a `scripts/` segment); otherwise a path may evidence several
 * domains and all are returned.
 */
function classifyScopeEntry(p) {
  if (!p) return [];
  if (isE2eScopePath(p)) return ['e2e'];
  const kinds = [];
  if (isBackendFile(p)) kinds.push('backend');
  if (isFrontendFile(p)) kinds.push('frontend');
  if (isDevopsFile(p)) kinds.push('devops');
  return kinds;
}

/**
 * Walk tasks.md lines and tally `## Task N` blocks, each task's `### Type`
 * value, its `### Files in scope` entries, and the per-task numbers that
 * lack a `### Type` header. Only headers INSIDE a `## Task` block
 * contribute — a floating `### Type` (file scope, under some other `##`
 * section, or above the first `## Task`) is not a task declaration and
 * would contradict the "no `## Task` blocks → []" rule.
 *
 * Per-task tracking matters: a global "at least one Type header" guard
 * lets tasks without `### Type` slip through if any sibling task has one.
 * We instead record which task numbers are missing the header.
 */
/**
 * Apply one in-task line to the current task record: track the active
 * `### Files in scope` subsection, the `### Type` header, the Type value,
 * and scope entries. Returns the updated inScopeSection flag.
 */
function applyTaskLine(lines, i, currentTask, inScopeSection) {
  let inScope = inScopeSection;
  if (SUBSECTION_HEADER_RE.test(lines[i])) {
    inScope = SCOPE_HEADER_RE.test(lines[i]);
  }
  if (BARE_TYPE_HEADER_RE.test(lines[i])) currentTask.sawType = true;
  const value = extractKindFromHeader(lines, i);
  if (value && !currentTask.type) currentTask.type = value;
  if (inScope) {
    const p = scopeEntryPath(lines[i]);
    if (p) currentTask.scopePaths.push(p);
  }
  return inScope;
}

function tallyTaskManifest(lines) {
  const tasks = [];
  const tasksMissingType = [];
  let taskBlocks = 0;
  let currentTask = null; // { num, sawType, type, scopePaths }
  let inScopeSection = false;

  const closeTask = () => {
    if (currentTask) {
      if (!currentTask.sawType) tasksMissingType.push(currentTask.num);
      tasks.push(currentTask);
    }
    currentTask = null;
    inScopeSection = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const taskMatch = lines[i].match(TASK_BLOCK_RE);
    if (taskMatch) {
      closeTask();
      taskBlocks++;
      currentTask = { num: Number(taskMatch[1]), sawType: false, type: '', scopePaths: [] };
      continue;
    }
    if (SECTION_BREAK_RE.test(lines[i])) {
      closeTask();
      continue;
    }
    if (!currentTask) continue;
    inScopeSection = applyTaskLine(lines, i, currentTask, inScopeSection);
  }
  closeTask();
  return { tasks, taskBlocks, tasksMissingType };
}

function detectKinds(tasksDir) {
  const text = readTasks(tasksDir);
  if (!text) return [];

  const { tasks, taskBlocks, tasksMissingType } = tallyTaskManifest(text.split('\n'));

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

  const found = new Set();
  for (const task of tasks) {
    // The one closed-enum Type value with domain signal: ci → devops.
    if (task.type === 'ci') found.add('devops');
    for (const p of task.scopePaths) {
      for (const kind of classifyScopeEntry(p)) found.add(kind);
    }
  }
  // A ticket composing BOTH frontend and backend work is fullstack by
  // construction, and the FE↔BE wiring invariants apply to it.
  if (found.has('frontend') && found.has('backend')) {
    found.add('fullstack');
    found.add('wiring');
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
    /(^|\/)lib\/.*schemas?\.(ts|js)$/.test(p) ||
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

/**
 * Heuristic: is a file path an e2e SPEC file?
 *
 * GH-393 hardening — two false-positive classes are excluded:
 *   - non-code files under `tests/e2e/` (auto-generated `.json` indexes,
 *     `.md`, `.yaml` — echo-5822 permanently blocked kind_checks on
 *     `tests/e2e/domain-index.json` with "no expect()");
 *   - fixture/helper subtrees (`tests/e2e/fixtures/**` action-only task
 *     fixtures, `helpers/` — echo-5320 flagged them as "specs without
 *     expect()"). These are support code, never assertion-bearing specs.
 */
function isE2eFile(p) {
  if (!/\.(ts|tsx|js|jsx|mjs)$/.test(p)) return false;
  if (/(^|\/)(fixtures|helpers)(\/|$)/i.test(p)) return false;
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
  classifyScopeEntry,
  isE2eScopePath,
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
