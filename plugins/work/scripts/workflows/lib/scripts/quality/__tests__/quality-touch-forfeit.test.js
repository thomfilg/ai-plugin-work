'use strict';

/**
 * Integration tests for the touch-to-fix ratchet in `quality.js`.
 *
 * Six scenarios mirroring `tasks/GH-592/gherkin.feature` AC1–AC6.
 *
 * Each test spawns the CLI against a temp git repo populated with synthetic
 * source files. Tests do NOT mock — they exercise the full wiring of
 * AllowlistLoader, config.getBaseBranch, and the new touchedFiles helper.
 *
 * Pattern (mkRepo / runCli / write) mirrors `quality.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'quality.js');

function mkRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-touch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, contents) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

function runCli(cwd, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BIOME_BRIDGE_DISABLE: '1', ...extraEnv },
  });
}

function bigLines(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`// line ${i}`);
  return out.join('\n');
}

function git(cwd, args, env = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
      ...env,
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res;
}

/**
 * Initialize a git repo with a base branch that represents the PR base
 * (synthesized as `refs/remotes/origin/main`). After this returns,
 * HEAD is on a `feature` branch whose diff against `origin/main` is empty;
 * additional commits on `feature` will appear in `${base}...HEAD`.
 */
function initRepo(dir) {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // First commit on main (empty so the base ref points somewhere stable).
  write(dir, '.gitkeep', '');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  // Synthesize `origin/main` so config.getBaseBranch's `git rev-parse --verify origin/main` succeeds.
  const mainSha = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  git(dir, ['update-ref', 'refs/remotes/origin/main', mainSha]);
  // Move onto a feature branch so future commits aren't on main itself.
  git(dir, ['checkout', '-q', '-b', 'feature']);
}

function commitAll(dir, msg) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

// -----------------------------------------------------------------------------
// AC1 — Untouched allowlisted file with violations: downgraded to warning.
// -----------------------------------------------------------------------------
test('AC1: allowlisted file not touched in PR → downgraded to warning, exit 0', (t) => {
  const repo = mkRepo(t);
  initRepo(repo);

  // Put the legacy file + allowlist into the BASE commit (origin/main).
  git(repo, ['checkout', '-q', 'main']);
  write(repo, 'src/legacy.js', bigLines(500));
  write(repo, '.quality-exceptions', 'src/legacy.js\n');
  commitAll(repo, 'add legacy + allowlist on base');
  const mainSha = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  git(repo, ['update-ref', 'refs/remotes/origin/main', mainSha]);

  // Back to feature; add an unrelated file so HEAD != base but legacy.js is untouched.
  git(repo, ['checkout', '-q', 'feature']);
  git(repo, ['merge', '-q', 'main', '--no-edit']);
  write(repo, 'src/other.js', "'use strict';\nmodule.exports = 1;\n");
  commitAll(repo, 'unrelated change');

  const res = runCli(repo);
  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /\(allowlisted\)/);
  assert.doesNotMatch(res.stdout + res.stderr, /allowlisted but touched/);
});

// -----------------------------------------------------------------------------
// AC2 — Touched allowlisted file with remaining violations: stays error, tagged.
// -----------------------------------------------------------------------------
test('AC2: allowlisted file touched in PR with violations → error, tagged, exit 1', (t) => {
  const repo = mkRepo(t);
  initRepo(repo);

  // Base: legacy.js exists clean + allowlist (allowlist on base).
  git(repo, ['checkout', '-q', 'main']);
  write(repo, 'src/legacy.js', "'use strict';\nmodule.exports = 1;\n");
  write(repo, '.quality-exceptions', 'src/legacy.js\n');
  commitAll(repo, 'base');
  const mainSha = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  git(repo, ['update-ref', 'refs/remotes/origin/main', mainSha]);

  // Feature: rewrite legacy.js to a violating file (touched in PR).
  git(repo, ['checkout', '-q', 'feature']);
  git(repo, ['merge', '-q', 'main', '--no-edit']);
  write(repo, 'src/legacy.js', bigLines(500));
  commitAll(repo, 'touch legacy');

  const res = runCli(repo);
  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(
    res.stdout + res.stderr,
    /allowlisted but touched in this PR — fix or remove from \.quality-exceptions/
  );
});

// -----------------------------------------------------------------------------
// AC3 — Touched allowlisted file with zero violations: no violation reported.
// -----------------------------------------------------------------------------
test('AC3: allowlisted file touched and now clean → no violation, exit 0', (t) => {
  const repo = mkRepo(t);
  initRepo(repo);

  git(repo, ['checkout', '-q', 'main']);
  // Base has legacy.js large + allowlisted.
  write(repo, 'src/legacy.js', bigLines(500));
  write(repo, '.quality-exceptions', 'src/legacy.js\n');
  commitAll(repo, 'base');
  const mainSha = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  git(repo, ['update-ref', 'refs/remotes/origin/main', mainSha]);

  // Feature: refactor legacy.js to satisfy every rule (touched in PR).
  git(repo, ['checkout', '-q', 'feature']);
  git(repo, ['merge', '-q', 'main', '--no-edit']);
  write(repo, 'src/legacy.js', "'use strict';\nmodule.exports = 1;\n");
  commitAll(repo, 'refactor legacy');

  const res = runCli(repo);
  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.doesNotMatch(res.stdout + res.stderr, /legacy\.js/);
});

// -----------------------------------------------------------------------------
// AC4 — Non-allowlisted file with violations (touched): error, no allowlist tag.
// -----------------------------------------------------------------------------
test('AC4: non-allowlisted file touched with violations → error, no tag, exit 1', (t) => {
  const repo = mkRepo(t);
  initRepo(repo);

  git(repo, ['checkout', '-q', 'main']);
  write(repo, '.quality-exceptions', '# empty\n');
  commitAll(repo, 'base');
  const mainSha = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  git(repo, ['update-ref', 'refs/remotes/origin/main', mainSha]);

  git(repo, ['checkout', '-q', 'feature']);
  git(repo, ['merge', '-q', 'main', '--no-edit']);
  write(repo, 'src/new.js', bigLines(500));
  commitAll(repo, 'add new big file');

  const res = runCli(repo);
  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /new\.js/);
  assert.doesNotMatch(res.stdout + res.stderr, /allowlisted/);
});

// -----------------------------------------------------------------------------
// AC5 — Git unavailable / base ref unresolvable: fail-open, legacy downgrade.
// -----------------------------------------------------------------------------
test('AC5: git diff unavailable → touched set empty (fail-open), legacy downgrade, exit 0', (t) => {
  // No git init — the directory is NOT a repo, so every git command fails.
  const repo = mkRepo(t);
  write(repo, 'src/legacy.js', bigLines(500));
  write(repo, '.quality-exceptions', 'src/legacy.js\n');

  const res = runCli(repo);
  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /\(allowlisted\)/);
  assert.doesNotMatch(res.stdout + res.stderr, /allowlisted but touched/);
});

// -----------------------------------------------------------------------------
// AC6 — BASE_BRANCH override is respected; touched set reflects custom base.
// -----------------------------------------------------------------------------
test('AC6: BASE_BRANCH override → touched set includes file diffed against custom base, exit 1', (t) => {
  const repo = mkRepo(t);
  initRepo(repo);

  // Build a custom base ref that does NOT contain legacy.js. Then on feature,
  // commit legacy.js — so diff(custom-base...HEAD) includes legacy.js.
  git(repo, ['checkout', '-q', 'main']);
  // The custom base = current main (no legacy.js, has allowlist).
  write(repo, '.quality-exceptions', 'src/legacy.js\n');
  commitAll(repo, 'base with allowlist only');
  const customSha = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  git(repo, ['update-ref', 'refs/remotes/origin/custom-base', customSha]);
  // Also keep origin/main valid for the default-path safety.
  git(repo, ['update-ref', 'refs/remotes/origin/main', customSha]);

  git(repo, ['checkout', '-q', 'feature']);
  git(repo, ['merge', '-q', 'main', '--no-edit']);
  // On feature: introduce a violating allowlisted legacy.js.
  write(repo, 'src/legacy.js', bigLines(500));
  commitAll(repo, 'add legacy on feature');

  const res = runCli(repo, [], { BASE_BRANCH: 'custom-base' });
  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(
    res.stdout + res.stderr,
    /allowlisted but touched in this PR — fix or remove from \.quality-exceptions/
  );
});
