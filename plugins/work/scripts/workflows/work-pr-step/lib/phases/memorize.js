/**
 * Phase: memorize — persist PR decisions to the memory plugin if installed.
 *
 * This gate used to require the driving agent to (a) call the memory plugin's
 * remember tool and (b) append `<!-- pr-memorized -->` to pr-body.md as
 * self-attestation. The `pr-generator` agent that drives this runner can do
 * neither: `agents/pr-generator.md` grants it no Write tool and no MCP memory
 * binding, so the phase was unsatisfiable and blocked the pr step outright.
 *
 * Two changes. The runner writes the sentinel itself, because a marker the
 * agent writes about its own behaviour proves nothing anyway — the same reason
 * the TDD gates refuse agent self-reports. And the facts worth remembering are
 * facts the RUNNER holds (ticket, PR number, url, base branch, changed files),
 * so it persists them to `pr-memory.json` and gates on that artifact instead.
 * Whoever holds the memory binding — the orchestrator, a later `/work` step —
 * can read the payload and push it; the pr step no longer waits on an MCP call
 * its own driver cannot make.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_PHASES } = require('../../pr-phase-registry');

const SENTINEL = '<!-- pr-memorized -->';
const MEMORY_FILE = 'pr-memory.json';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** The PR facts worth handing to a memory plugin, from what the runner knows. */
function buildPayload(ctx) {
  const pctx = readJson(path.join(ctx.tasksDir, 'pr-context.json')) || {};
  return {
    ticket: ctx.ticket,
    prNumber: pctx.prNumber ?? null,
    url: pctx.url ?? null,
    baseBranch: pctx.base ?? null,
    changedFiles: Array.isArray(pctx.files) ? pctx.files : [],
    linkedTickets: ctx.linkedIds || [],
    memoryPlugin: ctx.memory ? ctx.memory.name : null,
    rememberTool: ctx.memory ? ctx.memory.rememberTool : null,
  };
}

/**
 * Persist the payload and stamp the sentinel into pr-body.md.
 *
 * @returns {boolean} true when both are on disk.
 */
function persist(ctx) {
  const bodyPath = path.join(ctx.tasksDir, 'pr-body.md');
  const body = readFile(bodyPath);
  if (body === null) return false;
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, MEMORY_FILE),
      `${JSON.stringify(buildPayload(ctx), null, 2)}\n`
    );
    if (!body.includes(SENTINEL)) {
      fs.writeFileSync(bodyPath, `${body.endsWith('\n') ? body : `${body}\n`}\n${SENTINEL}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin — auto-passing' };
  if (!readFile(path.join(ctx.tasksDir, 'pr-body.md'))) {
    return { ok: false, errors: [`Missing pr-body.md.`] };
  }
  if (!persist(ctx)) {
    return {
      ok: false,
      errors: [
        `Could not write ${MEMORY_FILE} / the \`${SENTINEL}\` sentinel into ${ctx.tasksDir}. ` +
          `Check the directory is writable.`,
      ],
    };
  }
  return { ok: true, summary: `PR decisions recorded to ${MEMORY_FILE}` };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [`# pr-next — Phase 7 of 8: MEMORIZE`, '', 'No memory plugin. Auto-advancing.', ''].join(
      '\n'
    );
  }
  return [
    `# pr-next — Phase 7 of 8: MEMORIZE (${ctx.memory.name})`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I do',
    `- Write the PR facts (number, url, base branch, changed files) to \`${path.join(
      ctx.tasksDir,
      MEMORY_FILE
    )}\`.`,
    `- Append \`${SENTINEL}\` to pr-body.md.`,
    'Nothing for you to write — this phase advances on its own.',
    '',
    '### For whoever holds the memory binding',
    `\`${ctx.memory.rememberTool}\` is not available to the read-only pr-generator that drives ` +
      `this runner. Read \`${MEMORY_FILE}\` and persist it from a context that has the tool.`,
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.memorize, {
    next: PR_PHASES.done,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.buildPayload = buildPayload;
module.exports.persist = persist;
module.exports.SENTINEL = SENTINEL;
module.exports.MEMORY_FILE = MEMORY_FILE;
