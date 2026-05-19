/**
 * Phase: inputs — brief.md + spec.md must exist.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');

function validateArtifacts(tasksDir) {
  const errors = [];
  const brief = path.join(tasksDir, 'brief.md');
  const spec = path.join(tasksDir, 'spec.md');
  if (!fs.existsSync(brief)) errors.push(`Missing ${brief}. Run the brief step first.`);
  if (!fs.existsSync(spec)) errors.push(`Missing ${spec}. Run the spec step first.`);
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length) return { ok: false, errors };
  return { ok: true, summary: 'brief.md + spec.md present' };
}

function instructions(ctx) {
  const { ticket, tasksDir, memory } = ctx;
  const memBlock = memory
    ? [
        '',
        `### 0. Recall prior memory (${memory.name})`,
        `Call \`${memory.recallTool}\` for each:`,
        `- \`${ticket}\``,
        `- "${ticket} tasks"`,
        `- "task decomposition patterns" + the area of work`,
        '',
      ]
    : ['', '### 0. Recall prior memory', 'No memory plugin detected — skipping.', ''];
  return [
    `# tasks-next — Phase 1 of 7: INPUTS`,
    `Ticket: ${ticket}`,
    `Tasks dir: ${tasksDir}`,
    '',
    ...memBlock,
    '### 1. Read brief.md and spec.md in full',
    'You will decompose the spec into ordered, dependency-aware tasks. Skim both before you start; you cannot do this from titles alone.',
    '',
    '### What I will check before advancing',
    `- \`brief.md\` exists`,
    `- \`spec.md\` exists`,
    '',
    'Re-invoke me to proceed.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.inputs, {
    next: TASKS_PHASES.requirements_extract,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
