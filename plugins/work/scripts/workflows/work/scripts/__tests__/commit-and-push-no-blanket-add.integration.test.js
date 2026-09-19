'use strict';

// GH-741: commit-and-push.js used to run `git add -A` before committing. In a
// worktree shared by several agents, that swept up OTHER agents' unrelated
// uncommitted edits into whichever agent happened to commit first — losing
// work three times in one session. The fix: commit only what the caller has
// already staged, and fail fast (exit 1, never touching git) when the index
// is empty.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'commit-and-push.js');

let TMP;
let BARE;
let REPO;
let ENV;

function sh(cmd, cwd) {
  return cp
    .execSync(cmd, { cwd, encoding: 'utf8', env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
    .trim();
}

/** Run commit-and-push.js as a subprocess; returns { status, stdout, stderr }. */
function runScript(args) {
  return cp.spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: ENV,
    timeout: 30000,
  });
}

describe('commit-and-push — no blanket `git add -A` (GH-741)', () => {
  before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-no-add-a-'));
    ENV = {
      ...process.env,
      HOME: TMP,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      TICKET_PROVIDER: 'github',
    };

    BARE = path.join(TMP, 'origin.git');
    REPO = path.join(TMP, 'repo');
    fs.mkdirSync(BARE);
    fs.mkdirSync(REPO);
    sh('git init --bare --initial-branch=main .', BARE);

    sh('git init --initial-branch=main .', REPO);
    sh('git config user.email "human@example.com"', REPO);
    sh('git config user.name "Test Human"', REPO);
    fs.writeFileSync(path.join(REPO, 'base.txt'), 'base\n');
    sh('git add base.txt', REPO);
    sh('git commit -m base', REPO);
    sh(`git remote add origin ${BARE}`, REPO);
    sh('git push -u origin main', REPO);
  });

  after(() => {
    if (TMP && fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('fails fast (exit 1) with nothing staged, never touching git', () => {
    fs.writeFileSync(path.join(REPO, 'untouched.txt'), 'unrelated agent work\n');
    const before = sh('git rev-parse HEAD', REPO);

    const r = runScript(['--cwd', REPO, '-m', 'fix(work): should not commit anything (#741)']);

    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /nothing staged/);
    assert.equal(sh('git rev-parse HEAD', REPO), before, 'HEAD must not move');
    assert.equal(
      sh('git status --porcelain', REPO),
      '?? untouched.txt',
      'the unrelated file stays untracked/uncommitted, not swept into a commit'
    );
    fs.rmSync(path.join(REPO, 'untouched.txt'));
  });

  it('commits only what was staged, leaving other agents’ uncommitted edits alone', () => {
    fs.writeFileSync(path.join(REPO, 'mine.txt'), 'my change\n');
    fs.writeFileSync(path.join(REPO, 'someone-elses.txt'), 'their unstaged work\n');
    sh('git add mine.txt', REPO);

    const r = runScript(['--cwd', REPO, '--no-push', '-m', 'feat(work): commit only mine (#741)']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);

    const committed = sh('git show --stat --name-only -1 --format=', REPO)
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(committed, ['mine.txt']);
    assert.equal(
      sh('git status --porcelain', REPO),
      '?? someone-elses.txt',
      "the other agent's file is untouched by this commit"
    );
  });
});
