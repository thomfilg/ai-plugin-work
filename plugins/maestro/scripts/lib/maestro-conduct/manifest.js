/**
 * manifest.js — read/write helpers for orchestration manifests at
 * ~/.cache/maestro/sessions/<topic>.json.
 *
 * The daemon already READS manifests (findNextEligibleTask). This module
 * adds WRITE support so phase transitions (bootstrap, slot-freed, dead-end,
 * auto-restart) round-trip into the manifest — operator sees a live view of
 * pool state without polling tmux.
 */
const fs = require('fs');
const path = require('path');
const namespace = require('./namespace');

// Per-namespace when MAESTRO_NS is set (GH-622) so syncFromTmux reconciles only
// this namespace's pools against its (namespace-narrow) alive set — otherwise a
// second conductor would mark another project's running tasks stopped.
// MAESTRO_SESSION_DIR overrides.
const SESSION_MANIFEST_DIR = namespace.sessionManifestDir();

function listManifestFiles() {
  if (!fs.existsSync(SESSION_MANIFEST_DIR)) return [];
  return fs
    .readdirSync(SESSION_MANIFEST_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(SESSION_MANIFEST_DIR, f));
}

function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(file, manifest) {
  try {
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the manifest file + task entry for a ticket id. When the same ticket
 * appears in SEVERAL manifests (a re-orchestrated batch next to a stale
 * 12-day-old one), the manifest with the NEWEST createdAt wins — readdir
 * order used to pick whichever sorted first, which silently resolved a
 * ticket to the stale manifest's null stopOracle and disabled the whole
 * stop-condition pipeline for the live run.
 * Returns { file, manifest, task } or null.
 */
function findTask(taskId) {
  let best = null;
  for (const file of listManifestFiles()) {
    const manifest = readManifest(file);
    if (!manifest || !Array.isArray(manifest.tasks)) continue;
    const task = manifest.tasks.find((t) => t.id === taskId);
    if (!task) continue;
    const createdAt = Date.parse(manifest.createdAt || '') || 0;
    if (!best || createdAt > best.createdAt) best = { file, manifest, task, createdAt };
  }
  if (!best) return null;
  return { file: best.file, manifest: best.manifest, task: best.task };
}

/**
 * Update a task's status/note in whichever manifest owns it. No-op if the
 * task is not registered — manifests are append-only by the operator; the
 * daemon never invents new entries.
 */
function updateTaskStatus(taskId, status, note) {
  const hit = findTask(taskId);
  if (!hit) return false;
  hit.task.status = status;
  if (note !== undefined) hit.task.note = note;
  hit.task.updatedAt = new Date().toISOString();
  return writeManifest(hit.file, hit.manifest);
}

/**
 * Reconcile manifest task statuses against live tmux work-sessions.
 *
 *   - Each ticket with a live `<TICKET>-work` tmux session is marked
 *     `in_progress` (if not already terminal: awaiting-merge|blocked|done).
 *   - Each ticket currently `in_progress` whose tmux session vanished
 *     (killed by operator or by daemon rotation) is marked `stopped`.
 *
 * Terminal statuses are NEVER overwritten — operator owns those transitions.
 */
const TERMINAL = new Set(['awaiting-merge', 'blocked', 'done']);

function aliveTicketSet(activeWorkSessions) {
  return new Set(
    (activeWorkSessions || [])
      .map((s) => {
        // Tolerate an optional "<ns>/" segment so MAESTRO_NS-scoped session
        // names (e.g. "proj-a/GH-42-work") still reconcile to the ticket id.
        const m = s.match(/(?:^|\/)([A-Z][A-Z0-9]*-\d+)-work$/);
        return m ? m[1] : null;
      })
      .filter(Boolean)
  );
}

function reconcileTask(task, aliveTickets) {
  if (TERMINAL.has(task.status)) return false;
  const isAlive = aliveTickets.has(task.id);
  if (isAlive && task.status !== 'in_progress') {
    task.status = 'in_progress';
    task.note = 'tmux session detected by daemon';
    task.updatedAt = new Date().toISOString();
    return true;
  }
  if (!isAlive && task.status === 'in_progress') {
    task.status = 'stopped';
    task.note = 'tmux session gone (killed or exited)';
    task.updatedAt = new Date().toISOString();
    return true;
  }
  return false;
}

function syncFromTmux(activeWorkSessions) {
  // Guard: an empty input is ambiguous — could be a real "no sessions" state
  // or a transient `tmux ls` failure / prefix mismatch / mid-restart gap.
  // Refusing to demote `in_progress → stopped` on empty input means the
  // operator must manually clear stale entries when they really kill the
  // whole pool, but it prevents a flapping manifest in the failure cases.
  if (!Array.isArray(activeWorkSessions) || activeWorkSessions.length === 0) {
    return;
  }
  const aliveTickets = aliveTicketSet(activeWorkSessions);
  for (const file of listManifestFiles()) {
    const m = readManifest(file);
    if (!m || !Array.isArray(m.tasks)) continue;
    let dirty = false;
    for (const task of m.tasks) {
      if (reconcileTask(task, aliveTickets)) dirty = true;
    }
    if (dirty) writeManifest(file, m);
  }
}

/**
 * Pool-size check scoped to the manifest owning `taskId`. Counts live
 * work-sessions for tickets in THAT manifest and compares against THAT
 * manifest's `slots`. Returns false if the task isn't in any manifest
 * (caller should treat unknown tickets as ungated).
 *
 * Per-task scoping prevents one full manifest from blocking auto-bootstrap
 * of eligible work in a different manifest that still has free capacity.
 */
function poolFullForTask(taskId, activeWorkSessions) {
  const hit = findTask(taskId);
  if (!hit) return false;
  const { manifest: m } = hit;
  if (typeof m.slots !== 'number' || !Array.isArray(m.tasks)) return false;
  const aliveTickets = aliveTicketSet(activeWorkSessions);
  // `done` tickets whose session is deliberately kept alive (post-oracle
  // park, operator inspection) must not hold a slot against fresh work.
  const liveInThisManifest = m.tasks.filter(
    (t) => aliveTickets.has(t.id) && t.status !== 'done'
  ).length;
  return liveInThisManifest >= m.slots;
}

/**
 * stopOracleForTask — the compiled shell predicate the conductor evaluates each
 * tick to decide whether a ticket is done. Null when the owning manifest
 * declares none (then no stop-condition rotation happens for that ticket, and
 * the ticket's command must be a whitelisted skill). Reading from the manifest
 * (not env) is what lets a daemon restart re-derive the oracle.
 */
function stopOracleForTask(taskId) {
  const hit = findTask(taskId);
  const oracle = hit && hit.manifest && hit.manifest.stopOracle;
  return oracle ? String(oracle) : null;
}

/**
 * commandForTask — the command recorded in the owning manifest for a ticket
 * (informational / generic-row gating). Null when unknown. The authoritative
 * launch skill still lives in the per-ticket `.maestro-skill` file
 * (skill-registry); this is the orchestration record's copy.
 */
function commandForTask(taskId) {
  const hit = findTask(taskId);
  const cmd = hit && hit.manifest && hit.manifest.command;
  return cmd ? String(cmd).replace(/^\//, '') : null;
}

/**
 * launchConfigForTask — one manifest lookup returning everything ctxFor needs
 * about how the ticket was launched: the command and the operator-authored
 * command brief (what the command does / what "done" means). The brief rides
 * along in alert payloads so the operator LLM answers agent questions in the
 * agent's OWN workflow vocabulary instead of guessing /work semantics.
 */
function launchConfigForTask(taskId) {
  const hit = findTask(taskId);
  if (!hit || !hit.manifest) return { command: null, commandBrief: null };
  const m = hit.manifest;
  return {
    command: m.command ? String(m.command).replace(/^\//, '') : null,
    commandBrief: m.commandBrief ? String(m.commandBrief) : null,
  };
}

module.exports = {
  listManifestFiles,
  readManifest,
  writeManifest,
  findTask,
  updateTaskStatus,
  syncFromTmux,
  poolFullForTask,
  stopOracleForTask,
  commandForTask,
  launchConfigForTask,
};
