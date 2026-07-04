'use strict';

/**
 * pane-busy.js — "is the agent mid-tool?" signal from live pane subprocesses.
 *
 * Pane-output silence conflates "working quietly" with "frozen": a Docker
 * build or long test run can hold the pane silent for many minutes while a
 * child process works, and operators were forced to set SILENCE_LIMIT_SEC to
 * a day to protect them — which also disabled ALL dead-agent recovery.
 *
 * The discriminating signal: the Claude process in the pane has CHILD
 * processes exactly while a tool call (Bash, docker, make, node …) runs.
 * Frozen-idle agents have none. So:
 *   pane has descendant processes BELOW the claude process → agent is busy.
 *
 * Implementation: one `ps -eo pid=,ppid=` snapshot per call, walk descendants
 * of the pane's root pid. The pane root is usually `sh -c "claude …"` or
 * claude itself; we count descendants deeper than the first claude/shell
 * level, i.e. any grandchild — those only exist while a tool subprocess runs.
 *
 * Fail-open: any error returns false (no signal), never blocking a restart
 * that the silence detector would otherwise perform.
 */

const { spawnSync } = require('child_process');

const PS_TIMEOUT_MS = parseInt(process.env.GIT_CALL_TIMEOUT_MS || '10000', 10);

function spawnOut(cmd, args) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PS_TIMEOUT_MS,
  });
  return res.status === 0 ? res.stdout || '' : '';
}

/** Pane root pid for a tmux session, or null. */
function panePid(session) {
  const out = spawnOut('tmux', ['display', '-p', '-t', session, '#{pane_pid}']).trim();
  const pid = parseInt(out, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Map of ppid → [pid…] from one ps snapshot. */
function childMap() {
  const out = spawnOut('ps', ['-eo', 'pid=,ppid=']);
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!map.has(ppid)) map.set(ppid, []);
    map.get(ppid).push(pid);
  }
  return map;
}

/**
 * True when the session's pane process tree extends at least two levels below
 * the pane root — i.e. the agent process has live tool subprocesses.
 */
function paneHasLiveSubprocess(session) {
  try {
    const root = panePid(session);
    if (!root) return false;
    const map = childMap();
    const level1 = map.get(root) || []; // claude (or the agent binary) itself
    for (const pid of level1) {
      if ((map.get(pid) || []).length > 0) return true; // a tool is running
    }
    // Pane command exec'd claude directly (no wrapper shell): then level1 ARE
    // the tool subprocesses. ≥2 childless children is a conservative busy
    // signal; exactly one is ambiguous (a lone claude-under-sh looks the same
    // as a lone tool-under-claude) — err on the quiet side so silence
    // handling still applies to idle agents.
    return level1.length > 1;
  } catch {
    return false;
  }
}

module.exports = { paneHasLiveSubprocess, panePid };
