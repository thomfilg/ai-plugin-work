// GH-689: basename-marker collisions — classify path tokens before counting a
// marker hit as a reference to a protected entry.
//
// A lock on <repo>/.claude must not block the agent toolchain under the HOME
// config dir (~/.claude/plugins/cache/**, settings, commit scripts) or any
// other foreign absolute path. Every lane (bash write, Task prompt,
// script-bypass content scan) is pinned in BOTH directions — foreign ALLOW and
// protected BLOCK — so the fix can never silently widen into a bypass.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/guard-foreign-path.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildEntries, evaluate } = require(path.resolve(__dirname, '..', 'guard'));
const { markerOnlyInForeignPaths, markerOnPathBoundary } = require(
  path.resolve(__dirname, '..', 'guard', 'paths')
);
const fsguard = require(path.resolve(__dirname, '..', 'guard', 'fsguard'));

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Home-scratch base dir, mirroring guard.test.js: NOT under os.tmpdir() (the
// engine exempts temp paths by design — GH-658), realpath'd so token
// resolution and entry.dir agree byte-for-byte. The lock set protects the
// PROJECT `.claude` only — it does NOT protect `~/.claude`.

const LOCKS = [{ protect: ['.claude'], unlockPhrase: 'edit .claude' }];
const SHORT_LOCKS = [{ protect: ['.github', 'ui', 'src'], unlockPhrase: 'edit protected dirs' }];

let root; // scratch OUTSIDE any temp prefix
let fakeHome; // stand-in for a foreign home config parent: <root>/home
let repo; // the locked project base: <root>/repo
let repoShort; // base dir for the short-marker lock set: <root>/repo2
let foreignRoot; // unrelated absolute location: <root>/elsewhere
let scriptsDir; // interpreter scripts living outside any marker-named path
let cacheScript; // <fakeHome>/.claude/plugins/cache/task/run.js
let transcriptEmpty;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.heimdall-gh689-')));
  fakeHome = path.join(root, 'home');
  repo = path.join(root, 'repo');
  repoShort = path.join(root, 'repo2');
  foreignRoot = path.join(root, 'elsewhere');
  scriptsDir = path.join(root, 'scripts');
  cacheScript = path.join(fakeHome, '.claude', 'plugins', 'cache', 'task', 'run.js');
  fs.mkdirSync(path.dirname(cacheScript), { recursive: true });
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.mkdirSync(repoShort, { recursive: true });
  fs.mkdirSync(foreignRoot, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(cacheScript, "console.log('ok');\n");
  const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-gh689-tx-'));
  transcriptEmpty = path.join(txDir, 'empty.jsonl');
  fs.writeFileSync(
    transcriptEmpty,
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n'
  );
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.dirname(transcriptEmpty), { recursive: true, force: true });
});

const claudeEntry = () => buildEntries(LOCKS, repo)[0];
const run = (toolName, toolInput) =>
  evaluate({
    toolName,
    toolInput,
    transcriptPath: transcriptEmpty,
    entries: buildEntries(LOCKS, repo),
  });
const bash = (command) => run('Bash', { command });
const bashShort = (command) =>
  evaluate({
    toolName: 'Bash',
    toolInput: { command },
    transcriptPath: transcriptEmpty,
    entries: buildEntries(SHORT_LOCKS, repoShort),
  });
// Force the static script-bypass fallback (no runtime shim) for one call.
const staticBash = (command) => {
  process.env.HEIMDALL_DISABLE_SHIM = '1';
  try {
    return bash(command);
  } finally {
    delete process.env.HEIMDALL_DISABLE_SHIM;
  }
};
const script = (name, body) => {
  const p = path.join(scriptsDir, name);
  fs.writeFileSync(p, body);
  return p;
};

// ─── paths.js export surface (R1) ────────────────────────────────────────────

describe('paths.js exports the GH-689 classifier surface', () => {
  it('exports markerOnlyInForeignPaths as a function', () => {
    assert.equal(
      typeof markerOnlyInForeignPaths,
      'function',
      'markerOnlyInForeignPaths must be exported from guard/paths'
    );
  });

  it('re-exports markerOnPathBoundary (moved from bash.js)', () => {
    assert.equal(
      typeof markerOnPathBoundary,
      'function',
      'markerOnPathBoundary must be exported from guard/paths'
    );
  });
});

// ─── markerOnlyInForeignPaths: four classification clauses (R1/R3/R13) ───────

describe('markerOnlyInForeignPaths classifier', () => {
  it('clause 1: an absolute token under the home config dir is foreign when entry.dir is elsewhere', () => {
    const text = `mkdir -p ${os.homedir()}/.claude/plugins/cache/job-1`;
    assert.equal(markerOnlyInForeignPaths(text, '.claude', claudeEntry()), true, text);
  });

  it('clause 2: an absolute token under a temp prefix is foreign (GH-658 parity)', () => {
    const text = 'echo x > /tmp/heimdall-scratch/.claude/settings.json';
    assert.equal(markerOnlyInForeignPaths(text, '.claude', claudeEntry()), true, text);
  });

  it('clause 3: a statically-clean absolute token resolving elsewhere is foreign', () => {
    const text = `cp /tmp/settings.bak ${foreignRoot}/.claude/settings.json`;
    assert.equal(markerOnlyInForeignPaths(text, '.claude', claudeEntry()), true, text);
  });

  it('clause 3: a token under entry.dir is a reference, not foreign', () => {
    const entry = claudeEntry();
    const text = `echo x > ${entry.dir}/settings.json`;
    assert.equal(markerOnlyInForeignPaths(text, '.claude', entry), false, text);
  });

  it('clause 3: a token exactly equal to entry.dir is a reference', () => {
    const entry = claudeEntry();
    const text = `rm -rf ${entry.dir}`;
    assert.equal(markerOnlyInForeignPaths(text, '.claude', entry), false, text);
  });

  it('fail-closed: a relative token never exonerates', () => {
    const text = 'sed -i s/a/b/ .claude/settings.json';
    assert.equal(markerOnlyInForeignPaths(text, '.claude', claudeEntry()), false, text);
  });

  it('fail-closed: a $VAR-bearing token is unresolvable', () => {
    const text = 'cp x $DIR/.claude/y';
    assert.equal(markerOnlyInForeignPaths(text, '.claude', claudeEntry()), false, text);
  });

  it('fail-closed: a backtick-delimited concatenation fragment stays a reference', () => {
    // `pwd`/.claude/y: the extracted token is `/.claude/y` — a fragment glued
    // onto a runtime base, not a real root path. Must NOT classify as foreign.
    const text = 'cp x `pwd`/.claude/y';
    assert.equal(markerOnlyInForeignPaths(text, '.claude', claudeEntry()), false, text);
  });

  it('fail-closed: a glob-bearing token is unresolvable', () => {
    const text = 'cp x /a/*/.claude/y';
    assert.equal(markerOnlyInForeignPaths(text, '.claude', claudeEntry()), false, text);
  });

  it('fail-closed: a bare marker token is a reference', () => {
    const text = 'touch .claude';
    assert.equal(markerOnlyInForeignPaths(text, '.claude', claudeEntry()), false, text);
  });

  it('returns false when the marker does not occur in the text', () => {
    assert.equal(markerOnlyInForeignPaths('ls -la /tmp', '.claude', claudeEntry()), false);
  });
});

describe('markerOnPathBoundary (GH-642 helper moved to paths.js)', () => {
  it('a mid-word token like myui.clauderc does not sit on a path boundary', () => {
    assert.equal(markerOnPathBoundary('.claude', 'myui.clauderc'), false);
  });

  it('a slash-delimited path token sits on a path boundary', () => {
    assert.equal(markerOnPathBoundary('.claude', `rm -rf ${os.homedir()}/.claude/x`), true);
  });
});

// ─── Bash lane: two-direction matrix through buildEntries + evaluate (R2/R6) ─

describe('bash lane: foreign paths no longer collide with the basename marker', () => {
  it('Bash write into the home config dir is allowed under a project .claude lock', () => {
    const tilde = bash('mkdir -p ~/.claude/plugins/cache/job-1');
    assert.equal(tilde.exitCode, 0, `tilde form should be allowed: ${tilde.message}`);
    const absolute = bash(`cp /tmp/settings.bak ${fakeHome}/.claude/settings.json`);
    assert.equal(
      absolute.exitCode,
      0,
      `absolute foreign form should be allowed: ${absolute.message}`
    );
  });

  it('Bash write into the protected .claude dir by absolute path still blocks', () => {
    const r = bash(`cp /tmp/settings.bak ${repo}/.claude/settings.json`);
    assert.equal(r.exitCode, 2, 'protected absolute write must block');
    assert.match(r.message, /edit \.claude/, 'block message must name the unlock phrase');
  });

  it('Bash write via a relative .claude path stays fail-closed', () => {
    const r = bash("sed -i 's/a/b/' .claude/settings.json");
    assert.equal(r.exitCode, 2, 'relative marker write must stay blocked');
  });

  it('cd-template verdicts agree with and without a trailing separator', () => {
    const invoke = `cd ${repo} && node ${cacheScript}`;
    const withTail = bash(`${invoke}; echo done`);
    const withoutTail = bash(invoke);
    assert.equal(withTail.exitCode, 0, `trailing separator form: ${withTail.message}`);
    assert.equal(withoutTail.exitCode, 0, `bare form: ${withoutTail.message}`);
    assert.equal(
      withTail.exitCode,
      withoutTail.exitCode,
      'a trailing `;` must not flip the verdict'
    );
  });

  it('cd-template still blocks when the named script path is repo-local', () => {
    const r = bash(`cd ${fakeHome} && node ${repo}/.claude/cache/job.js; echo done`);
    assert.equal(r.exitCode, 2, 'repo-local script path under cd-template must block');
  });

  it('Obfuscated home-path write is allowed while obfuscated protected write still blocks', () => {
    const home = bash(`mkdir -p ${fakeHome}/.cl""aude/plugins/state`);
    assert.equal(home.exitCode, 0, `dequoted foreign write should be allowed: ${home.message}`);
    const homeClass = bash(`mkdir -p ${fakeHome}/.cl[a]ude/plugins/state`);
    assert.equal(
      homeClass.exitCode,
      0,
      `char-class foreign write should be allowed: ${homeClass.message}`
    );
    const repoObf = bash(`echo x > ${repo}/.cl""aude/settings.json`);
    assert.equal(repoObf.exitCode, 2, 'dequoted protected write must still block (GH-655)');
  });

  it('short marker .github: foreign absolute path is allowed, lock-base write still blocks', () => {
    const allow = bashShort(`cp /tmp/ci.yml ${foreignRoot}/.github/workflows/ci.yml`);
    assert.equal(allow.exitCode, 0, `foreign .github write: ${allow.message}`);
    const block = bashShort(`cp /tmp/ci.yml ${repoShort}/.github/workflows/ci.yml`);
    assert.equal(block.exitCode, 2, 'lock-base .github write must block');
  });

  it('short marker ui: foreign absolute path is allowed, lock-base write still blocks', () => {
    const allow = bashShort(`mkdir -p ${foreignRoot}/ui/components`);
    assert.equal(allow.exitCode, 0, `foreign ui write: ${allow.message}`);
    const block = bashShort(`mkdir -p ${repoShort}/ui/components`);
    assert.equal(block.exitCode, 2, 'lock-base ui write must block');
  });

  it('short marker src: foreign absolute path is allowed, lock-base write still blocks', () => {
    const allow = bashShort(`touch ${foreignRoot}/src/index.js`);
    assert.equal(allow.exitCode, 0, `foreign src write: ${allow.message}`);
    const block = bashShort(`touch ${repoShort}/src/index.js`);
    assert.equal(block.exitCode, 2, 'lock-base src write must block');
  });
});

// ─── Task lane: prompts naming foreign paths are not references (R4/R6) ──────

describe('task lane: boundary floor + foreign exemption', () => {
  it('Task prompt naming a home plugin-cache script is allowed', () => {
    const r = run('Task', { prompt: `Update the flags in ${cacheScript} and rerun the job` });
    assert.equal(r.exitCode, 0, r.message);
  });

  it('Task prompt asking to modify the protected dir still blocks', () => {
    const r = run('Task', { prompt: `Update the settings in ${repo}/.claude/config and save` });
    assert.equal(r.exitCode, 2, 'protected-dir prompt must block');
  });

  it('Task prompt with the basename buried mid-word is not a reference', () => {
    const r = run('Task', {
      prompt: 'Rewrite the overview in myproject.clauderc-notes.md to mention the new flags',
    });
    assert.equal(r.exitCode, 0, r.message);
  });
});

// ─── Script-bypass lane: content scan with the shim unavailable (R5/R6) ──────

describe('script-bypass lane: content refs are classified (shim disabled)', () => {
  it('Script whose source only references the home config dir is allowed when the shim is unavailable', () => {
    const s = script(
      'foreign-write.js',
      `require('fs').writeFileSync('${fakeHome}/.claude/plugins/state.json', 'x');\n`
    );
    const r = staticBash(`node ${s}`);
    assert.equal(r.exitCode, 0, r.message);
  });

  it('Script whose source writes under the protected dir still blocks when the shim is unavailable', () => {
    const s = script(
      'repo-write.js',
      `require('fs').writeFileSync('${repo}/.claude/state.json', 'x');\n`
    );
    assert.equal(staticBash(`node ${s}`).exitCode, 2, 'protected-dir script write must block');
  });

  it('Script source with a relative .claude reference stays fail-closed', () => {
    const s = script(
      'relative-write.js',
      `require('fs').writeFileSync('.claude/state.json', 'x');\n`
    );
    assert.equal(staticBash(`node ${s}`).exitCode, 2, 'relative script ref must stay blocked');
  });
});

// ─── Shim rewrite marker (R10, vector 4) ─────────────────────────────────────

describe('shim rewrite: classifier-recognizable prefix', () => {
  it('Shim rewrite carries the stable heimdall marker prefix', () => {
    assert.equal(
      typeof fsguard.SHIM_REWRITE_MARKER,
      'string',
      'fsguard must export SHIM_REWRITE_MARKER'
    );
    assert.equal(
      fsguard.SHIM_REWRITE_MARKER,
      ": 'heimdall-fsguard-rewrite-v1';",
      'marker must be the pinned POSIX no-op'
    );
    const rewrite = fsguard.buildShimRewrite(
      'node build.js',
      [{ dir: `${repo}/.claude`, isFile: false, allowedPaths: null }],
      '/x/heimdall-fsguard.so'
    );
    assert.ok(
      rewrite.startsWith(fsguard.SHIM_REWRITE_MARKER),
      'rewrite must start with the stable marker'
    );
    assert.match(rewrite, /LD_PRELOAD=.*heimdall-fsguard/, 'existing LD_PRELOAD pin must survive');
    assert.ok(rewrite.endsWith('node build.js'), 'original command must stay the suffix');
  });
});
