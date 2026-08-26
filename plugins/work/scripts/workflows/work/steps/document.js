/**
 * Step: document
 *
 * Between `ready` and `follow_up`: record what this ticket's work taught,
 * while the run still remembers it. Placed BEFORE follow_up deliberately —
 * follow-up churn (bot comments, CI retries, force-pushes) is the point where
 * context gets overwritten, and after the merge nobody comes back to write the
 * note down.
 *
 * This step NEVER defers. Every other post-PR step has a "nothing to do here"
 * branch; this one does not, because "nothing to record" is exactly the
 * outcome the step exists to prevent. The transition gate refuses to leave
 * `document` until `.document-notes.json` holds a note that survives
 * re-checking (see workflow-def/step-verifiers.js verifyDocument), so an agent
 * that skips the work cannot advance past it.
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
const path = require('path');

const { detectMemoryPlugin } = require(
  path.join(__dirname, '..', '..', 'lib', 'detect-memory-plugin')
);

const NOTE_CLI = '$CLAUDE_PLUGIN_ROOT/scripts/workflows/work-document/document-note.js';

/**
 * The sink half of the prompt: where this machine requires the note to land.
 *
 * `worktreeDir` can be null during description-mode planning (no ticket, no
 * configured bases yet — see plan-generator resolvePlanPaths). The prompt still
 * has to render, so an unresolved worktree names the repo-relative path and
 * lets `document-note.js sink` resolve the absolute one at run time.
 */
function docsNotePath(ticket, worktreeDir) {
  const rel = path.join('docs', 'work-notes', `${ticket}.md`);
  return worktreeDir ? path.join(worktreeDir, rel) : `<ticket worktree>/${rel}`;
}

function sinkInstructions(ticket, memory, worktreeDir) {
  if (memory) {
    return [
      `A memory plugin is configured: **${memory.name}**.`,
      `1. Call \`${memory.rememberTool}\` with the note (ticket id, what changed, what`,
      `   surprised you, what the next run should know before touching this area).`,
      `2. Record it so the step can verify it:`,
      `   \`node ${NOTE_CLI} record ${ticket} --tool ${memory.rememberTool} --summary "<the same note>"\``,
    ].join('\n');
  }
  return [
    'No memory plugin is configured on this machine, so the note goes to the worktree.',
    `1. Write it to \`${docsNotePath(ticket, worktreeDir)}\` —`,
    '   what changed, what surprised you, what the next run should know first.',
    '2. Record it so the step can verify it:',
    `   \`node ${NOTE_CLI} record ${ticket} --summary "<the same note>"\``,
  ].join('\n');
}

module.exports = function documentStep(add, s, ctx) {
  const { STEPS, ticket, t, worktreeDir } = ctx;
  const id = ticket || t;
  const memory = detectMemoryPlugin();

  const prompt = [
    `Record what the work on ${id} taught, before follow-up churn overwrites the context.`,
    '',
    'Read the ticket artifacts first — brief.md, spec.md, tasks.md, the *.check.md',
    'reports and the PR diff — then write ONE note in your own words. Not a changelog:',
    'the decisions, the surprises, the dead ends, and what the next run should know',
    'before touching this area again.',
    '',
    sinkInstructions(id, memory, worktreeDir),
    '',
    `Confirm with \`node ${NOTE_CLI} verify ${id}\`. The step will not advance until it passes.`,
  ].join('\n');

  add(STEPS.document, 'RUN', 'Task(work-documenter)', 'Record notes on this ticket', {
    agentType: 'work-documenter',
    agentPrompt: prompt,
  });
};

module.exports.sinkInstructions = sinkInstructions;
module.exports.docsNotePath = docsNotePath;
