/**
 * next-task.js — helpers for locating the next eligible pending task across
 * orchestration manifests, and for building the operator-facing NEXT_ACTION
 * instruction line. Extracted from actions.js so that file stays under the
 * max-lines gate.
 */
const fs = require('fs');
const path = require('path');
const { eligibleTasks } = require('./session-shared');

const SESSION_MANIFEST_DIR =
  process.env.MAESTRO_SESSION_DIR ||
  path.join(process.env.HOME || '/tmp', '.cache', 'maestro', 'sessions');

function readManifestSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function topPendingForManifest(manifest, entry) {
  // Reuse session-shared.eligibleTasks so the slot-freed bootstrap path and
  // the maestro-session CLI agree on the next task (incl. default priority).
  const ranked = eligibleTasks(Array.isArray(manifest.tasks) ? manifest.tasks : []);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  return {
    topic: manifest.topic || entry.replace(/\.json$/, ''),
    taskId: top.id,
    priority: top.priority,
  };
}

function findEligibleTasks() {
  if (!fs.existsSync(SESSION_MANIFEST_DIR)) return [];
  // Sort manifest filenames so readdirSync iteration order is deterministic
  // across filesystems. This gives a stable tie-break by filename when two
  // eligible tasks share the same numeric priority (the natural tie-break
  // here is ticket id, since manifest filenames are derived from topic/ticket).
  const entries = fs.readdirSync(SESSION_MANIFEST_DIR).slice().sort();
  const candidates = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const manifest = readManifestSafe(path.join(SESSION_MANIFEST_DIR, entry));
    if (!manifest) continue;
    const candidate = topPendingForManifest(manifest, entry);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return candidates;
}

function findNextEligibleTask() {
  return findEligibleTasks()[0] || null;
}

function buildNextActionInstruction({ prefix, suffix, next, autoBootstrapped }) {
  if (autoBootstrapped) {
    return `${prefix}NEXT_ACTION=auto-bootstrapped ${next.taskId} from manifest "${next.topic}". No operator action needed unless bootstrap log shows failure.`;
  }
  if (next) {
    return `${prefix}NEXT_ACTION=bootstrap ${next.taskId} (manifest "${next.topic}", priority=${next.priority}). Run: bash plugins/maestro/scripts/maestro-bootstrap.sh ${next.taskId}. Set AUTO_BOOTSTRAP_NEXT=1 to skip this step.${suffix}`;
  }
  return `${prefix}NEXT_ACTION=do-nothing — no eligible pending task across orchestration manifests.${suffix}`;
}

module.exports = {
  SESSION_MANIFEST_DIR,
  findNextEligibleTask,
  findEligibleTasks,
  buildNextActionInstruction,
};
