/**
 * Context injection enrichment.
 *
 * Injects ticket context (title + body) and file paths for artifacts.
 * For small files (ticket.json), inlines the content.
 * For larger files (brief, spec, tasks), provides paths + "READ THIS FIRST" instructions
 * so the agent reads the full content instead of getting truncated text.
 *
 * Resume handoff (GH-315): on `spec`/`tasks`/`implement` steps, when a
 * `.continue-here.md` handoff exists for the ticket, a "Continue Here (read
 * FIRST)" block is prepended AHEAD of the "Required Reading" block, the
 * transient `resumeHandoffPending` marker is set on `.work-state.json` (through
 * the work-state writer, never a direct edit), and the handoff is deleted after
 * the first successful post-resume step advance so stale narrative is never
 * re-injected. All handoff paths fail-open — a missing/unreadable handoff or an
 * unavailable work-state writer leaves the existing Required Reading path
 * byte-identical to its pre-change output.
 */

'use strict';

const path = require('path');

const handoff = require(path.join(__dirname, '..', '..', '..', 'lib', 'handoff'));
const { loadWorkState, saveWorkState } = require(path.join(__dirname, '..', 'work-helpers'));

const TICKET_CONTEXT_STEPS = ['brief', 'spec', 'implement'];
const ARTIFACT_STEPS = ['spec', 'tasks', 'implement'];

/**
 * Derive the tasks-base + ticket pair the work-state writer keys on. The
 * enrichment ctx carries the resolved ticket dir (`tasksDir` =
 * `<TASKS_BASE>/<ticket>`); `loadWorkState`/`saveWorkState` re-join
 * `<tasksBase>/<ticket>/.work-state.json`, so we split the dir back into its
 * parent base + leaf ticket rather than trusting a possibly-stale env var.
 *
 * @param {object} ctx enrichment context (`tasksDir`, `ticket`)
 * @returns {{ tasksBase: string, ticket: string }|null} null when unresolvable
 */
function resolveWorkStateKey(ctx) {
  if (!ctx || !ctx.tasksDir) return null;
  const tasksBase = path.dirname(ctx.tasksDir);
  const ticket = path.basename(ctx.tasksDir);
  if (!tasksBase || !ticket) return null;
  return { tasksBase, ticket };
}

/** Set (true) or clear (delete) the transient resumeHandoffPending marker. */
function setResumeHandoffPending(ctx, pending) {
  try {
    const key = resolveWorkStateKey(ctx);
    if (!key) return;
    const state = loadWorkState(key.tasksBase, key.ticket);
    if (!state) return;
    if (pending) state.resumeHandoffPending = true;
    else delete state.resumeHandoffPending;
    saveWorkState(key.tasksBase, key.ticket, state);
  } catch {
    /* fail-open — the marker is a best-effort hint */
  }
}

/** True when the transient resumeHandoffPending marker is set on work-state. */
function isResumeHandoffPending(ctx) {
  try {
    const key = resolveWorkStateKey(ctx);
    if (!key) return false;
    const state = loadWorkState(key.tasksBase, key.ticket);
    return Boolean(state && state.resumeHandoffPending);
  } catch {
    return false;
  }
}

/**
 * Build the "Continue Here (read FIRST)" block that points the resuming agent
 * at the durable `.continue-here.md` handoff. Returns null when no handoff
 * exists for the ticket (fail-open — the enricher then leaves Required Reading
 * untouched).
 *
 * @param {object} ctx enrichment context (`tasksDir`, `path`, `fs`)
 * @returns {string|null} the block text, or null when there is no handoff
 */
function buildContinueHereBlock(ctx) {
  const p = ctx.path || path;
  const handoffPath = p.join(ctx.tasksDir, handoff.HANDOFF_FILENAME);
  if (!ctx.fs || !ctx.fs.existsSync(handoffPath)) return null;
  const lines = [
    '\n\n## Continue Here (read FIRST)',
    `This ticket was paused. A handoff was left at: ${handoffPath}`,
    '',
    `Read \`${handoff.HANDOFF_FILENAME}\` IN FULL before anything else — it records the`,
    'prior decisions, open blockers, and what was in flight. Only then read the',
    'Required Reading below.',
  ];
  return lines.join('\n');
}

/**
 * Clear the resume handoff after the first successful post-resume step advance:
 * when `resumeHandoffPending` is set, delete `.continue-here.md` (so it is not
 * re-injected into the next step) and clear the marker. Intentionally leaves
 * the delete UNCOMMITTED — the next real step's commit sweeps the removal (the
 * pause WIP commit included the file). No-op + fail-open when the marker is not
 * set or the handoff is already gone.
 *
 * @param {object} ctx enrichment context (`tasksDir`, `ticket`)
 */
function clearResumeHandoff(ctx) {
  try {
    if (!isResumeHandoffPending(ctx)) return;
    const key = resolveWorkStateKey(ctx);
    const ticket = ctx && ctx.ticket ? ctx.ticket : key && key.ticket;
    if (ticket) handoff.deleteHandoff(ticket);
    setResumeHandoffPending(ctx, false);
  } catch {
    /* fail-open — clearing is best-effort */
  }
}

/**
 * Collect the brief/spec/tasks artifacts that exist on disk for a ticket, in
 * required-reading order. Returns `{ name, path }` entries; empty when none
 * exist.
 *
 * @param {string} tasksDir resolved ticket task directory
 * @param {object} p path module (from ctx, falls back to node `path`)
 * @param {object} fs fs module (from ctx)
 * @returns {Array<{ name: string, path: string }>}
 */
function collectArtifacts(tasksDir, p, fs) {
  const candidates = [
    { name: 'Brief', file: 'brief.md' },
    { name: 'Spec', file: 'spec.md' },
    { name: 'Tasks', file: 'tasks.md' },
  ];
  const artifacts = [];
  for (const { name, file } of candidates) {
    const full = p.join(tasksDir, file);
    if (fs.existsSync(full)) artifacts.push({ name, path: full });
  }
  return artifacts;
}

/** Build the "Required Reading" block text for the given artifacts. */
function buildRequiredReadingBlock(artifacts) {
  const lines = ['\n\n## Required Reading (MUST read before starting)'];
  for (const a of artifacts) {
    lines.push(`- **${a.name}:** ${a.path}`);
  }
  lines.push('');
  lines.push('Read these files IN FULL before implementing. Do NOT skip or skim.');
  return lines.join('\n');
}

module.exports = function registerContextInject(register) {
  // Inject ticket context (small — always inline)
  for (const stepName of TICKET_CONTEXT_STEPS) {
    register(stepName, (entry, ctx) => {
      const { tasksDir, path: p, fs } = ctx;
      const ticketFile = p.join(tasksDir, 'ticket.json');
      if (!fs.existsSync(ticketFile)) return;
      try {
        const ticketData = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
        const contextBlock = `\n\n## Ticket Context\nTitle: ${ticketData.title}\nState: ${ticketData.state}\n\n${ticketData.body || '(no body)'}`;
        entry.agentPrompt = (entry.agentPrompt || '') + contextBlock;
      } catch {
        /* fail-open */
      }
    });
  }

  // Inject artifact file paths with read instructions (no truncation), prefixed
  // by the resume handoff block when a `.continue-here.md` exists.
  for (const stepName of ARTIFACT_STEPS) {
    register(stepName, (entry, ctx) => {
      const artifacts = collectArtifacts(ctx.tasksDir, ctx.path, ctx.fs);
      if (artifacts.length === 0) return;

      const requiredReading = buildRequiredReadingBlock(artifacts);

      // Prepend the resume handoff AHEAD of Required Reading when one exists.
      const continueHere = buildContinueHereBlock(ctx);
      if (continueHere) setResumeHandoffPending(ctx, true);
      const block = continueHere ? continueHere + requiredReading : requiredReading;

      entry.agentPrompt = (entry.agentPrompt || '') + block;
    });
  }
};

module.exports.clearResumeHandoff = clearResumeHandoff;
