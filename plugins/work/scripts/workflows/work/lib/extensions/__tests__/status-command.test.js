/**
 * Unit tests for the work-extensions-status diagnostic command (Task 9).
 * Covers G10: Diagnostic command lists loaded extensions and load errors.
 *
 * The script spawns as a child process against a fixture repo containing one
 * valid and one broken extension, asserting JSON output shape per
 * `ExtensionStatusEntry[]`.
 *
 * Run with:
 *   node --test plugins/work/scripts/workflows/work/lib/extensions/__tests__/status-command.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'work-extensions-status.js'
);

function makeTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'status-cmd-'));
  const tasksDir = path.join(repoRoot, 'tasks', 'GH-522');
  fs.mkdirSync(tasksDir, { recursive: true });
  const extDir = path.join(repoRoot, '.claude', 'work-extensions');
  fs.mkdirSync(extDir, { recursive: true });
  return { repoRoot, tasksDir, extDir };
}

function writeFile(p, contents) {
  fs.writeFileSync(p, contents);
}

function runScript(args, env) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('Diagnostic command lists loaded extensions and load errors', () => {
  /** @type {string[]} */
  let toCleanup = [];

  beforeEach(() => {
    toCleanup = [];
  });

  afterEach(() => {
    for (const dir of toCleanup) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('script file exists at expected location', () => {
    assert.ok(fs.existsSync(SCRIPT_PATH), `expected script at ${SCRIPT_PATH}`);
  });

  it('emits one-line JSON ExtensionStatusEntry[] for a fixture dir (one valid + one broken)', () => {
    const { repoRoot, tasksDir, extDir } = makeTempRepo();
    toCleanup.push(repoRoot);

    // Valid extension
    writeFile(
      path.join(extDir, 'valid-ext.js'),
      "module.exports = { events: ['OnSessionStart'], handler: (ctx) => ctx.passthrough() };\n"
    );
    // Broken extension — throws on require
    writeFile(path.join(extDir, 'broken-ext.js'), "throw new Error('boom-at-load');\n");

    const out = runScript(['--repo-root', repoRoot, '--tasks-dir', tasksDir], {});
    assert.equal(out.exitCode, 0, `script failed: stderr=${out.stderr}`);
    assert.ok(out.stdout.trim().length > 0, 'expected JSON on stdout');

    // Default output must be one-line JSON (no trailing newline noise from indent).
    const lines = out.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `expected one-line JSON by default, got:\n${out.stdout}`);

    const parsed = JSON.parse(out.stdout);
    assert.ok(Array.isArray(parsed), 'output must be an array');
    assert.equal(parsed.length, 2, `expected 2 entries, got ${parsed.length}`);

    const valid = parsed.find((e) => e.file && e.file.includes('valid-ext'));
    const broken = parsed.find((e) => e.file && e.file.includes('broken-ext'));
    assert.ok(valid, 'expected entry for valid-ext.js');
    assert.ok(broken, 'expected entry for broken-ext.js');

    assert.equal(valid.loaded, true, 'valid extension should be loaded:true');
    assert.deepEqual(valid.events, ['OnSessionStart']);

    assert.equal(broken.loaded, false, 'broken extension should be loaded:false');
    assert.equal(typeof broken.error, 'string', 'broken entry must include error message');
    assert.ok(broken.error.length > 0, 'broken.error must be non-empty');
  });

  it('--pretty flag toggles indented JSON output', () => {
    const { repoRoot, tasksDir, extDir } = makeTempRepo();
    toCleanup.push(repoRoot);

    writeFile(
      path.join(extDir, 'valid-ext.js'),
      "module.exports = { events: ['OnSessionStart'], handler: (ctx) => ctx.passthrough() };\n"
    );

    const out = runScript(['--repo-root', repoRoot, '--tasks-dir', tasksDir, '--pretty'], {});
    assert.equal(out.exitCode, 0, `script failed: stderr=${out.stderr}`);

    // Pretty output spans multiple lines.
    const lines = out.stdout.trim().split('\n');
    assert.ok(lines.length > 1, `expected multi-line pretty JSON, got:\n${out.stdout}`);

    const parsed = JSON.parse(out.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].loaded, true);
  });

  it('emits empty JSON array when no extensions directory exists', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'status-cmd-empty-'));
    const tasksDir = path.join(repoRoot, 'tasks', 'GH-522');
    fs.mkdirSync(tasksDir, { recursive: true });
    toCleanup.push(repoRoot);

    const out = runScript(['--repo-root', repoRoot, '--tasks-dir', tasksDir], {});
    assert.equal(out.exitCode, 0, `script failed: stderr=${out.stderr}`);
    const parsed = JSON.parse(out.stdout);
    assert.deepEqual(parsed, []);
  });
});
