'use strict';

// GH-697: /bootstrap creates worktrees with
//   `git worktree add <path> -b <branch> origin/<base>`
// which sets the new branch's upstream to origin/<base>. commit-and-push's
// plain `git push` then dies with "The upstream branch of your current branch
// does not match the name of your current branch" — the commit lands but the
// push fails. The fix pushes with `git push -u origin HEAD`, which publishes
// the branch under its own name and sets tracking (idempotent for branches
// that already track their same-name remote branch).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'commit-and-push.js');
const BRANCH = 'gh-697-first-push';

let TMP;
let BARE;
let SEED;
let WORKTREE;
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

describe('commit-and-push — fresh /bootstrap worktree first push (GH-697)', () => {
  before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-first-push-'));
    // Isolate git from the developer's global/system config so push.default,
    // hooksPath, and identity are deterministic. TICKET_PROVIDER=github makes
    // the message validator accept the `(#697)` ticket reference.
    ENV = {
      ...process.env,
      HOME: TMP,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      TICKET_PROVIDER: 'github',
    };

    BARE = path.join(TMP, 'origin.git');
    SEED = path.join(TMP, 'seed');
    WORKTREE = path.join(TMP, 'wt');
    fs.mkdirSync(BARE);
    fs.mkdirSync(SEED);
    sh('git init --bare --initial-branch=main .', BARE);

    sh('git init --initial-branch=main .', SEED);
    sh('git config user.email "human@example.com"', SEED);
    sh('git config user.name "Test Human"', SEED);
    fs.writeFileSync(path.join(SEED, 'base.txt'), 'base\n');
    sh('git add base.txt', SEED);
    sh('git commit -m base', SEED);
    sh(`git remote add origin ${BARE}`, SEED);
    sh('git push origin main', SEED);
    sh('git fetch origin', SEED);

    // Create the worktree EXACTLY the way /bootstrap does (SKILL.md:120) —
    // this is what leaves the new branch tracking origin/main.
    sh(`git worktree add ${WORKTREE} -b ${BRANCH} origin/main`, SEED);
  });

  after(() => {
    if (TMP && fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('repro premise: the bootstrap-style worktree tracks origin/<base>, so plain `git push` fails', () => {
    assert.equal(sh('git rev-parse --abbrev-ref @{upstream}', WORKTREE), 'origin/main');
    let failed = null;
    try {
      sh('git push', WORKTREE);
    } catch (err) {
      failed = err;
    }
    assert.ok(failed, 'expected plain `git push` to fail with an upstream mismatch');
    assert.match(String(failed.stderr), /does not match/);
  });

  it('first push from the fresh worktree succeeds and sets same-name tracking', () => {
    fs.writeFileSync(path.join(WORKTREE, 'change.txt'), 'change\n');
    const r = runScript(['--cwd', WORKTREE, '-m', 'fix(work): push new branch upstream (#697)']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stdout, /committed and pushed/);

    // The commit reached origin under the branch's own name…
    assert.equal(
      sh(`git rev-parse refs/heads/${BRANCH}`, BARE),
      sh('git rev-parse HEAD', WORKTREE)
    );
    // …and the worktree now tracks origin/<branch>, not origin/main.
    assert.equal(sh('git rev-parse --abbrev-ref @{upstream}', WORKTREE), `origin/${BRANCH}`);
  });

  it('regression: a second push on the now-tracking branch still works', () => {
    fs.writeFileSync(path.join(WORKTREE, 'change2.txt'), 'more\n');
    const r = runScript([
      '--cwd',
      WORKTREE,
      '-m',
      'fix(work): push again on tracking branch (#697)',
    ]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.equal(
      sh(`git rev-parse refs/heads/${BRANCH}`, BARE),
      sh('git rev-parse HEAD', WORKTREE)
    );
    assert.equal(sh('git rev-parse --abbrev-ref @{upstream}', WORKTREE), `origin/${BRANCH}`);
  });
});
