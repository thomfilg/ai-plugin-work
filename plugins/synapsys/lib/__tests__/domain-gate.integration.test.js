'use strict';

// RED phase — Task 8 (GH-513) integration:
// Drive the synapsys hook end-to-end via child-process spawn. Confirms the
// hook classifies the prompt, loads/persists sticky-state, and gates
// `selectForEvent` via `opts.activeDomains` (R3, R4, R7, AC9).
//
// Scenario covered (verbatim title for task-next.js gate):
//   - Full hook flow — UserPromptSubmit injects only domain-matching memories

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');

function makeTmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-domain-gate-hook-'));
  const synapsysHome = path.join(home, '.claude', 'synapsys');
  fs.mkdirSync(path.join(synapsysHome, '.state'), { recursive: true });
  return { home, synapsysHome };
}

function makeStoreCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-domain-gate-hook-cwd-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'gh-513-task8' })
  );
  return { cwd, storeDir };
}

function writeRegistry(synapsysHome) {
  // Minimal DOMAINS.md that emits a `git` root for prompts containing
  // `git merge` and an `e2e` root for prompts containing `e2e test`.
  const body = [
    'root: git',
    '  leaf: plumbing-ops',
    '    signal_prompt: \\bgit\\s+merge\\b',
    '    signal_pretool: \\bgit\\s+rebase\\b',
    'root: e2e',
    '  leaf: local-execution',
    '    signal_prompt: \\be2e\\s+test\\b',
    '    signal_pretool: \\bplaywright\\b',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(synapsysHome, 'DOMAINS.md'), body);
}

function writeMemory(storeDir, name, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = `---\n${fm}\n---\n${body}\n`;
  fs.writeFileSync(path.join(storeDir, `${name}.md`), content);
}

function runHook({ event, payload, env }) {
  return spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env, SYNAPSYS_NO_SETUP_HINT: '1' },
  });
}

test('Full hook flow — UserPromptSubmit injects only domain-matching memories', () => {
  const { home, synapsysHome } = makeTmpHome();
  const { cwd, storeDir } = makeStoreCwd();

  writeRegistry(synapsysHome);

  // (a) git-tagged memory — fires only when `git` domain active
  writeMemory(
    storeDir,
    'git-tagged',
    {
      name: 'git-tagged',
      description: 'git-only',
      events: 'UserPromptSubmit',
      domain: 'git',
      trigger_prompt: '\\bdeploy\\b',
      inject: 'full',
    },
    'GIT_TAGGED_BODY'
  );

  // (b) e2e-tagged memory — fires only when `e2e` domain active
  writeMemory(
    storeDir,
    'e2e-tagged',
    {
      name: 'e2e-tagged',
      description: 'e2e-only',
      events: 'UserPromptSubmit',
      domain: 'e2e',
      trigger_prompt: '\\bdeploy\\b',
      inject: 'full',
    },
    'E2E_TAGGED_BODY'
  );

  // (c) universal memory — fires regardless of active set (backward compat)
  writeMemory(
    storeDir,
    'universal',
    {
      name: 'universal',
      description: 'no-domain',
      events: 'UserPromptSubmit',
      trigger_prompt: '\\bdeploy\\b',
      inject: 'full',
    },
    'UNIVERSAL_BODY'
  );

  const env = { HOME: home };

  // --- Pass 1: prompt activates only e2e signals ---
  // Expect: e2e-tagged + universal injected; git-tagged NOT injected.
  const res1 = runHook({
    event: 'UserPromptSubmit',
    payload: { cwd, prompt: 'please deploy after e2e test passes', session_id: 'sess-1' },
    env,
  });
  assert.equal(res1.status, 0, `hook nonzero: ${res1.stderr}`);
  const out1 = res1.stdout;

  assert.ok(out1.includes('E2E_TAGGED_BODY'), `expected e2e-tagged injected; got: ${out1}`);
  assert.ok(out1.includes('UNIVERSAL_BODY'), `expected universal injected; got: ${out1}`);
  assert.ok(
    !out1.includes('GIT_TAGGED_BODY'),
    `git-tagged should NOT be injected when only e2e active; got: ${out1}`
  );

  // --- Pass 2: prompt activates only git signals ---
  // Expect: git-tagged + universal injected; e2e-tagged NOT injected.
  const res2 = runHook({
    event: 'UserPromptSubmit',
    payload: { cwd, prompt: 'please deploy after git merge step', session_id: 'sess-2' },
    env,
  });
  assert.equal(res2.status, 0, `hook nonzero: ${res2.stderr}`);
  const out2 = res2.stdout;

  assert.ok(out2.includes('GIT_TAGGED_BODY'), `expected git-tagged injected; got: ${out2}`);
  assert.ok(out2.includes('UNIVERSAL_BODY'), `expected universal injected; got: ${out2}`);
  assert.ok(
    !out2.includes('E2E_TAGGED_BODY'),
    `e2e-tagged should NOT be injected when only git active; got: ${out2}`
  );

  // --- Side-effect: sticky-state file should exist after hook runs ---
  const statePath = path.join(synapsysHome, '.state', 'sticky-domains.json');
  assert.ok(
    fs.existsSync(statePath),
    `expected sticky-state persisted at ${statePath}`
  );
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(typeof persisted, 'object', 'sticky-state must be a JSON object');
});
