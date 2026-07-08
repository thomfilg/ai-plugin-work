'use strict';
/**
 * work-statusline.integration.test.js — spawns the real work-statusline.js with
 * an isolated TASKS_BASE + marker, proving: session scoping (only the owning
 * session sees the bar), the follow-up hand-off (empty on follow_up), and the
 * read layer's freshness / complete cut-offs.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'work-statusline.js');
const { readActiveState, FRESH_MS } = require('../lib/read-work-state');

const STATE = '.work-state' + '.json';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'work-statusline-'));
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

let seq = 0;
function fixture({ session = 'sess-A', step = 'implement', status = 'in_progress' } = {}) {
  seq += 1;
  const base = path.join(TMP, `base-${seq}`);
  const ticket = 'FUT-50';
  const dir = path.join(base, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.work.pid'), JSON.stringify({ ticket, sessionId: session }));
  const stepStatus = { implement: 'pending', follow_up: 'pending', [step]: 'in_progress' };
  fs.writeFileSync(
    path.join(dir, STATE),
    JSON.stringify({
      status,
      stepStatus,
      currentStep: 9,
      lastTransitionTimestamp: new Date().toISOString(),
      tasksMeta: { totalTasks: 3, tasks: [{ status: 'in_progress', title: 'seed db' }] },
    })
  );
  return { base, ticket, dir };
}

function render(base, session) {
  const env = { ...process.env, TASKS_BASE: base };
  delete env.WORKTREES_BASE;
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [RENDERER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.on('close', () => resolve(out));
    proc.on('error', reject);
    proc.stdin.end(JSON.stringify({ session_id: session }));
  });
}

describe('work-statusline.js — session-scoped rendering', () => {
  it('renders the bar for the owning session', async () => {
    const { base } = fixture({ session: 'sess-A' });
    const out = await render(base, 'sess-A');
    assert.ok(out.includes('⚙ FUT-50'), out);
    assert.ok(out.includes('▶ implement'), out);
    assert.ok(out.includes('task 1/3: seed db'), out);
  });

  it('shows nothing to a different session (marker is foreign)', async () => {
    const { base } = fixture({ session: 'sess-A' });
    assert.equal(await render(base, 'sess-B'), '');
  });

  it('shows nothing with no session on stdin', async () => {
    const { base } = fixture({ session: 'sess-A' });
    assert.equal(await render(base, ''), '');
  });

  it('yields (empty) while on the follow_up step so the 🔄 bar takes over', async () => {
    const { base } = fixture({ session: 'sess-A', step: 'follow_up' });
    assert.equal(await render(base, 'sess-A'), '');
  });
});

describe('read-work-state — freshness + complete cut-offs', () => {
  it('returns null for a completed run', () => {
    const { base, ticket } = fixture({ status: 'complete' });
    assert.equal(readActiveState(base, ticket), null);
  });

  it('returns null for a stale (untouched) state file', () => {
    const { base, ticket } = fixture();
    const now = Date.now() + FRESH_MS + 60000; // pretend we read well past the window
    assert.equal(readActiveState(base, ticket, now), null);
  });

  it('returns the parsed state for a fresh, in-progress run', () => {
    const { base, ticket } = fixture();
    const st = readActiveState(base, ticket);
    assert.ok(st);
    assert.equal(st.status, 'in_progress');
  });

  it('returns null for a missing ticket', () => {
    assert.equal(readActiveState(TMP, 'NOPE-1'), null);
  });
});
