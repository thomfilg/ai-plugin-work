/**
 * Phase: gherkin_link — if gherkin.feature exists, every scenario must be
 * referenced by ≥1 task, AND every task carrying `@task:N` scenarios must
 * have a scope under which the implement-time RED gate can find/author test
 * files. Reuses work-orchestrator/lib/gherkin-task-refs when available.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');
const { parseBlocks } = require('./kind_assign');
const {
  scopeEntryCanMatchTestFiles,
} = require('../../../../../skills/split-in-tasks/lib/task-types');

let validateConsistency;
try {
  ({ validateConsistency } = require('../../../work/lib/gherkin-task-refs'));
} catch {
  validateConsistency = null;
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function extractScenarioTitles(text) {
  if (!text) return [];
  const out = [];
  const re = /^\s*Scenario(?:\s+Outline)?:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Count `@task:N`-tagged scenarios per task number. Tag semantics mirror the
 * implement-side parser (task-next.js parseGherkinScenarios): tag lines
 * accumulate until the next `Scenario:` / `Scenario Outline:` line consumes
 * them.
 */
function countTaggedScenarios(gherkin) {
  const counts = new Map();
  let pendingTags = [];
  for (const raw of gherkin.split('\n')) {
    const t = raw.trim();
    if (t.startsWith('@')) {
      pendingTags = pendingTags.concat(t.split(/\s+/));
      continue;
    }
    if (/^(Scenario|Scenario Outline):/.test(t)) {
      for (const tag of pendingTags) {
        const m = tag.match(/^@task:(\d+)$/);
        if (m) {
          const n = Number(m[1]);
          counts.set(n, (counts.get(n) || 0) + 1);
        }
      }
      pendingTags = [];
    }
  }
  return counts;
}

/**
 * #489 / #491 defense: a task that owns `@task:N` scenarios but whose
 * `### Files in scope` cannot match any test file is unimplementable — at
 * RED, `scenariosCoveredByTests` demands each tagged scenario appear in a
 * test file under the task's scope, while `protect-task-scope` blocks
 * creating test files outside it. Catch the contradiction here, where
 * tasks.md and gherkin.feature are still editable.
 */
function validateScenarioSatisfiability(gherkin, tasksText) {
  const errors = [];
  const counts = countTaggedScenarios(gherkin);
  if (!counts.size) return errors;
  for (const block of parseBlocks(tasksText)) {
    const n = counts.get(block.num);
    if (!n) continue;
    if (block.filesInScope.some(scopeEntryCanMatchTestFiles)) continue;
    errors.push(
      `Task ${block.num} owns ${n} @task:${block.num}-tagged scenario(s) in gherkin.feature but its \`### Files in scope\` admits no test files — the RED gate would be unsatisfiable at implement. Either add a \`*.test.*\` entry (or a directory/glob that admits one) to the task's scope, move the @task:${block.num} tag to the task that owns the tests, or drop the tag and verify via the task's \`### Test Strategy\` command.`
    );
  }
  return errors;
}

/**
 * Run the canonical gherkin-task-refs validator. Returns
 * `{ done: boolean, errors: string[] }` — `done: true` means the canonical
 * verdict is final (pass or fail) and the naive fallback must be skipped
 * (it can produce false positives via tasks.includes(title) on titles
 * referenced through Acceptance Criteria or Requirements Covered).
 */
function runCanonicalConsistency(gherkin, tasks) {
  if (typeof validateConsistency !== 'function') return { done: false, errors: [] };
  try {
    const result = validateConsistency({ gherkinText: gherkin, tasksMdText: tasks });
    if (result && Array.isArray(result.errors) && result.errors.length) {
      return { done: true, errors: result.errors.map((e) => `gherkin-task-refs: ${e}`) };
    }
    if (result && result.valid === true) return { done: true, errors: [] };
    return { done: false, errors: [] };
  } catch (e) {
    // Validator threw — surface it and fall through to the naive check.
    return { done: false, errors: [`gherkin-task-refs threw: ${e.message}`] };
  }
}

/** Naive fallback: every scenario title must appear somewhere in tasks.md. */
function naiveScenarioCoverage(gherkin, tasks) {
  const errors = [];
  for (const title of extractScenarioTitles(gherkin)) {
    if (!tasks.includes(title)) {
      errors.push(
        `Scenario "${title}" from gherkin.feature is not referenced by any task in tasks.md. Add the scenario title to the relevant task's \`### Acceptance Criteria\` or \`### Requirements Covered\`.`
      );
    }
  }
  return errors;
}

function validateArtifacts(tasksDir) {
  const gherkin = readFile(path.join(tasksDir, 'gherkin.feature'));
  // No gherkin.feature → nothing to link → auto-pass.
  if (!gherkin) return [];
  const tasks = readFile(path.join(tasksDir, 'tasks.md'));
  if (!tasks) return ['Missing tasks.md.'];
  const satisfiability = validateScenarioSatisfiability(gherkin, tasks);
  if (satisfiability.length) return satisfiability;
  const canonical = runCanonicalConsistency(gherkin, tasks);
  if (canonical.done) return canonical.errors;
  return [...canonical.errors, ...naiveScenarioCoverage(gherkin, tasks)];
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length) return { ok: false, errors };
  const gherkin = readFile(path.join(ctx.tasksDir, 'gherkin.feature'));
  return {
    ok: true,
    summary: gherkin ? 'every Gherkin scenario linked to a task' : 'no gherkin.feature — skipped',
  };
}

function instructions(ctx) {
  return [
    `# tasks-next — Phase 6 of 7: GHERKIN LINK`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    '- If `gherkin.feature` exists: every `Scenario:` (and `Scenario Outline:`) is referenced by ≥1 task.',
    '- Reference can be in the task title, `### Acceptance Criteria`, or `### Requirements Covered`.',
    '- Every task with `@task:N`-tagged scenarios has a `### Files in scope` that admits test files (RED-gate satisfiability).',
    '',
    'If no `gherkin.feature` exists, this phase auto-passes.',
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.gherkin_link, {
    next: TASKS_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.extractScenarioTitles = extractScenarioTitles;
module.exports.countTaggedScenarios = countTaggedScenarios;
module.exports.validateScenarioSatisfiability = validateScenarioSatisfiability;
