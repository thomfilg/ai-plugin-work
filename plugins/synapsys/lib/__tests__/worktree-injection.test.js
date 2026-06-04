// Behavioral tests for Synapsys worktree-level memory injection.
//
// These assert the property the user actually cares about: from a session
// running INSIDE a worktree, a memory stored one level up in the shared
// `<base>/.claude/synapsys` store is discovered AND injected for a matching
// event — and is NOT injected for a non-matching one.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/synapsys/).
// Manual: node --test plugins/synapsys/lib/__tests__/worktree-injection.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { discoverStores, listMemoriesFromStore, parseFrontmatter } = require(
  path.resolve(__dirname, '..', 'memory-store')
);
const { selectForEvent } = require(path.resolve(__dirname, '..', 'matcher'));

// ─── Fixture: a worktree base with a shared store one level up ────────────────
//
//   <base>/.claude/synapsys/.synapsys.json   ← store marker
//   <base>/.claude/synapsys/ci.md            ← memory
//   <base>/worktree-echo-1/                   ← session cwd (the "worktree")

let base;
let worktreeCwd;
let storeDir;

function writeMemory(dir, file, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, file), `---\n${fm}\n---\n${body}`);
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-wt-'));
  storeDir = path.join(base, '.claude', 'synapsys');
  worktreeCwd = path.join(base, 'worktree-echo-1');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(worktreeCwd, { recursive: true });

  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'worktree', projectName: 'some-other-worktree', schemaVersion: 1 })
  );

  writeMemory(
    storeDir,
    'ci.md',
    {
      name: 'never-rerun-ci',
      description: 'never rerun CI',
      events: 'UserPromptSubmit,PreToolUse',
      trigger_prompt: '\\b(ci|re-?run)\\b',
      trigger_pretool: 'Bash:gh\\s+run',
      inject: 'full',
    },
    'Fix CI locally; never gh run rerun.'
  );
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('worktree store discovery', () => {
  it('finds the shared store one level up from the worktree cwd', () => {
    const stores = discoverStores(worktreeCwd);
    const wt = stores.find((s) => s.kind === 'worktree');
    assert.ok(wt, 'worktree store should be discovered');
    assert.equal(path.resolve(wt.dir), path.resolve(storeDir));
  });

  it('discovers stores by path, NOT by the marker projectName', () => {
    // Marker is keyed to a different worktree name; discovery must still find it.
    const stores = discoverStores(worktreeCwd);
    assert.ok(stores.some((s) => s.kind === 'worktree'));
  });
});

describe('worktree-level injection', () => {
  function matchedNames(event, payload) {
    const memories = discoverStores(worktreeCwd).flatMap(listMemoriesFromStore);
    return selectForEvent(memories, event, payload).map((m) => m.name);
  }

  it('injects a matching memory on UserPromptSubmit', () => {
    assert.deepEqual(matchedNames('UserPromptSubmit', { prompt: 'please re-run ci' }), [
      'never-rerun-ci',
    ]);
  });

  it('injects a matching memory on PreToolUse', () => {
    const names = matchedNames('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'gh run rerun 123' },
    });
    assert.deepEqual(names, ['never-rerun-ci']);
  });

  it('does NOT inject for a non-matching prompt (control)', () => {
    assert.deepEqual(matchedNames('UserPromptSubmit', { prompt: 'xyzzy plugh' }), []);
  });
});

// ─── Multi-level discovery: walk up to the nearest ancestor store ─────────────
// A session may run from a sub-directory of the worktree (e.g. packages/app),
// which is more than one level below the shared `.claude` base. Discovery must
// still resolve the store by walking up the tree.
describe('multi-level discovery', () => {
  it('finds the shared store from a deeply-nested sub-directory', () => {
    const nested = path.join(worktreeCwd, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    const stores = discoverStores(nested);
    const wt = stores.find((s) => s.kind === 'worktree');
    assert.ok(wt, 'store should be discovered from a nested sub-directory');
    assert.equal(path.resolve(wt.dir), path.resolve(storeDir));
  });

  it('injects a matching memory from a nested sub-directory', () => {
    const nested = path.join(worktreeCwd, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    const memories = discoverStores(nested).flatMap(listMemoriesFromStore);
    const names = selectForEvent(memories, 'UserPromptSubmit', { prompt: 're-run ci' }).map(
      (m) => m.name
    );
    assert.deepEqual(names, ['never-rerun-ci']);
  });
});

// ─── Regression: parser bugs that silently disable memories ───────────────────
describe('frontmatter parser (regression guard)', () => {
  it('parses a memory that has frontmatter but no body', () => {
    const { meta } = parseFrontmatter('---\nname: body-less\ntrigger_prompt: \\bfoo\\b\n---');
    assert.equal(meta.name, 'body-less');
    assert.equal(meta.trigger_prompt, '\\bfoo\\b');
  });

  it('keeps a bracketed regex class as a string, not an array', () => {
    const { meta } = parseFrontmatter('---\nname: re\ntrigger_prompt: [a-z]+\n---\nbody');
    assert.equal(meta.trigger_prompt, '[a-z]+');
    assert.equal(Array.isArray(meta.trigger_prompt), false);
  });
});
