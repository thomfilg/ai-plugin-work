// Behavioral tests for the cross-project "shared" memory tier.
//
// The shared store lives at `~/.claude/synapsys-shared/` and must be
// discovered for EVERY project — regardless of cwd or project name. These
// tests pin HOME to a temp dir (Node's os.homedir() honours $HOME on POSIX)
// so discovery resolves into a fixture instead of the real home directory.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/synapsys/).
// Manual: node --test plugins/synapsys/lib/__tests__/shared-store.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { discoverStores, listMemoriesFromStore, SHARED_FOLDER } = require(
  path.resolve(__dirname, '..', 'memory-store')
);
const { selectForEvent } = require(path.resolve(__dirname, '..', 'matcher'));

// Skip when the platform doesn't resolve os.homedir() from $HOME (non-POSIX),
// since the fixture relies on overriding it.
const HOME_DRIVEN = process.platform !== 'win32';

let home;
let originalHome;
let sharedDir;
// Two unrelated project cwds — the shared store must surface for both.
let projectA;
let projectB;

before(() => {
  originalHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-shared-'));
  process.env.HOME = home;

  sharedDir = path.join(home, '.claude', SHARED_FOLDER);
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(
    path.join(sharedDir, '.synapsys.json'),
    JSON.stringify({ kind: 'shared', schemaVersion: 1 })
  );
  fs.writeFileSync(
    path.join(sharedDir, 'no-force-push.md'),
    [
      '---',
      'name: no-force-push',
      'description: never force-push to a shared branch',
      'events: UserPromptSubmit,PreToolUse',
      'trigger_prompt: \\bforce[- ]?push\\b',
      'trigger_pretool: Bash:git\\s+push\\s+--force',
      'inject: full',
      '---',
      'Never force-push to main or shared branches.',
    ].join('\n')
  );

  projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-projA-'));
  projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-projB-'));
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const d of [home, projectA, projectB]) {
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('shared store discovery', { skip: !HOME_DRIVEN }, () => {
  it('is discovered from one project', () => {
    const stores = discoverStores(projectA);
    const shared = stores.find((s) => s.kind === 'shared');
    assert.ok(shared, 'shared store should be discovered');
    assert.equal(path.resolve(shared.dir), path.resolve(sharedDir));
  });

  it('is discovered from an unrelated second project (cross-project)', () => {
    const stores = discoverStores(projectB);
    assert.ok(
      stores.some((s) => s.kind === 'shared'),
      'shared store should surface for every project'
    );
  });
});

describe('shared store does not collide with the per-project namespace', { skip: !HOME_DRIVEN }, () => {
  it('keeps global and shared distinct even for a project named like the shared folder', () => {
    // A project whose basename matches SHARED_FOLDER must NOT shadow the shared
    // store: global lives under `synapsys/<name>/`, shared is a sibling of
    // `synapsys/`, so the two paths can never resolve to the same directory.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-collide-'));
    const projectCwd = path.join(parent, SHARED_FOLDER);
    fs.mkdirSync(projectCwd, { recursive: true });

    const globalDir = path.join(home, '.claude', 'synapsys', SHARED_FOLDER);
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, '.synapsys.json'),
      JSON.stringify({ kind: 'global', projectName: SHARED_FOLDER, schemaVersion: 1 })
    );

    const stores = discoverStores(projectCwd);
    const shared = stores.find((s) => s.kind === 'shared');
    const global = stores.find((s) => s.kind === 'global');
    assert.ok(shared, 'shared store should still be discovered');
    assert.ok(global, 'global store should still be discovered');
    assert.notEqual(path.resolve(shared.dir), path.resolve(global.dir));

    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });
});

describe('shared store injection', { skip: !HOME_DRIVEN }, () => {
  function matchedNames(cwd, event, payload) {
    const memories = discoverStores(cwd).flatMap(listMemoriesFromStore);
    return selectForEvent(memories, event, payload).map((m) => m.name);
  }

  it('injects a matching memory on UserPromptSubmit from any project', () => {
    assert.deepEqual(matchedNames(projectA, 'UserPromptSubmit', { prompt: 'should I force-push?' }), [
      'no-force-push',
    ]);
  });

  it('injects a matching memory on PreToolUse from any project', () => {
    const names = matchedNames(projectB, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
    });
    assert.deepEqual(names, ['no-force-push']);
  });

  it('does NOT inject for a non-matching prompt (control)', () => {
    assert.deepEqual(matchedNames(projectA, 'UserPromptSubmit', { prompt: 'xyzzy plugh' }), []);
  });
});
