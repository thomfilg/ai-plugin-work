'use strict';

/**
 * Pass D — Spawn-based E2E for the emit-warnings.js CLI.
 *
 * SKILL.md Step 5 invokes Pass D via `node emit-warnings.js <ticket-dir>`.
 * This test spawns that exact CLI (not the lib function) against a fixture
 * tasks.md where Type=tdd-code but scope is only *.md, asserting:
 *   - non-zero exit
 *   - stdout contains `[Pass D]` SPLIT-WARNING
 *   - a happy fixture exits 0 with no warning lines
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'lib', 'emit-warnings.js');

function makeTicketDir(md) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-d-cli-'));
  fs.writeFileSync(path.join(dir, 'tasks.md'), md, 'utf8');
  return dir;
}

function runCli(ticketDir) {
  return spawnSync('node', [CLI, ticketDir], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('Pass D — emit-warnings.js CLI E2E', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {
        /* best-effort */
      }
    }
  });

  it('exits non-zero with [Pass D] line when Type=tdd-code but scope is only *.md', () => {
    const md = [
      '# Tasks',
      '',
      '## Task 1 — sample',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Acceptance Criteria',
      '- Implement the feature',
      '',
      '### Files in scope',
      '- README.md',
      '',
    ].join('\n');
    const dir = makeTicketDir(md);
    dirs.push(dir);
    const r = runCli(dir);
    assert.notEqual(r.status, 0, `expected non-zero; stdout=${r.stdout} stderr=${r.stderr}`);
    const blob = `${r.stdout}\n${r.stderr}`;
    assert.match(blob, /\[Pass D\]/);
    assert.match(blob, /no `\*\.test\.\*`/);
  });

  it('exits 0 with no warnings on happy tdd-code fixture', () => {
    const md = [
      '# Tasks',
      '',
      '## Task 1 — sample',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Acceptance Criteria',
      '- Cover the reducer',
      '',
      '### Files in scope',
      '- src/foo.js',
      '- src/foo.test.js',
      '',
    ].join('\n');
    const dir = makeTicketDir(md);
    dirs.push(dir);
    const r = runCli(dir);
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /\[Pass D\]/);
  });

  it('exits non-zero with config allowlist warning when Type=config has src/ in scope', () => {
    const md = [
      '# Tasks',
      '',
      '## Task 1 — config',
      '',
      '### Type',
      'config',
      '',
      '### Acceptance Criteria',
      '- Bump version',
      '',
      '### Files in scope',
      '- package.json',
      '- src/server.js',
      '',
    ].join('\n');
    const dir = makeTicketDir(md);
    dirs.push(dir);
    const r = runCli(dir);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}`, /config allowlist/);
  });

  it('exits 2 when ticket-dir arg is missing', () => {
    const r = spawnSync('node', [CLI], { encoding: 'utf8' });
    assert.equal(r.status, 2);
  });
});
