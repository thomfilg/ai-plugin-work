/**
 * End-to-end tests for `document-note.js`, the document step's only writer.
 *
 * Spawned as a real process so the env-driven sink resolution (memory plugin
 * detection, worktree resolution) is exercised the way the agent will hit it,
 * not stubbed.
 *
 * Run: node --test scripts/workflows/work-document/__tests__/document-note.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'document-note.js');
const TICKET = 'GH-800';
const REPO = 'demo';

const GOOD_SUMMARY =
  'Reworked the cache key to include the shard index; the old key collided across ' +
  'shards and the failure only showed up under parallel CI, never locally.';

let root;
let env;
let tasksDir;
let worktree;

/**
 * A private HOME so memory detection sees only what a test puts there:
 * detectMemoryPlugin probes `~/.claude/plugins/**`, and os.homedir() honours
 * $HOME on POSIX.
 */
function baseEnv(home) {
  return {
    ...process.env,
    HOME: home,
    TASKS_BASE: path.join(root, 'tasks'),
    WORKTREES_BASE: path.join(root, 'worktrees'),
    REPO_NAME: REPO,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-note-'));
  const home = path.join(root, 'home');
  tasksDir = path.join(root, 'tasks', TICKET);
  worktree = path.join(root, 'worktrees', `${REPO}-${TICKET}`);
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cache'), { recursive: true });
  env = baseEnv(home);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Install a fake cortex plugin so detection finds a memory system. */
function installCortex() {
  fs.mkdirSync(path.join(env.HOME, '.claude', 'plugins', 'cache', 'cortex'), { recursive: true });
}

function run(args, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

function writeDocNote() {
  const file = path.join(worktree, 'docs', 'work-notes', `${TICKET}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${TICKET}\n\n${GOOD_SUMMARY}\n${'detail. '.repeat(30)}`);
  return file;
}

describe('document-note.js sink', () => {
  it('reports the docs sink when no memory plugin is installed', () => {
    const { code, out } = run(['sink', TICKET]);
    assert.equal(code, 0);
    assert.match(out, /^docs\t/);
    assert.ok(out.includes(path.join(worktree, 'docs', 'work-notes', `${TICKET}.md`)));
  });

  it('reports the memory sink and its remember tool when one is installed', () => {
    installCortex();
    const { code, out } = run(['sink', TICKET]);
    assert.equal(code, 0);
    assert.match(out, /^memory\tcortex\tmcp__plugin_cortex_cortex__cortex_remember/);
  });
});

describe('document-note.js record — refuses what would not be a note', () => {
  it('rejects a summary too short to say anything', () => {
    const { code, err } = run(['record', TICKET, '--summary', 'done']);
    assert.equal(code, 1);
    assert.match(err, /substantive characters/);
    assert.ok(!fs.existsSync(path.join(tasksDir, '.document-notes.json')));
  });

  it('rejects a docs sink while a memory plugin is configured', () => {
    installCortex();
    const { code, err } = run([
      'record',
      TICKET,
      '--path',
      writeDocNote(),
      '--summary',
      GOOD_SUMMARY,
    ]);
    assert.equal(code, 1);
    assert.match(err, /save through mcp__plugin_cortex_cortex__cortex_remember/);
  });

  it('rejects a memory sink while no memory plugin is configured', () => {
    const { code, err } = run([
      'record',
      TICKET,
      '--tool',
      'some_remember',
      '--summary',
      GOOD_SUMMARY,
    ]);
    assert.equal(code, 1);
    assert.match(err, /no memory plugin is configured/);
  });
});

describe('document-note.js record → verify', () => {
  it('verify fails before anything is recorded', () => {
    const { code, err } = run(['verify', TICKET]);
    assert.equal(code, 1);
    assert.match(err, /NOT satisfied/);
  });

  it('records a docs note and then verifies', () => {
    writeDocNote();
    const rec = run(['record', TICKET, '--summary', GOOD_SUMMARY]);
    assert.equal(rec.code, 0, rec.err);
    assert.match(rec.out, /Recorded docs note/);

    const ver = run(['verify', TICKET]);
    assert.equal(ver.code, 0, ver.err);
    assert.match(ver.out, /1 valid note/);
  });

  it('records a memory note and then verifies', () => {
    installCortex();
    const rec = run(['record', TICKET, '--summary', GOOD_SUMMARY]);
    assert.equal(rec.code, 0, rec.err);
    assert.match(rec.out, /Recorded memory note/);
    assert.equal(run(['verify', TICKET]).code, 0);

    const stored = JSON.parse(fs.readFileSync(path.join(tasksDir, '.document-notes.json'), 'utf8'));
    assert.equal(stored.notes[0].sink, 'memory');
    assert.equal(stored.notes[0].memory, 'cortex');
  });

  it('a docs note recorded without its file never verifies', () => {
    // The record call warns rather than silently storing a passing receipt.
    const rec = run(['record', TICKET, '--summary', GOOD_SUMMARY]);
    assert.equal(rec.code, 1);
    assert.match(rec.err, /NOT satisfied/);
    assert.equal(run(['verify', TICKET]).code, 1);
  });

  it('stops verifying when the recorded docs file is deleted afterwards', () => {
    const file = writeDocNote();
    assert.equal(run(['record', TICKET, '--summary', GOOD_SUMMARY]).code, 0);
    assert.equal(run(['verify', TICKET]).code, 0);
    fs.rmSync(file);
    assert.equal(run(['verify', TICKET]).code, 1, 'deleting the note must fail the step again');
  });
});

describe('document-note.js — an unresolvable worktree narrows the target', () => {
  /** Point WORKTREES_BASE at nothing so resolveTicketWorktree gives up. */
  function noWorktree() {
    return { WORKTREES_BASE: path.join(root, 'absent'), REPO_NAME: 'nope' };
  }

  it('sink falls back to work-notes.md in the tasks dir', () => {
    const { code, out } = run(['sink', TICKET], noWorktree());
    assert.equal(code, 0);
    assert.match(out, /^docs\t/);
    assert.ok(out.includes(path.join(tasksDir, 'work-notes.md')));
  });

  it('records and verifies a note written to that fallback path', () => {
    fs.writeFileSync(path.join(tasksDir, 'work-notes.md'), `# ${TICKET}\n${'detail. '.repeat(40)}`);
    const rec = run(['record', TICKET, '--summary', GOOD_SUMMARY], noWorktree());
    assert.equal(rec.code, 0, rec.err);
    assert.equal(run(['verify', TICKET], noWorktree()).code, 0);
  });

  it('refuses a readable file outside every root', () => {
    // The gate is about the note being where a later run looks — not about
    // some file, somewhere, being long enough.
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, 'x'.repeat(400));
    const rec = run(['record', TICKET, '--path', outside, '--summary', GOOD_SUMMARY], noWorktree());
    assert.equal(rec.code, 1);
    assert.match(rec.err, /NOT satisfied/);
    assert.equal(run(['verify', TICKET], noWorktree()).code, 1);
  });
});

describe('document-note.js usage', () => {
  it('exits 2 without a command or ticket', () => {
    assert.equal(run([]).code, 2);
    assert.equal(run(['record']).code, 2);
  });

  it('exits 2 on an unknown command', () => {
    assert.equal(run(['frobnicate', TICKET]).code, 2);
  });
});
