'use strict';

/**
 * Tests for `plugins/synapsys/scripts/synapsys-replay.js` (GH-517 Task 3).
 *
 * After GH-517 the legacy direct-API judge path is gone. `synapsys-replay.js`
 * is now a thin alias around `synapsys-replay-next.js`. These tests assert
 * the residual surface:
 *   - `judgeBatch` / `judgePipeline` / `shouldJudge` are NOT exported.
 *   - Running the CLI on a fixture transcript with `--no-judge` does NOT
 *     emit the legacy `ANTHROPIC_API_KEY` stderr warning.
 *   - `require('./lib/replay-judge')` throws — the file is deleted.
 *
 * The other CLI / pure-function tests (flag parsing, walker, extractor,
 * matcher, aggregator, renderer) continue to live next to the modules
 * that own them (`replay-events`, `replay-aggregate`, `replay-report`,
 * `replay-judge-batch`, `synapsys-replay-next`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPLAY = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-replay.js');

/**
 * Build a minimal on-disk fixture: one store with one UPS-triggered memory and
 * one transcript whose prompt fires that memory. Mirrors the Task 2 fixture so
 * the alias drives a real walk→aggregate→report under --no-judge.
 */
function mkFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-task3-'));
  const storeDir = path.join(tmp, 'store', '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{}');
  fs.writeFileSync(
    path.join(storeDir, 'ups-bug.md'),
    [
      '---',
      'name: ups-bug',
      'description: test',
      'events: UserPromptSubmit',
      'trigger_prompt: auth bug|login',
      '---',
      'body',
      '',
    ].join('\n')
  );
  const projDir = path.join(tmp, 'projects', '-tmp-proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'session.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'please fix the auth bug today' } }) + '\n'
  );
  const runDir = path.join(tmp, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  return { tmp, storeDir, baseDir: path.join(tmp, 'projects'), runDir };
}

function lastEnvelope(stdout) {
  const lines = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* not json */
    }
  }
  return null;
}

test('synapsys-replay no longer exports the legacy direct-API judge surface', () => {
  const mod = require(REPLAY);
  const keys = Object.keys(mod);
  for (const removed of ['judgeBatch', 'judgePipeline', 'sampleForCap', 'shouldJudge']) {
    assert.ok(!keys.includes(removed), `${removed} must not be re-exported after GH-517`);
  }
});

test('synapsys-replay --no-judge produces a clean null-relevance report with no ANTHROPIC_API_KEY warning', () => {
  const { tmp, storeDir, baseDir, runDir } = mkFixture();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  // A single alias invocation must drive the deprecated command end-to-end and
  // terminate with the final report envelope (action:'done') — just like the
  // historical command did. It delegates to the phase-next runner internally.
  const result = spawnSync(
    process.execPath,
    [
      REPLAY,
      '--since=7d',
      '--no-judge',
      '--json',
      `--store=${storeDir}`,
      `--transcripts-base=${baseDir}`,
      `--run-dir=${runDir}`,
    ],
    { encoding: 'utf8', env }
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  // (R3) No legacy ANTHROPIC_API_KEY stderr warning.
  assert.ok(
    !/ANTHROPIC_API_KEY/.test(result.stderr),
    `legacy stderr warning must be gone; got: ${result.stderr}`
  );
  // (R9) Auto-downgrade: exit 0, never hard-fail.
  assert.equal(result.status, 0, `--no-judge must exit 0; stderr: ${result.stderr}`);

  // (R9) The terminal envelope is the report; every fired memory is null-relevance
  // and no judge dispatch happened.
  const envelope = lastEnvelope(result.stdout);
  assert.ok(envelope, `expected a JSON report envelope on stdout; got: ${result.stdout}`);
  assert.equal(envelope.current_phase, 'report', 'alias drives through to the report phase');
  assert.equal(envelope.action, 'done', 'alias terminates with action:done');
  assert.ok(!/dispatch_agent/.test(result.stdout), 'no dispatch_agent envelope under --no-judge');

  const payload = JSON.parse(envelope.stdout_payload);
  assert.ok(
    Array.isArray(payload.memories) && payload.memories.length >= 1,
    'report contains the fired memory'
  );
  for (const m of payload.memories) {
    assert.equal(m.relevant, null, `${m.name}.relevant=null under --no-judge`);
    assert.equal(m.fp_rate, null, `${m.name}.fp_rate=null under --no-judge`);
  }
});

test('lib/replay-judge.js is deleted (requiring the legacy fetch module throws)', () => {
  const legacy = path.resolve(__dirname, '..', 'replay-judge.js');
  assert.ok(!fs.existsSync(legacy), `${legacy} must be deleted`);
  assert.throws(
    () => require(legacy),
    /Cannot find module/,
    'require("./lib/replay-judge") must throw after Task 3'
  );
});
