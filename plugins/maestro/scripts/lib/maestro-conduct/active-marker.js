'use strict';
/**
 * active-marker.js — the status-bar "which Claude session owns which fleet"
 * marker under ~/.cache/maestro/active/.
 *
 * maestro-statusline.js shows a fleet's live tmux sessions ONLY in the owning
 * Claude session, matched by these markers. The prefix is DERIVED from the
 * live `<PREFIX>-<id>-work` tmux sessions (the exact set the statusline matches
 * against) — NOT from a TICKET_PREFIX env var: the daemon and bootstrap are
 * separate process launches and the env was frequently absent on the daemon
 * side, so the marker was never written and the 🎼 bar stayed blank. An
 * explicit TICKET_PREFIX is still honored when present.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmux = require('./tmux');

// The ticket prefix(es) this fleet owns. Session ids like "FUT-97" → "FUT".
function activeFleetPrefixes(sessions) {
  const prefixes = new Set();
  const raw = process.env.TICKET_PREFIX || '';
  if (/^[A-Z][A-Z0-9]*$/.test(raw)) prefixes.add(raw);
  for (const s of sessions || []) {
    const m = /^([A-Z][A-Z0-9]*)-\d+$/.exec(tmux.ticketIdFor(s) || '');
    if (m) prefixes.add(m[1]);
  }
  return [...prefixes];
}

// Drop this session's stale markers before rewriting (the prefix set changes as
// fleets start/finish). Session ids are UUIDs, so the "<session>." filename
// prefix can't collide with another session's markers.
function clearSessionMarkers(dir, session) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (f.startsWith(`${session}.`) && f.endsWith('.json')) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* ignore */
      }
    }
  }
}

// Record which Claude session launched this orchestration + the ticket
// prefix(es) it owns. Called every tick (reusing the tick's session list) so it
// self-heals as agents come up after the daemon starts. Best-effort — the
// status bar is advisory.
function writeActiveMarker(sessions) {
  try {
    const session = process.env.CLAUDE_CODE_SESSION_ID;
    if (!session) return;
    const prefixes = activeFleetPrefixes(sessions || tmux.listSessions());
    if (!prefixes.length) return;
    const dir = path.join(os.homedir(), '.cache', 'maestro', 'active');
    fs.mkdirSync(dir, { recursive: true });
    clearSessionMarkers(dir, session);
    const repo = process.env.REPO_NAME || '';
    // One marker per prefix — maestro-statusline.js aggregates every marker
    // whose .session matches, so a multi-prefix session shows each fleet.
    for (const prefix of prefixes) {
      fs.writeFileSync(
        path.join(dir, `${session}.${prefix}.json`),
        JSON.stringify({ session, prefix, repo })
      );
    }
  } catch {
    /* best effort — the status bar is advisory */
  }
}

module.exports = { activeFleetPrefixes, writeActiveMarker };
