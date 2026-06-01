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
      draft: { next: 'done', verdict: { ok: true, summary: 'all good' }, instructions: '# draft instructions' },
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
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
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
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
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
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
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
