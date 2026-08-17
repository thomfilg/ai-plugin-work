/**
 * check-dir-agreement.test.js
 *
 * The invariant that keeps /check in one piece: `check-setup.js` (which purges,
 * caches and tells the agents where to write) and `check-next.js` (which owns
 * `.check-state.json` and the report gates) must resolve the SAME directory for
 * the same ticket. Nothing asserted this before, and the two drifted — one used
 * the worktree layout, the other TASKS_BASE.
 *
 * Both sides are OBSERVED rather than recomputed: check-next.js is run with
 * `--init` and the directory it actually creates is compared against the
 * `reportFolder` check-setup.js actually reports. A test that re-derived either
 * rule would keep passing while the real ones diverged.
 *
 * The corpus covers the forms where the two leaf-name functions historically
 * disagreed — `deriveTaskId` used a hand-rolled character test while the
 * orchestrator used the provider sanitiser, so a GitHub `#279` became the
 * branch name on one side and `GH-279` on the other.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK_SETUP = path.join(__dirname, '..', 'hooks', 'check-setup.js');
const CHECK_NEXT = path.join(__dirname, '..', 'check-next.js');

let root;
let worktreesBase;
let tasksBase;
let repo;

const TICKETS = [
  ['ECHO-6842', 'plain ticket id'],
  ['#279', 'GitHub shorthand — sanitises to GH-279'],
  ['GH-181/phase1', 'suffix form — creates a subdirectory'],
];

function childEnv() {
  const env = {
    ...process.env,
    WORKTREES_BASE: worktreesBase,
    TASKS_BASE: tasksBase,
    TICKET_PROVIDER: 'github',
  };
  delete env.JIRA_TICKET_ID;
  delete env.TICKET_ID;
  return env;
}

/** reportFolder as check-setup.js actually computes it. */
function setupReportFolder(ticket) {
  const out = execFileSync(process.execPath, [CHECK_SETUP, ticket], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20000,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out).reportFolder;
}

/** The directory check-next.js actually creates for its orchestrator marker. */
function nextStateDir(ticket) {
  execFileSync(process.execPath, [CHECK_NEXT, ticket, '--init'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60000,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const markers = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === '.check-orchestrator.pid') markers.push(path.dirname(p));
    }
  };
  walk(root);
  assert.equal(markers.length, 1, `expected exactly one orchestrator marker, got ${markers}`);
  return markers[0];
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-dir-agreement-'));
  worktreesBase = path.join(root, 'worktrees');
  tasksBase = path.join(root, 'tasks');
  repo = path.join(worktreesBase, 'my-repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(tasksBase, { recursive: true });

  const git = (cmd) => execSync(cmd, { cwd: repo, stdio: 'ignore' });
  git('git init -b main');
  git('git config user.email "test@test.com"');
  git('git config user.name "Test"');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git('git add -A');
  git('git commit -m init');
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('check-setup and check-next resolve one directory', () => {
  for (const [ticket, label] of TICKETS) {
    it(`agrees for ${JSON.stringify(ticket)} — ${label}`, () => {
      // Fresh tasks tree per ticket so the marker scan is unambiguous.
      fs.rmSync(tasksBase, { recursive: true, force: true });
      fs.mkdirSync(tasksBase, { recursive: true });

      const fromNext = nextStateDir(ticket);
      const fromSetup = setupReportFolder(ticket);

      assert.equal(
        path.resolve(fromSetup),
        path.resolve(fromNext),
        `/check is split: reports would go to ${fromSetup}, state lives in ${fromNext}`
      );
      assert.ok(
        path.resolve(fromSetup).startsWith(path.resolve(tasksBase)),
        'both must resolve under the configured TASKS_BASE'
      );
    });
  }
});
