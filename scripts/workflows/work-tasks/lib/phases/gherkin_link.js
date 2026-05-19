/**
 * Phase: gherkin_link — if gherkin.feature exists, every scenario must be
 * referenced by ≥1 task. Reuses work2/lib/gherkin-task-refs when available.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');

let validateConsistency;
try {
  ({ validateConsistency } = require('../../../work2/lib/gherkin-task-refs'));
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

function validateArtifacts(tasksDir) {
  const errors = [];
  const gherkin = readFile(path.join(tasksDir, 'gherkin.feature'));
  if (!gherkin) {
    // No gherkin.feature → nothing to link → auto-pass.
    return errors;
  }
  const tasks = readFile(path.join(tasksDir, 'tasks.md'));
  if (!tasks) {
    errors.push(`Missing tasks.md.`);
    return errors;
  }
  // Use the canonical validator if available.
  if (typeof validateConsistency === 'function') {
    try {
      const result = validateConsistency(gherkin, tasks);
      if (result && Array.isArray(result.errors) && result.errors.length) {
        for (const e of result.errors) errors.push(`gherkin-task-refs: ${e}`);
        return errors;
      }
      if (result && result.ok === false && result.message) {
        errors.push(`gherkin-task-refs: ${result.message}`);
        return errors;
      }
    } catch (e) {
      // Validator threw — fall through to our own check below.
      errors.push(`gherkin-task-refs threw: ${e.message}`);
    }
  }
  // Fallback: best-effort coverage check.
  const scenarios = extractScenarioTitles(gherkin);
  if (!scenarios.length) {
    return errors;
  }
  for (const title of scenarios) {
    // Look for the scenario title literal in tasks.md.
    if (!tasks.includes(title)) {
      errors.push(
        `Scenario "${title}" from gherkin.feature is not referenced by any task in tasks.md. Add the scenario title to the relevant task's \`### Acceptance Criteria\` or \`### Requirements Covered\`.`
      );
    }
  }
  return errors;
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
