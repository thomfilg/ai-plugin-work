'use strict';

// RED phase — Task 11 (GH-513): Integration test for unknown-domain lint
// in `synapsys-staleness-check.js`.
//
// Spawns the real CLI against a tmpdir fixture containing a seeded
// DOMAINS.md (Task 3 shape) and memories tagged with a mix of valid +
// invalid domain values, and asserts:
//   - Lint warning lines naming the memory and the unresolved domain.
//   - `--strict` exits non-zero when any unknown-domain warning is emitted.
//   - Backward-compat: memories without `domain:` emit no warnings.
//
// Scenario coverage: "Lint warns when a memory references an unknown domain"

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STALENESS_CLI = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-staleness-check.js');

const SEEDED_DOMAINS = [
  'root: e2e',
  '  leaf: local-execution',
  '    signal_prompt: \\be2e\\b',
  '  leaf: flake-triage',
  '    signal_prompt: \\bflake\\b',
  'root: git',
  '  leaf: plumbing-ops',
  '    signal_prompt: \\bgit\\s+merge\\b',
  '',
].join('\n');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-staleness-domain-'));
  // .git so repoRoot resolves cleanly.
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });

  // Seeded DOMAINS.md under a fake $HOME so loadDomainRegistry picks it up.
  const fakeHome = path.join(root, 'home');
  const domainsDir = path.join(fakeHome, '.claude', 'synapsys');
  fs.mkdirSync(domainsDir, { recursive: true });
  fs.writeFileSync(path.join(domainsDir, 'DOMAINS.md'), SEEDED_DOMAINS);

  // Local store under repo .claude/synapsys.
  const storeDir = path.join(root, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), JSON.stringify({ projectName: 'test' }));
  return { root, fakeHome, storeDir };
}

function writeMemory(storeDir, fileName, frontmatter) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(storeDir, fileName), `---\n${fm}\n---\nbody text\n`);
}

function run(args, opts = {}) {
  const env = Object.assign(
    {},
    process.env,
    { NO_COLOR: '1', HOME: opts.home || process.env.HOME },
    opts.env || {}
  );
  return spawnSync(process.execPath, [STALENESS_CLI, ...args], {
    encoding: 'utf8',
    env,
  });
}

test('Lint warns when a memory references an unknown domain (integration)', () => {
  const { root, fakeHome, storeDir } = makeFixture();
  writeMemory(storeDir, 'bad-leaf.md', {
    name: 'bad-leaf-mem',
    description: 'tagged with an unknown leaf',
    trigger_prompt: '/\\bsomething\\b/',
    domain: 'e2e:nonexistent-leaf',
  });

  const r = run([`--cwd=${root}`, `--store=${storeDir}`, '--no-color'], {
    home: fakeHome,
  });

  // Warning naming the memory and the unresolved domain must appear in
  // stderr or stdout; the CLI may emit lint warnings on either channel.
  const combined = (r.stdout || '') + '\n' + (r.stderr || '');
  assert.match(combined, /bad-leaf-mem/, `warning should name the memory; output:\n${combined}`);
  assert.match(
    combined,
    /e2e:nonexistent-leaf/,
    `warning should name the unresolved domain; output:\n${combined}`
  );
});

test('--strict exits non-zero when an unknown-domain warning is emitted', () => {
  const { root, fakeHome, storeDir } = makeFixture();
  writeMemory(storeDir, 'bad.md', {
    name: 'bad-mem',
    description: 'd',
    domain: 'totally-unknown-root',
  });

  const r = run([`--cwd=${root}`, `--store=${storeDir}`, '--strict', '--no-color'], {
    home: fakeHome,
  });
  assert.notEqual(
    r.status,
    0,
    `--strict should exit non-zero on unknown-domain warning; got ${r.status}. stdout=${r.stdout}\nstderr=${r.stderr}`
  );
});

test('without --strict the CLI still exits 0 when only unknown-domain warnings are present', () => {
  const { root, fakeHome, storeDir } = makeFixture();
  writeMemory(storeDir, 'bad.md', {
    name: 'bad-mem',
    description: 'd',
    domain: 'unknown-root',
  });

  const r = run([`--cwd=${root}`, `--store=${storeDir}`, '--no-color'], {
    home: fakeHome,
  });
  // No drifted / orphan sources, only an unknown-domain warning → exit 0
  // unless --strict is passed.
  assert.equal(
    r.status,
    0,
    `expected exit 0 without --strict; got ${r.status}. stdout=${r.stdout}\nstderr=${r.stderr}`
  );
});

test('backward-compat: memory without `domain:` produces no unknown-domain warnings', () => {
  const { root, fakeHome, storeDir } = makeFixture();
  writeMemory(storeDir, 'no-domain.md', {
    name: 'no-domain-mem',
    description: 'no domain field',
    trigger_prompt: '/\\bfoo\\b/',
  });

  const r = run([`--cwd=${root}`, `--store=${storeDir}`, '--strict', '--no-color'], {
    home: fakeHome,
  });
  assert.equal(
    r.status,
    0,
    `clean store should exit 0 even with --strict; got ${r.status}. stdout=${r.stdout}\nstderr=${r.stderr}`
  );
  const combined = (r.stdout || '') + '\n' + (r.stderr || '');
  assert.doesNotMatch(
    combined,
    /unknown\s+domain/i,
    `no unknown-domain warning expected; got:\n${combined}`
  );
});

test('valid registered domains emit no warnings under --strict', () => {
  const { root, fakeHome, storeDir } = makeFixture();
  writeMemory(storeDir, 'good-root.md', {
    name: 'good-root',
    description: 'tagged with known root',
    domain: 'e2e',
  });
  writeMemory(storeDir, 'good-leaf.md', {
    name: 'good-leaf',
    description: 'tagged with known leaf',
    domain: 'git:plumbing-ops',
  });

  const r = run([`--cwd=${root}`, `--store=${storeDir}`, '--strict', '--no-color'], {
    home: fakeHome,
  });
  assert.equal(
    r.status,
    0,
    `all-valid domains should exit 0 with --strict; got ${r.status}. stdout=${r.stdout}\nstderr=${r.stderr}`
  );
});
