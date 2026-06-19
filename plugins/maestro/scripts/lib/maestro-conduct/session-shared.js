/**
 * session-shared.js — helpers shared between maestro-session.js (CLI) and
 * active-session-reminder.js (UserPromptSubmit hook). Extracted to satisfy
 * the duplicate-blocks quality gate.
 */
'use strict';

const namespace = require('./namespace');

function getSessionDir() {
  // Per-namespace when MAESTRO_NS is set so a namespaced conductor never
  // reconciles another project's pools (GH-622). MAESTRO_SESSION_DIR overrides.
  return namespace.sessionManifestDir();
}

function countByStatus(tasks) {
  const counts = { pending: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const t of tasks || []) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
}

function doneIdSet(tasks) {
  return new Set((tasks || []).filter((t) => t.status === 'done').map((t) => t.id));
}

function eligibleTasks(tasks) {
  const done = doneIdSet(tasks);
  return (tasks || [])
    .filter((t) => t.status === 'pending')
    .filter((t) => (t.deps || []).every((d) => done.has(d)))
    .sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

module.exports = {
  get SESSION_DIR() {
    return getSessionDir();
  },
  getSessionDir,
  countByStatus,
  doneIdSet,
  eligibleTasks,
};
