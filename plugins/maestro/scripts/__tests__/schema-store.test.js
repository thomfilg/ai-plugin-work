// schema-store.js + maestro-schema.js — tiered, marker-gated schema persistence.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'maestro-schema.js');
const LIB = path.resolve(__dirname, '..', '..', 'lib', 'schema-store.js');

// Pin discovery to cwd-rooted local/worktree tiers so a developer's real
// ~/.claude/maestro{,-shared} stores never leak into these assertions.
function runCli(cwd, args) {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MAESTRO_DISABLE_HOME_STORES: '1' },
  });
}

function freshLib() {
  delete require.cache[LIB];
  process.env.MAESTRO_DISABLE_HOME_STORES = '1';
  return require(LIB);
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-schema-'));
}

test('serializeFrontmatter ↔ parseFrontmatter round-trips scalars + oracle', () => {
  const lib = freshLib();
  const meta = {
    name: 'opera1',
    pool_size: 1,
    command: '/qc-work',
    stop_oracle: 'node x.js "$TICKET" --json | jq -e \'.action=="complete"\'',
    enabled: true,
  };
  const doc = lib.serializeFrontmatter(meta, 'body text');
  const { meta: out, body } = lib.parseFrontmatter(doc);
  assert.equal(out.name, 'opera1');
  assert.equal(out.pool_size, 1); // coerced back to number
  assert.equal(out.command, '/qc-work');
  assert.equal(out.stop_oracle, meta.stop_oracle); // colons/quotes survive
  assert.equal(out.enabled, true);
  assert.match(body, /body text/);
});

test('save refuses when the tier has no marker (init required first)', () => {
  const dir = tmp();
  const r = runCli(dir, ['save', 'opera1', '--tier=local', '--pool=1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run: maestro-schema\.js init local/);
});

test('init writes marker; save then round-trips through list/show', () => {
  const dir = tmp();
  const lib = freshLib();

  const init = runCli(dir, ['init', 'local']);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'maestro', lib.MARKER)));

  const save = runCli(dir, [
    'save',
    'opera1',
    '--tier=local',
    '--pool=1',
    '--command=/qc-work',
    '--stop-source=when /follow-up skill says that it passed',
    "--stop-oracle=node f.js \"$TICKET\" --json | jq -e '.action==\"complete\"'",
  ]);
  assert.equal(save.status, 0, save.stderr);

  const show = runCli(dir, ['show', 'opera1']);
  assert.equal(show.status, 0, show.stderr);
  const schema = JSON.parse(show.stdout);
  assert.equal(schema.name, 'opera1');
  assert.equal(schema.poolSize, 1);
  assert.equal(schema.command, '/qc-work');
  assert.equal(schema.store, 'local');
  assert.match(schema.stopOracle, /jq -e/);

  const list = JSON.parse(runCli(dir, ['list']).stdout);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'opera1');
});

test('save rejects non-kebab names and refuses overwrite without --force', () => {
  const dir = tmp();
  runCli(dir, ['init', 'local']);

  const bad = runCli(dir, ['save', 'Opera_1', '--tier=local']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /kebab-case/);

  assert.equal(runCli(dir, ['save', 'opera1', '--tier=local', '--pool=1']).status, 0);
  const dup = runCli(dir, ['save', 'opera1', '--tier=local', '--pool=2']);
  assert.notEqual(dup.status, 0);
  assert.match(dup.stderr, /already exists/);
  assert.equal(runCli(dir, ['save', 'opera1', '--tier=local', '--pool=2', '--force']).status, 0);
});

test('INDEX.md is skipped by discovery; delete removes the schema', () => {
  const dir = tmp();
  runCli(dir, ['init', 'local']); // writes INDEX.md
  runCli(dir, ['save', 'opera1', '--tier=local', '--pool=1']);

  const list = JSON.parse(runCli(dir, ['list']).stdout);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'opera1');

  const del = runCli(dir, ['delete', 'opera1']);
  assert.equal(del.status, 0, del.stderr);
  assert.equal(JSON.parse(runCli(dir, ['list']).stdout).length, 0);
});

test('discoverStores returns only marked dirs, local before worktree', () => {
  const lib = freshLib();
  const base = tmp();
  const wt = path.join(base, 'wt');
  fs.mkdirSync(wt, { recursive: true });

  // marker at base/.claude/maestro (ancestor → worktree tier for cwd=wt)
  runCli(base, ['init', 'local']);
  // marker at wt/.claude/maestro (local tier for cwd=wt)
  runCli(wt, ['init', 'local']);

  const stores = lib.discoverStores(wt);
  assert.deepEqual(
    stores.map((s) => s.kind),
    ['local', 'worktree']
  );
});
