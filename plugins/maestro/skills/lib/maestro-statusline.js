#!/usr/bin/env node
'use strict';
/**
 * maestro-statusline.js — agent-free renderer for the maestro fleet status line.
 *
 * Reads the conductor's session manifests (updated every tick) and the alert
 * log, and prints ONE compact line per active topic. No agent, no polling —
 * Claude Code re-runs the parent .sh on its refreshInterval and shows stdout.
 *
 * Data sources (all written by maestro itself):
 *   - $SESSION_DIR/*.json         manifest per topic {topic,slots,tasks[{id,status}]}
 *   - $ALERTS (jsonl)             ACTION rows {ticket,kind}; latest kind per ticket
 *
 * Output (per topic with any active/pending task; fully-done topics are hidden):
 *   🎼 <topic> <done>/<total>✓ ▶<active>(<ids>) ⏳<pending> [⚠<broken>]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const WORKTREES_BASE =
  process.env.WORKTREES_BASE || path.join(os.homedir(), 'p', 'w-claude-plugin');
const REPO_NAME = process.env.REPO_NAME || 'claude-plugin-work';

// Two-word label for an active ticket, taken from its worktree's last commit
// subject (local git — instant, no network, keeps the statusline agent-free).
// Called only for the ONE ticket currently displayed (the single active ticket,
// or the rotation's current slot), so at most one git call fires per render.
function twoWords(ticket) {
  try {
    const wt = path.join(WORKTREES_BASE, `${REPO_NAME}-${ticket}`);
    // execFileSync (no shell) — args are passed directly to git, so ticket /
    // env-derived paths can't be interpreted as shell commands (CodeQL: no
    // indirect uncontrolled command line).
    const subj = execFileSync('git', ['-C', wt, 'log', '-1', '--format=%s'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!subj) return '';
    const stripped = subj.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, ''); // drop type(scope):
    return stripped.split(/\s+/).slice(0, 2).join(' ');
  } catch {
    return '';
  }
}

const SESSION_DIR =
  process.env.MAESTRO_SESSION_DIR ||
  process.env.SESSION_DIR ||
  path.join(os.homedir(), '.cache', 'maestro', 'sessions');
const ALERTS = process.env.MAESTRO_ALERTS || process.env.ALERTS || '/tmp/maestro-alerts.jsonl';

function readManifests() {
  let files = [];
  try {
    files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
      if (j && Array.isArray(j.tasks) && j.topic) out.push(j);
    } catch {
      /* skip unreadable/partial manifest */
    }
  }
  return out;
}

// Most-recent alert kind per ticket — lets us flag pr-broken tickets live.
function latestKindByTicket() {
  const m = {};
  let lines = [];
  try {
    lines = fs.readFileSync(ALERTS, 'utf8').trim().split('\n');
  } catch {
    return m;
  }
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j && j.ticket && j.kind) m[j.ticket] = j.kind;
    } catch {
      /* skip */
    }
  }
  return m;
}

// --- Session scoping: show the maestro line ONLY in the orchestrator session.
// Claude runs this statusLine command in EVERY session, so we gate on the
// session JSON piped in on stdin. The first non-worktree session to render
// claims the pin; agents (cwd = <repo>-<ticket> worktree) never claim it and
// never match, so the line disappears from their tabs and other projects.
function readCtx() {
  let s = '';
  try {
    s = fs.readFileSync(0, 'utf8');
  } catch {
    /* no stdin */
  }
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}
const CTX = readCtx();
// The Claude session Claude runs this statusLine in. Each manifest records the
// session that launched its orchestration (maestro-session.js), so the bar shows
// a topic ONLY in its owning session — every orchestrator gets its own fleet,
// and other chats show nothing. No global pin (which only one session could win).
const SESSION_ID = CTX.session_id || CTX.sessionId || '';

// Render the "▶ …" active portion. One active ticket shows inline with its
// two-word label; multiple rotate one-per-refresh ([i/N]) via wall-clock time
// (statusLine re-runs ~every refreshInterval second) so the label stays readable.
function formatActive(active) {
  const i = active.length === 1 ? 0 : Math.floor(Date.now() / 3000) % active.length;
  const a = active[i];
  const w = twoWords(a.id);
  const label = `${a.id}${w ? ` — ${w}` : ''}`;
  if (active.length === 1) return `   ▶  1  (${label})`;
  return `   ▶  ${active.length}  [${i + 1}/${active.length}] ${label}`;
}

// One status segment for a topic, or null when it has no active/pending work.
function topicSegment(j, kinds) {
  const t = j.tasks;
  const active = t.filter((x) => x.status === 'in_progress');
  const pending = t.filter((x) => x.status === 'pending').length;
  if (active.length === 0 && pending === 0) return null;
  const done = t.filter((x) => x.status === 'done').length;
  const broken = t.filter((x) => x.status !== 'done' && kinds[x.id] === 'pr-broken').length;
  const ready = active.filter((x) => kinds[x.id] === 'pr-ready').length;
  let seg = `🎼 ${j.topic}   ${done}/${t.length} ✓`;
  if (active.length) seg += formatActive(active);
  if (pending) seg += `   ⏳ ${pending}`;
  if (ready) seg += `   ✅ ${ready}`;
  if (broken) seg += `   ⚠  ${broken}`;
  return seg;
}

function render() {
  if (!SESSION_ID) return '';
  const kinds = latestKindByTicket();
  return readManifests()
    .filter((j) => j.session === SESSION_ID) // only fleets this session launched
    .map((j) => topicSegment(j, kinds))
    .filter(Boolean)
    .join('      |      ');
}

process.stdout.write(render());
