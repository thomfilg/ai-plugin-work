'use strict';

/**
 * Tests for the createPhaseRunner factory.
 *
 * The factory lifts the orchestrator body from brief-next.js's main() and
 * parameterizes the four varying values plus the phase lookup:
 *   createPhaseRunner({ scriptName, phaseStateCliPath, initialPhase, getPhase, usageHint })
 *
 * Each test spawns a tiny driver script that imports the factory, wires it
 * up with stub options + a stub phase-state CLI, and runs main(argv). We
 * assert on stdout, stderr, exit code, and the resulting <phase>.json state
 * file written by the stub CLI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const FACTORY_PATH = path.resolve(__dirname, '..', 'create-phase-runner.js');

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Write a stub phase-state CLI to disk. It supports the four subcommands
 * (init / current / record / transition) and persists a single JSON file at
 * <tasksBase>/<ticket>/<stateFileName>. This mirrors the real CLI's contract
 * just enough for the factory to round-trip through it.
 */
function writeStubPhaseStateCli(dir, opts) {
  const { stateFileName, initialPhase, allowedTransitions } = opts;
  const cliPath = path.join(dir, 'stub-phase-state.js');
  const src = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [, , sub, ticket, ...rest] = process.argv;
const STATE_FILE = ${JSON.stringify(stateFileName)};
const INITIAL = ${JSON.stringify(initialPhase)};
const ALLOWED = ${JSON.stringify(allowedTransitions || {})};
const tasksBase = process.env.TASKS_BASE;
if (!tasksBase) { process.stderr.write('TASKS_BASE not set\\n'); process.exit(2); }
const statePath = path.join(tasksBase, ticket, STATE_FILE);
function readState() {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function writeState(s) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
}
if (sub === 'init') {
  if (!readState()) writeState({ currentPhase: INITIAL, history: [] });
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
  process.exit(0);
}
if (sub === 'current') {
  const s = readState();
  if (!s) { process.stderr.write('not initialized\\n'); process.exit(2); }
  process.stdout.write(JSON.stringify({ ok: true, currentPhase: s.currentPhase, state: s }) + '\\n');
  process.exit(0);
}
if (sub === 'record') {
  const phase = rest[0];
  const summaryIdx = rest.indexOf('--summary');
  const summary = summaryIdx >= 0 ? rest[summaryIdx + 1] : '';
  const s = readState() || { currentPhase: INITIAL, history: [] };
  s.history.push({ phase, summary, at: Date.now() });
  writeState(s);
  process.stdout.write(JSON.stringify({ ok: true, recorded: phase }) + '\\n');
  process.exit(0);
}
if (sub === 'transition') {
  const target = rest[0];
  const s = readState();
  if (!s) { process.stderr.write('not initialized\\n'); process.exit(2); }
  const allowed = ALLOWED[s.currentPhase] || [];
  if (!allowed.includes(target)) {
    process.stderr.write(JSON.stringify({ ok: false, error: 'invalid transition ' + s.currentPhase + ' -> ' + target }) + '\\n');
    process.exit(2);
  }
  s.currentPhase = target;
  writeState(s);
  process.stdout.write(JSON.stringify({ ok: true, currentPhase: target }) + '\\n');
  process.exit(0);
}
process.stderr.write('unknown subcommand: ' + sub + '\\n');
process.exit(2);
`;
  fs.writeFileSync(cliPath, src, { mode: 0o755 });
  return cliPath;
}

/**
 * Write a driver script that imports the factory, builds a getPhase from an
 * inline map, and calls main(argv). We pass the phase map as JSON via env.
 */
function writeDriver(dir, opts) {
  const driverPath = path.join(dir, 'driver.js');
  const src = `#!/usr/bin/env node
'use strict';
const { createPhaseRunner } = require(${JSON.stringify(FACTORY_PATH)});
const PHASES = JSON.parse(process.env.STUB_PHASES_JSON);
function getPhase(name) {
  const p = PHASES[name];
  if (!p) throw new Error('unknown phase: ' + name);
  return {
    next: p.next || null,
    validate: () => p.verdict,
    instructions: () => p.instructions || ('# ' + name),
  };
}
const main = createPhaseRunner({
  scriptName: ${JSON.stringify(opts.scriptName)},
  phaseStateCliPath: ${JSON.stringify(opts.phaseStateCliPath)},
  initialPhase: ${JSON.stringify(opts.initialPhase)},
  getPhase,
  usageHint: ${JSON.stringify(opts.usageHint || 'usage: driver.js <TICKET>')},
});
main(process.argv);
`;
  fs.writeFileSync(driverPath, src);
  return driverPath;
}

function runDriver(driverPath, argv, env) {
  return spawnSync(process.execPath, [driverPath, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('createPhaseRunner: advances phase on happy path, exits 0, prints PHASE ADVANCED', () => {
  const tmp = makeTmpDir('phase-runner-advance-');
  try {
    const tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, 'TKT-1'), { recursive: true });
    const cliPath = writeStubPhaseStateCli(tmp, {
      stateFileName: 'demo-phase.json',
      initialPhase: 'draft',
      allowedTransitions: { draft: ['done'] },
    });
    const phases = {
      draft: {
        next: 'done',
        verdict: { ok: true, summary: 'all good' },
        instructions: '# draft instructions',
      },
      done: { next: null, verdict: { ok: true }, instructions: '# done instructions' },
    };
    const driver = writeDriver(tmp, {
      scriptName: 'demo-next.js',
      phaseStateCliPath: cliPath,
      initialPhase: 'draft',
      usageHint: 'usage: demo-next.js <TICKET>',
    });
    const r = runDriver(driver, ['TKT-1'], {
      TASKS_BASE: tasksBase,
      STUB_PHASES_JSON: JSON.stringify(phases),
    });
    assert.equal(
      r.status,
      0,
      `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`
    );
    assert.match(r.stdout, /result: PHASE ADVANCED/);
    const state = JSON.parse(
      fs.readFileSync(path.join(tasksBase, 'TKT-1', 'demo-phase.json'), 'utf8')
    );
    assert.equal(state.currentPhase, 'done');
    assert.ok(state.history.some((h) => h.phase === 'draft' && h.summary === 'all good'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPhaseRunner: emits "## ❌ Phase DRAFT blocked" and exits 2 when handler returns errors', () => {
  const tmp = makeTmpDir('phase-runner-blocked-');
  try {
    const tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, 'TKT-2'), { recursive: true });
    const cliPath = writeStubPhaseStateCli(tmp, {
      stateFileName: 'demo-phase.json',
      initialPhase: 'draft',
      allowedTransitions: { draft: ['done'] },
    });
    const phases = {
      draft: {
        next: 'done',
        verdict: { ok: false, errors: ['missing section X', 'missing section Y'] },
        instructions: '# draft instructions',
      },
      done: { next: null, verdict: { ok: true } },
    };
    const driver = writeDriver(tmp, {
      scriptName: 'demo-next.js',
      phaseStateCliPath: cliPath,
      initialPhase: 'draft',
    });
    const r = runDriver(driver, ['TKT-2'], {
      TASKS_BASE: tasksBase,
      STUB_PHASES_JSON: JSON.stringify(phases),
    });
    assert.equal(
      r.status,
      2,
      `expected exit 2, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`
    );
    assert.match(r.stdout, /## ❌ Phase DRAFT blocked/);
    assert.match(r.stdout, /missing section X/);
    assert.match(r.stdout, /result: BLOCKED/);
    // State must not have advanced
    const state = JSON.parse(
      fs.readFileSync(path.join(tasksBase, 'TKT-2', 'demo-phase.json'), 'utf8')
    );
    assert.equal(state.currentPhase, 'draft');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPhaseRunner: waiting state (ok=false, no errors) exits 0 and leaves phase unchanged', () => {
  const tmp = makeTmpDir('phase-runner-waiting-');
  try {
    const tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, 'TKT-3'), { recursive: true });
    const cliPath = writeStubPhaseStateCli(tmp, {
      stateFileName: 'demo-phase.json',
      initialPhase: 'memorize',
      allowedTransitions: { memorize: ['done'] },
    });
    const phases = {
      memorize: { next: 'done', verdict: { ok: false }, instructions: '# memorize instructions' },
      done: { next: null, verdict: { ok: true } },
    };
    const driver = writeDriver(tmp, {
      scriptName: 'demo-next.js',
      phaseStateCliPath: cliPath,
      initialPhase: 'memorize',
    });
    const r = runDriver(driver, ['TKT-3'], {
      TASKS_BASE: tasksBase,
      STUB_PHASES_JSON: JSON.stringify(phases),
    });
    assert.equal(
      r.status,
      0,
      `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`
    );
    assert.match(r.stdout, /result: WAITING/);
    assert.doesNotMatch(r.stdout, /PHASE ADVANCED/);
    const state = JSON.parse(
      fs.readFileSync(path.join(tasksBase, 'TKT-3', 'demo-phase.json'), 'utf8')
    );
    assert.equal(state.currentPhase, 'memorize');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPhaseRunner: die()s with non-zero exit when tasks dir is missing', () => {
  const tmp = makeTmpDir('phase-runner-missing-');
  try {
    const tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(tasksBase, { recursive: true });
    // Note: NOT creating tasksBase/TKT-MISSING
    const cliPath = writeStubPhaseStateCli(tmp, {
      stateFileName: 'demo-phase.json',
      initialPhase: 'draft',
      allowedTransitions: {},
    });
    const phases = { draft: { next: null, verdict: { ok: true } } };
    const driver = writeDriver(tmp, {
      scriptName: 'demo-next.js',
      phaseStateCliPath: cliPath,
      initialPhase: 'draft',
    });
    const r = runDriver(driver, ['TKT-MISSING'], {
      TASKS_BASE: tasksBase,
      STUB_PHASES_JSON: JSON.stringify(phases),
    });
    assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}`);
    assert.match(r.stderr, /tasks dir not found/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ECHO-5322 issue 2: cwd-independent worktree resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Driver that exposes ctx.worktreeRoot via the instructions body so the test
 * can assert what the factory resolved without inspecting internals.
 */
function writeWorktreeProbeDriver(dir, opts) {
  const driverPath = path.join(dir, 'probe-driver.js');
  const src = `#!/usr/bin/env node
'use strict';
const { createPhaseRunner } = require(${JSON.stringify(FACTORY_PATH)});
const main = createPhaseRunner({
  scriptName: 'demo-next.js',
  phaseStateCliPath: ${JSON.stringify(opts.phaseStateCliPath)},
  initialPhase: 'draft',
  getPhase: () => ({
    next: null,
    validate: () => ({ ok: false }),
    instructions: (ctx) => 'WORKTREE_ROOT=' + ctx.worktreeRoot,
  }),
  usageHint: 'usage: demo-next.js <TICKET>',
});
main(process.argv);
`;
  fs.writeFileSync(driverPath, src);
  return driverPath;
}

test('createPhaseRunner: resolves ctx.worktreeRoot from ticket id + env config when invoked from the tasks dir (unrelated cwd)', () => {
  const tmp = makeTmpDir('phase-runner-worktree-');
  try {
    const worktreesBase = path.join(tmp, 'w-repo');
    const worktree = path.join(worktreesBase, 'myrepo-TKT-W');
    fs.mkdirSync(worktree, { recursive: true });
    const tasksBase = path.join(worktreesBase, 'tasks');
    const tasksDir = path.join(tasksBase, 'TKT-W');
    fs.mkdirSync(tasksDir, { recursive: true });
    const cliPath = writeStubPhaseStateCli(tmp, {
      stateFileName: 'demo-phase.json',
      initialPhase: 'draft',
      allowedTransitions: {},
    });
    const driver = writeWorktreeProbeDriver(tmp, { phaseStateCliPath: cliPath });
    // Invoke from the (non-git) tasks dir — the ECHO-5322 failure scenario.
    const r = spawnSync(process.execPath, [driver, 'TKT-W'], {
      cwd: tasksDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        TASKS_BASE: tasksBase,
        WORKTREES_BASE: worktreesBase,
        REPO_NAME: 'myrepo',
        TICKET_PROVIDER: '',
      },
    });
    assert.equal(
      r.status,
      0,
      `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`
    );
    assert.ok(
      r.stdout.includes(`WORKTREE_ROOT=${worktree}`),
      `expected worktreeRoot ${worktree}, stdout:\n${r.stdout}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPhaseRunner: falls back to dirname(tasksBase) when neither config nor cwd resolve a worktree', () => {
  const tmp = makeTmpDir('phase-runner-worktree-fb-');
  try {
    const tasksBase = path.join(tmp, 'tasks');
    const tasksDir = path.join(tasksBase, 'TKT-F');
    fs.mkdirSync(tasksDir, { recursive: true });
    const cliPath = writeStubPhaseStateCli(tmp, {
      stateFileName: 'demo-phase.json',
      initialPhase: 'draft',
      allowedTransitions: {},
    });
    const driver = writeWorktreeProbeDriver(tmp, { phaseStateCliPath: cliPath });
    const r = spawnSync(process.execPath, [driver, 'TKT-F'], {
      cwd: tasksDir, // non-git cwd, no configured worktree exists
      encoding: 'utf8',
      env: {
        ...process.env,
        TASKS_BASE: tasksBase,
        WORKTREES_BASE: path.join(tmp, 'nonexistent'),
        REPO_NAME: 'myrepo',
        TICKET_PROVIDER: '',
      },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr:\n${r.stderr}`);
    assert.ok(
      r.stdout.includes(`WORKTREE_ROOT=${tmp}`),
      `expected dirname(tasksBase) fallback ${tmp}, stdout:\n${r.stdout}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ECHO-4450 issue 2: companion write-token re-mint across consecutive
// runner invocations (one-shot consumed by the previous run)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stub phase-state CLI that enforces the REAL one-shot write-token contract:
 * every subcommand consumes (read + delete) a fresh token at
 * `$CLAUDE_WRITE_TOKEN_DIR/<own-basename>.<TICKET>` or fails.
 */
function writeTokenConsumingStubCli(dir, opts) {
  const { stateFileName, initialPhase, allowedTransitions } = opts;
  const cliPath = path.join(dir, 'stub-phase-state.js');
  const src = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [, , sub, ticket, ...rest] = process.argv;
const TOKEN_DIR = process.env.CLAUDE_WRITE_TOKEN_DIR;
const tokenFile = path.join(TOKEN_DIR, path.basename(__filename) + '.' + ticket);
let token = null;
try { token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); fs.unlinkSync(tokenFile); } catch {}
if (!token) { process.stderr.write(JSON.stringify({ error: true, message: 'No valid write token found.' }) + '\\n'); process.exit(2); }
const age = Date.now() - token.timestamp;
if (!(age >= 0 && age <= 10000)) { process.stderr.write('Write token expired (' + age + 'ms old).\\n'); process.exit(2); }
const STATE_FILE = ${JSON.stringify(stateFileName)};
const INITIAL = ${JSON.stringify(initialPhase)};
const ALLOWED = ${JSON.stringify(allowedTransitions || {})};
const statePath = path.join(process.env.TASKS_BASE, ticket, STATE_FILE);
function readState() { return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null; }
function writeState(s) { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
if (sub === 'init') { if (!readState()) writeState({ currentPhase: INITIAL, history: [] }); process.stdout.write('{"ok":true}\\n'); process.exit(0); }
if (sub === 'current') { const s = readState(); if (!s) process.exit(2); process.stdout.write(JSON.stringify({ ok: true, currentPhase: s.currentPhase }) + '\\n'); process.exit(0); }
if (sub === 'record') { const s = readState(); s.history.push({ phase: rest[0] }); writeState(s); process.stdout.write('{"ok":true}\\n'); process.exit(0); }
if (sub === 'transition') { const s = readState(); const target = rest[0]; if (!(ALLOWED[s.currentPhase] || []).includes(target)) process.exit(2); s.currentPhase = target; writeState(s); process.stdout.write('{"ok":true}\\n'); process.exit(0); }
process.exit(2);
`;
  fs.writeFileSync(cliPath, src, { mode: 0o755 });
  return cliPath;
}

function mintToken(tokenDir, basename, ticket, data) {
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(tokenDir, `${basename}.${ticket}`),
    JSON.stringify({ agent: 'code-checker', timestamp: Date.now(), ...data }),
    { mode: 0o600 }
  );
}

test('createPhaseRunner: second consecutive invocation re-establishes the consumed companion token from the runner token (ECHO-4450)', () => {
  const tmp = makeTmpDir('phase-runner-token-');
  try {
    const tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, 'TKT-T'), { recursive: true });
    const tokenDir = path.join(tmp, 'tokens');
    const cliPath = writeTokenConsumingStubCli(tmp, {
      stateFileName: 'demo-phase.json',
      initialPhase: 'draft',
      allowedTransitions: { draft: ['review'], review: ['done'] },
    });
    const phases = {
      draft: { next: 'review', verdict: { ok: true, summary: 'draft ok' } },
      review: { next: 'done', verdict: { ok: true, summary: 'review ok' } },
      done: { next: null, verdict: { ok: true } },
    };
    const driver = writeDriver(tmp, {
      scriptName: 'demo-next.js',
      phaseStateCliPath: cliPath,
      initialPhase: 'draft',
    });
    const env = {
      TASKS_BASE: tasksBase,
      CLAUDE_WRITE_TOKEN_DIR: tokenDir,
      STUB_PHASES_JSON: JSON.stringify(phases),
    };

    // Simulate the PreToolUse hook: ONE mint per Bash call — runner token +
    // companion token. Two `node demo-next.js` invocations then run inside
    // that single Bash call.
    mintToken(tokenDir, 'demo-next.js', 'TKT-T', {});
    mintToken(tokenDir, 'stub-phase-state.js', 'TKT-T', {});

    // Invocation 1 consumes the companion token (one-shot per write).
    const r1 = runDriver(driver, ['TKT-T'], env);
    assert.equal(
      r1.status,
      0,
      `first invocation failed (${r1.status})\nstdout:\n${r1.stdout}\nstderr:\n${r1.stderr}`
    );
    assert.match(r1.stdout, /result: PHASE ADVANCED/);
    assert.ok(
      !fs.existsSync(path.join(tokenDir, 'stub-phase-state.js.TKT-T')),
      'companion token should be consumed by the first invocation'
    );

    // Invocation 2 — no hook re-mint. Must re-establish the companion token
    // from the (unconsumed, still fresh) runner token instead of dying with
    // "No valid write token found".
    const r2 = runDriver(driver, ['TKT-T'], env);
    assert.equal(
      r2.status,
      0,
      `second invocation failed (${r2.status})\nstdout:\n${r2.stdout}\nstderr:\n${r2.stderr}`
    );
    assert.match(r2.stdout, /result: PHASE ADVANCED/);
    const state = JSON.parse(
      fs.readFileSync(path.join(tasksBase, 'TKT-T', 'demo-phase.json'), 'utf8')
    );
    assert.equal(
      state.currentPhase,
      'done',
      'both invocations must advance via the audited phase state'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPhaseRunner: a STALE runner token is NOT laundered into a fresh companion token', () => {
  const tmp = makeTmpDir('phase-runner-token-stale-');
  try {
    const tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, 'TKT-S'), { recursive: true });
    const tokenDir = path.join(tmp, 'tokens');
    const cliPath = writeTokenConsumingStubCli(tmp, {
      stateFileName: 'demo-phase.json',
      initialPhase: 'draft',
      allowedTransitions: { draft: ['done'] },
    });
    const phases = {
      draft: { next: 'done', verdict: { ok: true, summary: 'ok' } },
      done: { next: null, verdict: { ok: true } },
    };
    const driver = writeDriver(tmp, {
      scriptName: 'demo-next.js',
      phaseStateCliPath: cliPath,
      initialPhase: 'draft',
    });
    // Only a runner token exists, and it is 60s old (>> 10s TTL).
    mintToken(tokenDir, 'demo-next.js', 'TKT-S', { timestamp: Date.now() - 60_000 });

    const r = runDriver(driver, ['TKT-S'], {
      TASKS_BASE: tasksBase,
      CLAUDE_WRITE_TOKEN_DIR: tokenDir,
      STUB_PHASES_JSON: JSON.stringify(phases),
    });
    assert.notEqual(
      r.status,
      0,
      `stale runner token must not authorize writes\nstdout:\n${r.stdout}`
    );
    assert.match(r.stdout + r.stderr, /write token|Could not init/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
