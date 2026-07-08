'use strict';

// gh214-state-file-first.test.js — GH-214: background-mode / state-file-first
// invocation. The orchestrator persists (a) the latest instruction to
// .follow-up-next.json on every run, and (b) the observed CI run IDs to state,
// so monitoring is resumable without parsing terminal output.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { persistInstruction } = require('../instruction-file');
const { collectRunIds } = require('../steps/monitor-ci-context');

describe('GH-214 — instruction file persistence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh214-'));
    fs.mkdirSync(path.join(tmpDir, 'GH-1'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const file = () => path.join(tmpDir, 'GH-1', '.follow-up-next.json');

  it('writes the instruction JSON for non-complete actions', () => {
    persistInstruction(tmpDir, 'GH-1', { action: 'execute', delegate: { type: 'bash' } });
    const persisted = JSON.parse(fs.readFileSync(file(), 'utf8'));
    assert.equal(persisted.action, 'execute');
  });

  it('removes the file on complete (no stale completion blob)', () => {
    persistInstruction(tmpDir, 'GH-1', { action: 'blocked', reason: 'x' });
    assert.ok(fs.existsSync(file()));
    persistInstruction(tmpDir, 'GH-1', { action: 'complete' });
    assert.ok(!fs.existsSync(file()));
  });

  it('orchestrator persists on every run, not only via the hook (source guard)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'follow-up-next.js'),
      'utf8'
    );
    assert.ok(source.includes('persistInstruction'), 'follow-up-next.js must persist directly');
  });
});

describe('GH-214 — CI run IDs persisted for resumable monitoring', () => {
  it('collectRunIds gathers unique run IDs across all job buckets', () => {
    const ids = collectRunIds({
      running: [{ name: 'a', link: 'https://github.com/o/r/actions/runs/111/job/1' }],
      passed: [{ name: 'b', url: 'https://github.com/o/r/actions/runs/222/job/2' }],
      failed: [{ name: 'c', link: 'https://github.com/o/r/actions/runs/111/job/3' }],
      cancelled: [],
    });
    assert.deepEqual(ids.sort(), ['111', '222']);
  });

  it('returns [] for jobs without run links', () => {
    assert.deepEqual(collectRunIds({ running: [{ name: 'x' }] }), []);
  });

  it('monitor persists _ciRunIds to state each cycle (source guard)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'steps', 'monitor.js'), 'utf8');
    assert.ok(source.includes('state._ciRunIds = collectRunIds(ci)'));
  });
});
