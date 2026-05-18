/**
 * gherkin-task-refs.js
 *
 * Cross-validates `tasks/<TICKET>/gherkin.feature` against
 * `tasks/<TICKET>/tasks.md` so every scenario is owned by exactly one task
 * AND points at a real test file on disk before the implement step runs.
 *
 * This module is the contract enforcer for two bypass paths that the gate
 * previously could not see:
 *
 *   1. "Synthesized" TDD evidence — the gate would record red+green at the
 *      same timestamp when no test files matched the command. With these
 *      refs in place, the gate refuses to enter implement until every
 *      scenario's @test file physically exists.
 *
 *   2. "Type-skip" — the gate previously waved tasks of certain types past
 *      RED. Reference enforcement is type-agnostic: every scenario needs an
 *      @test file, regardless of how the task is labeled in tasks.md.
 *
 * Format (per scenario in gherkin.feature):
 *
 *     @integration
 *     @task:3
 *     @test:components/foo/foo.integration.test.tsx
 *     Scenario: foo bars the baz
 *       Given …
 *
 *   - `@task:N`            (required) — which `## Task N` in tasks.md owns it
 *   - `@test:<path>`       (required, may repeat) — test file that MUST exist
 *
 * Format (per task in tasks.md):
 *
 *     ## Task 3 — Foo
 *     ...
 *     ### Scenarios
 *     - foo bars the baz
 *     - foo handles empty input
 *
 *   Each bullet is the scenario name verbatim (without the trailing colon).
 *
 * Public API:
 *   parseFeatureFile(text)             → { scenarios: [{name, taskNum, testPaths[]}], errors[] }
 *   parseTaskScenarios(tasksMdText)    → Map<taskNum, Set<scenarioName>>
 *   validateConsistency(opts)          → { valid, errors[] }
 *   collectTaskTestPaths(opts, taskNum)→ string[] (absolute paths)
 *
 * No I/O is done by the parsing functions — callers pass in text. The
 * validators that need file-existence checks accept an `fs` injection point
 * for testability (defaults to node:fs).
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { parseRaw } = require(path.join(__dirname, '..', '..', 'work', 'lib', 'parse-gherkin.js'));

const TASK_TAG_RE = /^@task:(\d+)$/;
const TEST_TAG_RE = /^@test:(.+)$/;

/**
 * Parse a gherkin .feature file and extract every scenario's task/test refs.
 *
 * @param {string} text - Full file contents
 * @returns {{
 *   scenarios: Array<{name: string, taskNum: number|null, testPaths: string[], tags: string[]}>,
 *   errors: string[]
 * }}
 */
function parseFeatureFile(text) {
  const { features, errors: parseErrors } = parseRaw(String(text || ''));
  const errors = [...parseErrors];
  const scenarios = [];

  for (const feature of features) {
    for (const scenario of feature.scenarios) {
      let taskNum = null;
      const testPaths = [];
      for (const tag of scenario.tags) {
        const taskMatch = tag.match(TASK_TAG_RE);
        if (taskMatch) {
          if (taskNum !== null) {
            errors.push(
              `Scenario "${scenario.name}" has multiple @task: tags — exactly one is required.`
            );
          }
          taskNum = parseInt(taskMatch[1], 10);
          continue;
        }
        const testMatch = tag.match(TEST_TAG_RE);
        if (testMatch) {
          testPaths.push(testMatch[1].trim());
        }
      }
      scenarios.push({
        name: scenario.name,
        taskNum,
        testPaths,
        tags: scenario.tags,
      });
    }
  }

  return { scenarios, errors };
}

/**
 * Parse tasks.md and return a map of taskNum → Set of scenario names listed
 * under that task's `### Scenarios` section.
 *
 * Tasks without a `### Scenarios` section produce no entry — callers can
 * detect that as "task has no scenarios" via .has(num).
 *
 * @param {string} tasksMdText
 * @returns {Map<number, Set<string>>}
 */
function parseTaskScenarios(tasksMdText) {
  const result = new Map();
  const text = String(tasksMdText || '');
  if (!text.trim()) return result;

  // Split on ## Task N — same approach as task-parser.js
  const parts = text.split(/^## Task (\d+)/m);
  for (let i = 1; i < parts.length; i += 2) {
    const taskNum = parseInt(parts[i], 10);
    if (!Number.isFinite(taskNum)) continue;
    const body = parts[i + 1] || '';
    // Find ### Scenarios block (any case for the heading word)
    // Capture the bullet list under `### Scenarios` up to the next ### or ##
    // heading (or end-of-string). No /m flag — we need `$` to mean
    // end-of-string, not end-of-line, otherwise the lazy match terminates
    // after the first bullet.
    const sectionMatch = body.match(/### +Scenarios\b[^\n]*\n([\s\S]*?)(?=\n###|\n## |$)/);
    if (!sectionMatch) continue;
    const sectionBody = sectionMatch[1];
    const scenarioNames = new Set();
    for (const rawLine of sectionBody.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('<!--')) continue;
      // Accept `- name`, `* name`, or `1. name`
      const m = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
      if (!m) continue;
      // Strip trailing punctuation that authors may add (`.`, `:`)
      const name = m[1].replace(/[.:]\s*$/, '').trim();
      if (name) scenarioNames.add(name);
    }
    if (scenarioNames.size > 0) result.set(taskNum, scenarioNames);
  }

  return result;
}

/**
 * Cross-check a gherkin.feature against a tasks.md so the gate can refuse
 * to transition out of `tasks` until every scenario is reachable.
 *
 * Returns `{ valid, errors[] }`. Errors are human-readable and reference
 * the scenario or task that's at fault. Callers should surface them
 * verbatim in the gate's RUN instruction so the authoring agent knows
 * exactly what to fix.
 *
 * @param {{
 *   gherkinText: string,           // contents of gherkin.feature
 *   tasksMdText: string,           // contents of tasks.md
 *   knownTaskNums?: Set<number>,   // optional: tasks.md task IDs for cross-check
 * }} opts
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateConsistency(opts) {
  const errors = [];
  const { gherkinText, tasksMdText, knownTaskNums } = opts || {};

  if (!gherkinText || !gherkinText.trim()) {
    errors.push('gherkin.feature is missing or empty.');
    return { valid: false, errors };
  }
  if (!tasksMdText || !tasksMdText.trim()) {
    errors.push('tasks.md is missing or empty.');
    return { valid: false, errors };
  }

  const { scenarios, errors: parseErrors } = parseFeatureFile(gherkinText);
  for (const e of parseErrors) errors.push(e);

  if (scenarios.length === 0) {
    errors.push('gherkin.feature has zero scenarios.');
    return { valid: false, errors };
  }

  const taskMap = parseTaskScenarios(tasksMdText);

  // Per-scenario checks: tags present + cross-ref present in tasks.md
  const referencedByTask = new Map();
  for (const sc of scenarios) {
    if (sc.taskNum === null) {
      errors.push(`Scenario "${sc.name}" is missing an @task:N tag.`);
      continue;
    }
    if (sc.testPaths.length === 0) {
      errors.push(`Scenario "${sc.name}" (task ${sc.taskNum}) is missing an @test:<path> tag.`);
    }
    if (knownTaskNums && !knownTaskNums.has(sc.taskNum)) {
      errors.push(
        `Scenario "${sc.name}" references @task:${sc.taskNum} but tasks.md has no Task ${sc.taskNum}.`
      );
    }
    const listed = taskMap.get(sc.taskNum);
    if (!listed) {
      errors.push(
        `Scenario "${sc.name}" claims @task:${sc.taskNum} but Task ${sc.taskNum} in tasks.md has no \`### Scenarios\` list.`
      );
    } else if (!listed.has(sc.name)) {
      errors.push(
        `Scenario "${sc.name}" is not listed under \`### Scenarios\` in Task ${sc.taskNum} of tasks.md.`
      );
    }
    if (!referencedByTask.has(sc.taskNum)) referencedByTask.set(sc.taskNum, new Set());
    referencedByTask.get(sc.taskNum).add(sc.name);
  }

  // Reverse check: every scenario listed in tasks.md must exist in gherkin
  for (const [taskNum, names] of taskMap.entries()) {
    const inFeature = referencedByTask.get(taskNum) || new Set();
    for (const name of names) {
      if (!inFeature.has(name)) {
        errors.push(
          `Task ${taskNum} in tasks.md lists scenario "${name}" but it is not present in gherkin.feature (or its @task tag points elsewhere).`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Collect every @test:<path> referenced by scenarios that belong to a given
 * task, joined with the tasks dir's worktree root so callers can stat()
 * them. Returned paths are RELATIVE to `worktreeDir` (callers prepend it
 * before fs.existsSync, or pass it as `cwd`).
 *
 * @param {{ gherkinText: string }} opts
 * @param {number} taskNum
 * @returns {string[]} unique, sorted test-file paths
 */
function collectTaskTestPaths(opts, taskNum) {
  const { scenarios } = parseFeatureFile(opts.gherkinText);
  const set = new Set();
  for (const sc of scenarios) {
    if (sc.taskNum === taskNum) {
      for (const p of sc.testPaths) set.add(p);
    }
  }
  return [...set].sort();
}

/**
 * Verify every @test:<path> for a task exists on disk. Returns the list of
 * missing paths (empty array == all present). Pure of side effects.
 *
 * @param {{ gherkinText: string, worktreeDir: string, fsImpl?: typeof fs }} opts
 * @param {number} taskNum
 * @returns {{ missing: string[], all: string[] }}
 */
function findMissingTestFiles(opts, taskNum) {
  const fsImpl = opts.fsImpl || fs;
  const all = collectTaskTestPaths(opts, taskNum);
  const missing = [];
  for (const rel of all) {
    const abs = path.isAbsolute(rel) ? rel : path.join(opts.worktreeDir || '.', rel);
    if (!fsImpl.existsSync(abs)) missing.push(rel);
  }
  return { missing, all };
}

module.exports = {
  parseFeatureFile,
  parseTaskScenarios,
  validateConsistency,
  collectTaskTestPaths,
  findMissingTestFiles,
};
