/**
 * Tests for scripts/codemod-plugin-root-preamble.js (WP-10 — design §G, C18).
 *
 * Proves:
 *   - IDEMPOTENCE: running the codemod twice produces no further diff, and
 *     the checked-in tree is fully applied (`--check` exits 0)
 *   - the preamble/arguments-note blocks land only where the body calls for
 *     them (CLAUDE_PLUGIN_ROOT / $ARGUMENTS usage)
 *   - THE ACCEPTANCE: the preamble's bash logic resolves the plugin root
 *     correctly in all four env states — unset, set-but-wrong (probe P1),
 *     set-but-wrong-with-colliding-skill-name, and correctly set
 *
 * Run with: node --test scripts/__tests__/codemod-plugin-root-preamble.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CODEMOD = path.join(REPO_ROOT, 'scripts', 'codemod-plugin-root-preamble.js');
const { preambleBlock, PREAMBLE_MARKER, ARGS_MARKER } = require(CODEMOD);

function fixtureSkill(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemod-preamble-'));
  const skillDir = path.join(dir, 'plugins', 'demo', 'skills', 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: demo-skill\ndescription: d\n---\n\n${body}\n`);
  return file;
}

function runCodemod(args) {
  return spawnSync('node', [CODEMOD, ...args], { encoding: 'utf8' });
}

/** Extract the bash snippet between the preamble's fences, de-blockquoted. */
function preambleSnippet(skillName) {
  const lines = preambleBlock(skillName).split('\n');
  const start = lines.findIndex((l) => l.includes('```bash'));
  const end = lines.findIndex((l, i) => i > start && l.trim() === '> ```');
  return lines
    .slice(start + 1, end)
    .map((l) => l.replace(/^> /, ''))
    .join('\n');
}

/** Build a plugin tree containing skills/<name>/SKILL.md; returns its root. */
function plantPlugin(base, plugin, skillName) {
  const root = path.join(base, plugin);
  fs.mkdirSync(path.join(root, 'skills', skillName), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', skillName, 'SKILL.md'),
    `---\nname: ${skillName}\n---\n`
  );
  return root;
}

/** Run the preamble logic with SKILL_MD + env, return the resolved root. */
function resolveRoot(skillMd, env) {
  const script = `SKILL_MD=${JSON.stringify(skillMd)}\n${preambleSnippet('demo-skill').replace(/^SKILL_MD=.*\n/, '')}\nprintf '%s' "$PLUGIN_ROOT"`;
  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.stdout;
}

describe('codemod-plugin-root-preamble — application + idempotence', () => {
  it('the checked-in tree is fully applied (--check exits 0)', () => {
    const res = runCodemod(['--check']);
    assert.strictEqual(res.status, 0, res.stdout);
    assert.match(res.stdout, /0 of \d+ file\(s\) would change/);
  });

  it('inserts both blocks once, and a second run is a no-op', () => {
    const file = fixtureSkill('Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/x.js` with $ARGUMENTS.');
    runCodemod([file]);
    const once = fs.readFileSync(file, 'utf8');
    assert.ok(once.includes(PREAMBLE_MARKER));
    assert.ok(once.includes(ARGS_MARKER));
    assert.ok(once.includes('skills/demo-skill/SKILL.md'), 'per-skill marker path');
    const second = runCodemod([file]);
    assert.match(second.stdout, /0 of 1 file\(s\) updated/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), once, 'idempotent');
  });

  it('skips bodies that neither call scripts nor use $ARGUMENTS', () => {
    const file = fixtureSkill('Pure prose skill.');
    const res = runCodemod([file]);
    assert.match(res.stdout, /0 of 1 file\(s\) updated/);
  });

  it('adds only the arguments note when no script is called', () => {
    const file = fixtureSkill('Echo back $ARGUMENTS.');
    runCodemod([file]);
    const out = fs.readFileSync(file, 'utf8');
    assert.ok(!out.includes(PREAMBLE_MARKER));
    assert.ok(out.includes(ARGS_MARKER));
  });
});

describe('codemod-plugin-root-preamble — preamble bash logic (probe P1)', () => {
  it('unset CLAUDE_PLUGIN_ROOT → self-locates from SKILL_MD', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preamble-env-'));
    const real = plantPlugin(base, 'real-plugin', 'demo-skill');
    const skillMd = path.join(real, 'skills', 'demo-skill', 'SKILL.md');
    assert.strictEqual(resolveRoot(skillMd, {}), fs.realpathSync(real));
  });

  it('set-but-WRONG root (no marker) → self-locates (bare :- fallback would fail here)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preamble-env-'));
    const real = plantPlugin(base, 'real-plugin', 'demo-skill');
    const wrong = path.join(base, 'stale-plugins-dir');
    fs.mkdirSync(wrong, { recursive: true });
    const skillMd = path.join(real, 'skills', 'demo-skill', 'SKILL.md');
    assert.strictEqual(resolveRoot(skillMd, { CLAUDE_PLUGIN_ROOT: wrong }), fs.realpathSync(real));
  });

  it('set-but-wrong root with a COLLIDING skill name → -ef check rejects it', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preamble-env-'));
    const real = plantPlugin(base, 'real-plugin', 'demo-skill');
    const impostor = plantPlugin(base, 'other-plugin', 'demo-skill');
    const skillMd = path.join(real, 'skills', 'demo-skill', 'SKILL.md');
    assert.strictEqual(
      resolveRoot(skillMd, { CLAUDE_PLUGIN_ROOT: impostor }),
      fs.realpathSync(real)
    );
  });

  it('correctly set root → used as-is (Claude Code no-op branch)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preamble-env-'));
    const real = plantPlugin(base, 'real-plugin', 'demo-skill');
    const skillMd = path.join(real, 'skills', 'demo-skill', 'SKILL.md');
    assert.strictEqual(resolveRoot(skillMd, { CLAUDE_PLUGIN_ROOT: real }), real);
  });
});
