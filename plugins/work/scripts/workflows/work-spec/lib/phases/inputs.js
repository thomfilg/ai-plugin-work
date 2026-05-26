/**
 * Phase: inputs — read brief.md, related-tickets.json, recall memory.
 *
 * The spec phase consumes what brief produced. We validate that brief.md
 * and related-tickets.json exist; reading them is the agent's job.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SPEC_PHASES } = require('../../spec-phase-registry');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const briefPath = path.join(tasksDir, 'brief.md');
  if (!fs.existsSync(briefPath)) {
    errors.push(`Missing ${briefPath}. The brief step must complete before spec begins.`);
  } else {
    const c = readFile(briefPath);
    if (!c || c.trim().length < 100) {
      errors.push(`${briefPath} is empty or too short (< 100 chars).`);
    }
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    summary: `linked=${ctx.linkedIds.length} memory=${ctx.memory ? ctx.memory.name : 'none'}`,
  };
}

function instructions(ctx) {
  const { ticket, tasksDir, linkedIds, memory } = ctx;
  const memBlock = memory
    ? [
        '',
        `### 0. Recall prior memory (${memory.name})`,
        `Before reading anything, call \`${memory.recallTool}\` for each:`,
        `- \`${ticket}\``,
        `- "${ticket} spec"`,
        `- "${ticket} architecture"`,
        `- "past decisions" + the area of work`,
        '',
        'Treat hits as authoritative prior context — read them fully before drafting.',
      ]
    : ['', '### 0. Recall prior memory', 'No memory plugin detected — skipping.'];
  return [
    `# spec-next — Phase 1 of 8: INPUTS`,
    `Ticket: ${ticket}`,
    `Tasks dir: ${tasksDir}`,
    '',
    ...memBlock,
    '',
    '### 1. Read the brief',
    `Open \`${path.join(tasksDir, 'brief.md')}\` in full. Note the P0/P1/P2 requirements, hard constraints, Out-of-scope (sibling-owned) section, and Open Questions.`,
    '',
    '### 2. Read related-tickets.json',
    linkedIds.length
      ? `\`related-tickets.json\` lists ${linkedIds.length} linked ticket(s): ${linkedIds.join(', ')}. Re-read \`_related/<id>.md\` for any sibling whose owned surface this spec will depend on.`
      : 'No linked tickets — solo ticket. Skip sibling re-read.',
    '',
    '### What I will check before advancing',
    `- \`${path.join(tasksDir, 'brief.md')}\` exists and is non-trivial (≥ 100 chars)`,
    '',
    'When done, re-invoke me.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.inputs, {
    next: SPEC_PHASES.reuse_audit,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
