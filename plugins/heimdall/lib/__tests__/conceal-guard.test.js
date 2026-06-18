// Behavioral tests for the Heimdall conceal guard (read+write hard-deny, no
// unlock) and its config-builder script.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/conceal-guard.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'heimdall-conceal.js');
const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-conceal.js');

let repo;

/** Run the conceal-builder script: `heimdall-conceal.js <path> <repo>`. */
function conceal(target) {
  return spawnSync('node', [SCRIPT, target, repo], { encoding: 'utf8' });
}

/** Run the guard hook with a PreToolUse payload; returns its exit status. */
function guard(payload) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    encoding: 'utf8',
  });
  return res.status;
}

const readPayload = (p) => ({ tool_name: 'Read', tool_input: { file_path: p } });
const bashPayload = (cmd) => ({ tool_name: 'Bash', tool_input: { command: cmd } });

function readCfg() {
  return JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'heimdall-conceal.json'), 'utf8'));
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-conceal-'));
  fs.mkdirSync(path.join(repo, 'secret-folder'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'credentials', 'token.txt'), 'hi\n');
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('heimdall conceal guard', () => {
  it('is a no-op when the project has no conceal config', () => {
    assert.equal(guard(readPayload(path.join(repo, 'credentials', 'token.txt'))), 0);
  });

  it('conceals a file and creates the config', () => {
    const r = conceal('credentials/token.txt');
    assert.equal(r.status, 0);
    const cfg = readCfg();
    assert.ok(cfg.denyFilePatterns.some((p) => p.includes('credentials/token')));
    assert.ok(cfg.denyCommandPatterns.some((p) => p.includes('credentials/token')));
  });

  it('denies Read of a concealed file', () => {
    assert.equal(guard(readPayload(path.join(repo, 'credentials', 'token.txt'))), 2);
  });

  it('denies reads anywhere under a concealed folder', () => {
    assert.equal(conceal('secret-folder').status, 0);
    assert.equal(guard(readPayload(path.join(repo, 'secret-folder', 'nested', 'x.env'))), 2);
  });

  it('denies a Bash read of a concealed path mid-pipe', () => {
    assert.equal(guard(bashPayload(`cat ${repo}/credentials/token.txt | jq .`)), 2);
  });

  it('allows reads of unrelated paths', () => {
    assert.equal(guard(readPayload(path.join(repo, 'README.md'))), 0);
  });

  it('honors the payload cwd when CLAUDE_PROJECT_DIR is unset', () => {
    // No env var and a process cwd that differs from the project root: the guard
    // must resolve config from the payload's cwd (parity with the lock hook).
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify({
        cwd: repo,
        tool_name: 'Read',
        tool_input: { file_path: path.join(repo, 'credentials', 'token.txt') },
      }),
      env,
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    assert.equal(res.status, 2);
  });

  it('is idempotent — re-concealing the same path makes no new entry', () => {
    const before = readCfg().denyFilePatterns.length;
    assert.equal(conceal('secret-folder').status, 0);
    assert.equal(readCfg().denyFilePatterns.length, before);
  });
});

describe('malformed deny pattern does not fail open', () => {
  let badRepo;
  before(() => {
    badRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-badrx-'));
    fs.mkdirSync(path.join(badRepo, '.claude'), { recursive: true });
    // A malformed regex ("[") alongside a valid one: the bad pattern must be
    // skipped (not crash the hook), and the valid pattern must still enforce.
    fs.writeFileSync(
      path.join(badRepo, '.claude', 'heimdall-conceal.json'),
      JSON.stringify({
        denyFilePatterns: ['[', '(^|/)secret-folder(/|$)'],
        denyCommandPatterns: [],
      })
    );
  });
  after(() => fs.rmSync(badRepo, { recursive: true, force: true }));

  const guardIn = (payload) =>
    spawnSync('node', [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: badRepo },
      encoding: 'utf8',
    }).status;

  it('still denies the path covered by the valid pattern', () => {
    assert.equal(guardIn(readPayload(path.join(badRepo, 'secret-folder', 'x'))), 2);
  });

  it('does not crash (allows unrelated) despite the malformed pattern', () => {
    assert.equal(guardIn(readPayload(path.join(badRepo, 'other.txt'))), 0);
  });
});

describe('guard fails closed on a present-but-invalid config', () => {
  it('blocks (exit 2) instead of no-opping when the config is invalid JSON', () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-badcfg-'));
    fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(r, '.claude', 'heimdall-conceal.json'), '{ broken json');
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify(readPayload(path.join(r, 'anything.txt'))),
      env: { ...process.env, CLAUDE_PROJECT_DIR: r },
      encoding: 'utf8',
    });
    assert.equal(res.status, 2);
    fs.rmSync(r, { recursive: true, force: true });
  });
});

describe('conceal refuses to overwrite a corrupt config', () => {
  it('exits non-zero and leaves the invalid file untouched', () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-corrupt-'));
    fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
    const cfgPath = path.join(r, '.claude', 'heimdall-conceal.json');
    const original = '{ "secretsFiles": ["x"], not valid json';
    fs.writeFileSync(cfgPath, original);
    const res = spawnSync('node', [SCRIPT, 'foo.txt', r], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), original); // not overwritten
    fs.rmSync(r, { recursive: true, force: true });
  });
});

describe('conceal seeding preserves existing secrets coverage', () => {
  let secretsRepo;
  const guardIn = (dir, payload) =>
    spawnSync('node', [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    }).status;

  before(() => {
    secretsRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-secrets-'));
    fs.mkdirSync(path.join(secretsRepo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(secretsRepo, '.claude', 'heimdall-conceal.json'),
      JSON.stringify({
        secretsFiles: ['credentials/mcp-secrets.json'],
        denyFilePatterns: [],
        denyCommandPatterns: [],
      })
    );
  });

  after(() => fs.rmSync(secretsRepo, { recursive: true, force: true }));

  it('keeps secretsFiles + /proc-environ + PGPASSWORD coverage after concealing an unrelated path', () => {
    const r = spawnSync('node', [SCRIPT, 'logs', secretsRepo], { encoding: 'utf8' });
    assert.equal(r.status, 0);

    // secrets file still denied (derived pattern was seeded before appending)
    assert.equal(
      guardIn(secretsRepo, readPayload(path.join(secretsRepo, 'credentials', 'mcp-secrets.json'))),
      2
    );
    // newly concealed folder denied
    assert.equal(guardIn(secretsRepo, readPayload(path.join(secretsRepo, 'logs', 'a.txt'))), 2);
    // default command guards preserved
    assert.equal(guardIn(secretsRepo, bashPayload('cat /proc/123/environ')), 2);
  });
});
