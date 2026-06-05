'use strict';

/**
 * Integration tests for `plugins/synapsys/scripts/synapsys-stats.js`
 * (GH-512, Task 4). Spawns the CLI against a temp fixture store and asserts
 * on stdout/stderr/exit code, covering AC10 (sections) and AC11 (mtime window).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATS = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-stats.js');

function writeMemoryFile(storeDir, name) {
  const body = [
    '---',
    `name: ${name}`,
    'description: x',
    'events: UserPromptSubmit',
    'trigger_prompt: x',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(storeDir, `${name}.md`), body);
}

function makeFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stats-int-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stats-int-home-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  // Telemetry lives under the FIXED home dir (matches lib/telemetry.telemetryDir()).
  const telDir = path.join(home, '.claude', 'synapsys', '.telemetry');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(telDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'synapsys-stats-int-fixture' })
  );
  return {
    cwd,
    home,
    storeDir,
    telDir,
    cleanup: () => {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {}
    },
  };
}

function writeJsonl(file, lines) {
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function runCli(args, fixtureCwd, home) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  return spawnSync(process.execPath, [STATS, ...args, `--cwd=${fixtureCwd}`, '--no-color'], {
    encoding: 'utf8',
    env,
  });
}

test('synapsys:stats surfaces top influencers, noise, and never-fired in a 7d window', () => {
  const fx = makeFixture();
  try {
    writeMemoryFile(fx.storeDir, 'mem-influencer');
    writeMemoryFile(fx.storeDir, 'mem-noise');
    writeMemoryFile(fx.storeDir, 'mem-quiet');

    const now = Date.now();
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push({
        ts: new Date(now - 1000 * i).toISOString(),
        memory: 'mem-influencer',
        event: 'fired',
      });
      lines.push({
        ts: new Date(now - 1000 * i).toISOString(),
        memory: 'mem-influencer',
        event: 'cited',
        match: 'x',
      });
    }
    for (let i = 0; i < 10; i++) {
      lines.push({
        ts: new Date(now - 1000 * i).toISOString(),
        memory: 'mem-noise',
        event: 'fired',
      });
    }
    writeJsonl(path.join(fx.telDir, 'session-1.jsonl'), lines);

    const res = runCli(['--last=7d'], fx.cwd, fx.home);
    assert.equal(res.status, 0, `exit non-zero: ${res.stderr}`);
    assert.match(res.stdout, /Top influencers/);
    assert.match(res.stdout, /Noise candidates/);
    assert.match(res.stdout, /Never-fired/);
    assert.match(res.stdout, /mem-influencer/);
    assert.match(res.stdout, /mem-noise/);
    assert.match(res.stdout, /mem-quiet/);
    // mem-quiet should appear under Never-fired, not Top influencers
    const topSection = res.stdout.split(/Noise candidates/)[0];
    assert.ok(!/mem-quiet/.test(topSection), 'mem-quiet should not appear in Top influencers');
  } finally {
    fx.cleanup();
  }
});

test('synapsys:stats honors --last 30d window', () => {
  const fx = makeFixture();
  try {
    writeMemoryFile(fx.storeDir, 'mem-old');

    const oldTs = Date.now() - 1000 * 60 * 60 * 24 * 20;
    const oldFile = path.join(fx.telDir, 'old-session.jsonl');
    writeJsonl(oldFile, [
      { ts: new Date(oldTs).toISOString(), memory: 'mem-old', event: 'fired' },
      { ts: new Date(oldTs).toISOString(), memory: 'mem-old', event: 'cited', match: 'x' },
    ]);
    fs.utimesSync(oldFile, new Date(oldTs), new Date(oldTs));

    const res7 = runCli(['--last=7d'], fx.cwd, fx.home);
    assert.equal(res7.status, 0);
    // mem-old must appear under Never-fired (no in-window fired events)
    const never7 = res7.stdout.split(/Never-fired/)[1] || '';
    assert.match(never7, /mem-old/, '7d window: mem-old should be Never-fired');

    const res30 = runCli(['--last=30d'], fx.cwd, fx.home);
    assert.equal(res30.status, 0);
    const never30 = res30.stdout.split(/Never-fired/)[1] || '';
    assert.ok(!/mem-old/.test(never30), '30d window: mem-old should NOT be Never-fired');
    // It should now appear earlier (Top influencers since cited=1)
    assert.match(res30.stdout, /Top influencers[\s\S]*mem-old/);
  } finally {
    fx.cleanup();
  }
});

// Cross-pipeline end-to-end: dispatcher writes telemetry → stats reads it.
test('dispatcher write → stats read share the same telemetry directory', () => {
  const fx = makeFixture();
  try {
    writeMemoryFile(fx.storeDir, 'mem-flow');
    // Append the trigger_prompt so the dispatcher actually matches.
    fs.writeFileSync(
      path.join(fx.storeDir, 'mem-flow.md'),
      [
        '---',
        'name: mem-flow',
        'description: x',
        'events: UserPromptSubmit',
        'trigger_prompt: flow-token',
        '---',
        '',
        'Body',
      ].join('\n')
    );

    const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');
    const env = { ...process.env, HOME: fx.home, SYNAPSYS_NO_SETUP_HINT: '1' };
    delete env.SYNAPSYS_TELEMETRY;
    const sessionId = 'flow-session-1';
    const payload = { cwd: fx.cwd, session_id: sessionId, prompt: 'contains flow-token here' };
    const fired = spawnSync(process.execPath, [DISPATCHER, 'UserPromptSubmit'], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env,
    });
    assert.equal(fired.status, 0, `dispatcher exit non-zero: ${fired.stderr}`);

    // Telemetry MUST land in fx.telDir (the fixed home-rooted path).
    const jsonl = path.join(fx.telDir, `${sessionId}.jsonl`);
    assert.ok(fs.existsSync(jsonl), `expected telemetry at ${jsonl}`);

    // Stats CLI must see the events written by the dispatcher.
    const res = runCli(['--last=7d'], fx.cwd, fx.home);
    assert.equal(res.status, 0, `stats exit non-zero: ${res.stderr}`);
    const top = res.stdout.split(/Noise candidates/)[0];
    // mem-flow fired once → not in Top influencers (no cited yet) but listed somewhere
    // with fired:1; what matters is the Never-fired section excludes it.
    const never = res.stdout.split(/Never-fired/)[1] || '';
    assert.ok(
      !/mem-flow/.test(never),
      `cross-pipeline: mem-flow must NOT be Never-fired. stdout:\n${res.stdout}`
    );
    void top;
  } finally {
    fx.cleanup();
  }
});
