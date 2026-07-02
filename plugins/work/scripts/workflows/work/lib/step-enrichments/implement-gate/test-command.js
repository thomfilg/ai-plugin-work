/**
 * Test-command resolution helpers for the implement gate.
 *
 * Reads the runnable test command for a task — first the verbatim
 * `### Test Command` body (legacy, always honoured), then a GH-610 fallback
 * that synthesises a command from the task's `### Test Strategy` block when the
 * validator flag is on. Also parses command bodies out of markdown sections and
 * detects malformed parser output.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ENRICH_DIR = path.join(__dirname, '..');
const { parseTasks } = require(path.join(ENRICH_DIR, '..', 'task-graph'));

// GH-610: Test Strategy → implement-side consumer. These are STABLE APIs
// owned by GH-590; consumed here, never edited.
//   - synthesizeCommand(strategy, envrc): runnable command for
//     unit/integration/e2e/custom kinds; null for citation kinds.
//   - findNearestEnvrc(worktreeDir): worktree-rooted `.envrc` parse (no shell).
//   - parseTasks(tasksDir) from task-parser: exposes `task.testStrategy`.
const { synthesizeCommand } = require(
  path.join(ENRICH_DIR, '..', '..', '..', 'lib', 'test-strategy')
);
const { findNearestEnvrc } = require(
  path.join(ENRICH_DIR, '..', '..', '..', 'lib', 'envrc-resolver')
);
const { parseTasks: parseTasksWithStrategy } = require(path.join(ENRICH_DIR, '..', 'task-parser'));
// (task-parser lives at work/lib/task-parser.js — one level up from enrich dir.)

// Strategy kinds that carry no runnable command — they piggyback on a peer's
// tests via a citation, so `synthesizeCommand` returns null by design (C3).
const CITATION_STRATEGY_KINDS = new Set(['verified-by', 'wiring-citation']);

/** The GH-590/GH-610 Test Strategy consumer is permanently enabled. */
function isTestStrategyValidatorEnabled() {
  return true;
}

/** Locate a parsed task by 1-indexed task number. */
function findTaskByNum(tasksDir, taskNum) {
  let tasks;
  try {
    tasks = parseTasksWithStrategy(tasksDir);
  } catch {
    return null;
  }
  if (!Array.isArray(tasks)) return null;
  return tasks.find((t) => t && t.num === Number(taskNum)) || null;
}

/**
 * Read the runnable test command for a specific task from tasks.md.
 *
 * Legacy path: returns the verbatim `### Test Command` body when present.
 * GH-610: when the Test Strategy validator flag is ON and there is no
 * `### Test Command`, fall back to synthesising a command from the task's
 * `### Test Strategy` block (resolving the test-command envelope from the
 * worktree-rooted `.envrc`). Citation kinds (`verified-by` /
 * `wiring-citation`) synthesise to `null` by design — they have no command.
 *
 * @param {string} tasksDir
 * @param {number} taskNum - 1-indexed task number
 * @param {string} [worktreeDir] - worktree root used to resolve `.envrc`
 *   for strategy synthesis. Omitting it preserves byte-for-byte legacy
 *   behaviour (no synthesis fallback).
 * @returns {string|null}
 */
function readTaskTestCommand(tasksDir, taskNum, worktreeDir) {
  const legacy = readLegacyTestCommand(tasksDir, taskNum);
  if (legacy) return legacy;

  // Synthesis fallback only when the flag is ON and a worktreeDir is given.
  if (!isTestStrategyValidatorEnabled() || !worktreeDir) return null;
  const task = findTaskByNum(tasksDir, taskNum);
  const strategy = task && task.testStrategy;
  if (!strategy) return null;
  if (CITATION_STRATEGY_KINDS.has(strategy.kind)) return null;
  return synthesizeCommand(strategy, findNearestEnvrc(worktreeDir));
}

/**
 * Legacy reader: the verbatim `### Test Command` body for a task, or null.
 * @param {string} tasksDir
 * @param {number} taskNum - 1-indexed task number
 * @returns {string|null}
 */
function readLegacyTestCommand(tasksDir, taskNum) {
  if (!tasksDir) return null;
  const tasksMdPath = path.join(tasksDir, 'tasks.md');
  if (!fs.existsSync(tasksMdPath)) return null;
  try {
    const content = fs.readFileSync(tasksMdPath, 'utf8');
    const sectionRe = new RegExp(
      `## Task ${taskNum}\\b[\\s\\S]*?(?=\\n## Task \\d|\\n## (?!Task )|$)`,
      ''
    );
    const sectionMatch = content.match(sectionRe);
    if (!sectionMatch) return null;
    return extractTestCommandFromSection(sectionMatch[0]);
  } catch {
    return null;
  }
}

/**
 * Resolve how a task's tests are executed, distinguishing the three sources:
 *   - `command`: a verbatim `### Test Command` (legacy, always honoured).
 *   - `strategy`: a synthesised command (or a citation) from `### Test Strategy`
 *     when the validator flag is ON.
 *   - `null`: neither is present.
 *
 * For citation kinds (`verified-by` / `wiring-citation`) the synthesised
 * `command` is `null` BY DESIGN — that is not a missing command — and the
 * `citation` field carries the strategy object so the gate can defer to the
 * peer task's evidence.
 *
 * Throws a distinct error when a non-citation strategy synthesises to null
 * (e.g. a `custom` kind with neither a command nor a fenced body), so the
 * caller can tell that apart from "no strategy at all".
 *
 * @param {string} tasksDir
 * @param {number} taskNum - 1-indexed task number
 * @param {string} [worktreeDir] - worktree root used to resolve `.envrc`
 * @returns {{ command: string|null, strategyKind: string|null,
 *             citation: object|null, source: 'command'|'strategy'|null }}
 */
function resolveTaskTestExecution(tasksDir, taskNum, worktreeDir) {
  const legacy = readLegacyTestCommand(tasksDir, taskNum);
  if (legacy) {
    return { command: legacy, strategyKind: null, citation: null, source: 'command' };
  }

  if (!isTestStrategyValidatorEnabled() || !worktreeDir) {
    return { command: null, strategyKind: null, citation: null, source: null };
  }

  const task = findTaskByNum(tasksDir, taskNum);
  const strategy = task && task.testStrategy;
  if (!strategy) {
    return { command: null, strategyKind: null, citation: null, source: null };
  }

  const kind = strategy.kind || null;

  // Citation kinds: no runnable command, the citation IS the resolution.
  if (CITATION_STRATEGY_KINDS.has(kind)) {
    return { command: null, strategyKind: kind, citation: strategy, source: 'strategy' };
  }

  const command = synthesizeCommand(strategy, findNearestEnvrc(worktreeDir));
  if (command == null) {
    throw new Error(
      `Task ${taskNum}: Test Strategy synthesis returned null for a non-citation kind=${kind || '<missing>'} ` +
        '(expected a runnable command — check the strategy entry/command body)'
    );
  }
  return { command, strategyKind: kind, citation: null, source: 'strategy' };
}

/**
 * Extract the actual test command from a `### Test Command` section.
 *
 * Handles three common authoring styles:
 *   - bare line:        `pnpm test foo.spec.ts`
 *   - inline code:      `` `pnpm test foo.spec.ts` ``
 *   - fenced block:     ``` ```bash\npnpm test foo.spec.ts\n``` ```
 *
 * Strips backticks/code-fence markers, skips empty lines and shell comments,
 * and concatenates multi-line commands joined by trailing `\` continuations.
 *
 * @param {string} section - The full task section text containing `### Test Command`.
 * @returns {string|null}
 */
function extractTestCommandFromSection(section) {
  const headingIdx = section.search(/### Test Command[^\n]*\n/);
  if (headingIdx < 0) return null;
  const afterHeading = section.slice(headingIdx).split('\n').slice(1); // drop the heading line itself
  const cmdLines = collectCommandLines(afterHeading);
  if (cmdLines.length === 0) return null;
  return cmdLines.map((l) => l.replace(/\\$/, '').trim()).join(' ');
}

/**
 * Walk the lines below a `### Test Command` heading and collect the usable
 * command lines, stripping fences/backticks and skipping comments/artefacts.
 * Stops at the next subsection, rule, or the first non-continuation line.
 */
function collectCommandLines(afterHeading) {
  const cmdLines = [];
  let inFence = false;
  for (const raw of afterHeading) {
    // Stop at the next subsection / horizontal rule / new task heading
    if (/^### /.test(raw) || /^## /.test(raw) || /^---\s*$/.test(raw)) break;
    const line = raw.trimEnd();
    // Toggle fenced code blocks
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const stripped = cleanCommandLine(line);
    if (stripped == null) continue;
    cmdLines.push(stripped);
    // Stop on the first non-continuation line (no trailing backslash)
    if (!stripped.endsWith('\\')) break;
  }
  return cmdLines;
}

/**
 * Normalise a single candidate command line: trims, strips inline-code
 * backticks, and rejects empties/comments/parser artefacts. Returns the
 * cleaned command or null when the line should be skipped.
 */
function cleanCommandLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) return null; // shell comment / markdown comment
  // Strip surrounding inline-code backticks: `cmd` → cmd
  const stripped = trimmed.replace(/^`+|`+$/g, '').trim();
  if (!stripped) return null;
  // Skip parser artefacts that would silently `execSync` to garbage.
  if (/^(?:bash|sh|zsh|fish|node|python|python3)\s*$/i.test(stripped)) return null;
  if (/^[`]+$/.test(stripped)) return null;
  return stripped;
}

/**
 * Detect a `### Test Command` value that the parser leaked from markdown
 * formatting (fenced-block fragment, bare shell name, unmatched backtick).
 * These would `execSync` silently and starve the gate of a real exit code,
 * causing infinite re-dispatch — return a clear block reason instead.
 *
 * @param {string} cmd
 * @returns {string|null} reason if malformed, null if usable
 */
function detectMalformedTestCommand(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return 'empty';
  // Bare shell launchers with no arguments — the parser dropped the body
  if (/^(?:bash|sh|zsh|fish|node|python|python3)\s*$/i.test(raw)) return 'bare-interpreter';
  // Pure backtick / fence remnants
  if (/^[`]+$/.test(raw)) return 'backticks-only';
  // Markdown fence opener that survived (must come before the broader
  // stray-backtick check, which would otherwise match first and label
  // ```bash as a "stray-backtick").
  if (/^```/.test(raw)) return 'fence-opener';
  // Starts/ends with a stray backtick (parser failed to strip a partial fence)
  if (/^`/.test(raw) || /`$/.test(raw)) return 'stray-backtick';
  return null;
}

module.exports = {
  CITATION_STRATEGY_KINDS,
  isTestStrategyValidatorEnabled,
  findTaskByNum,
  readTaskTestCommand,
  readLegacyTestCommand,
  resolveTaskTestExecution,
  extractTestCommandFromSection,
  detectMalformedTestCommand,
  parseTasks,
  synthesizeCommand,
  findNearestEnvrc,
};
