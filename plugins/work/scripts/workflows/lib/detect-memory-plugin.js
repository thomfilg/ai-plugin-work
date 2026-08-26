/**
 * detect-memory-plugin.js — is a memory plugin (cortex / mem0 / a configured
 * replacement) installed for this user?
 *
 * Extracted from phase-runner/create-phase-runner.js so the `document` step's
 * planner and its verifier answer the question with the SAME code the phase
 * runners use. Two detectors would let the step tell an agent "no memory
 * plugin — write to worktree docs" while the gate demanded a memory note.
 *
 * Candidates and their tool names come from work-brief/lib/memory-plugin-config
 * (env-overridable; `BRIEF_MEMORY_DISABLED=1` turns detection off entirely).
 * Detection is a directory probe over the installed plugin manifests, so it
 * answers "configured", not "reachable" — a plugin present but failing at call
 * time is the agent's problem to report, not something a probe can see.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * @param {object} [env] — defaults to process.env.
 * @returns {{name: string, recallTool: string, rememberTool: string, saveTool: ?string}|null}
 */
function detectMemoryPlugin(env = process.env) {
  try {
    const { loadMemoryPluginCandidates } = require(
      path.join(__dirname, '..', 'work-brief', 'lib', 'memory-plugin-config')
    );
    const home = os.homedir();
    for (const candidate of loadMemoryPluginCandidates(env)) {
      if (probeCandidate(candidate, home)) return candidate;
    }
  } catch {
    /* memory-plugin config is optional; absence is fine */
  }
  return null;
}

/** True when any manifest dir for `candidate` holds an entry matching its probe. */
function probeCandidate(candidate, home) {
  for (const base of candidate.manifestGlob) {
    const dir = path.join(home, base);
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => candidate.probe.test(e.name))) return true;
  }
  return false;
}

module.exports = { detectMemoryPlugin };
