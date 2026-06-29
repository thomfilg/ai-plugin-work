// Tests for the mcp-pg-broker CLI generalization: it now accepts trailing args
// (forwarded to the wrapper) while the allow-list still gates argv[1]. These
// exercise the PRE-privilege-drop logic (argc bounds + allow-list), which runs
// before the root-only initgroups/setresuid step — so they work without root.
// The full forward-and-exec chain (post-drop) is covered by the manual e2e in
// the PR description.
//
// Discovered by plugins/work/scripts/run-tests.sh.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.resolve(__dirname, '..', '..', 'scripts', 'mcp-pg-broker.c');
const HAVE_GCC = spawnSync('gcc', ['--version']).status === 0;

let bin;

before(() => {
  if (!HAVE_GCC) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-cli-'));
  bin = path.join(dir, 'broker');
  // Test build skips the root-owned-config check so we can use a tmp broker.conf.
  const b = spawnSync('gcc', ['-DBROKER_TEST_SKIP_OWNER_CHECK', '-O2', '-o', bin, SRC], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  // broker.conf must sit NEXT TO the binary (resolve_conf_path uses /proc/self/exe).
  fs.writeFileSync(
    path.join(dir, 'broker.conf'),
    [
      'NODE_BIN=/bin/echo',
      `WRAPPER=${path.join(dir, 'wrap.js')}`,
      `RUN_USER=${os.userInfo().username}`,
      'ALLOWED_CSV=alpha,beta',
    ].join('\n') + '\n',
  );
});

const broker = (args) => spawnSync(bin, args, { encoding: 'utf8' });

describe('mcp-pg-broker CLI arg forwarding (gating)', () => {
  it('requires a name (argc < 2 -> exit 2)', { skip: !HAVE_GCC }, () => {
    const res = broker([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage/);
  });

  it('rejects a non-allow-listed name', { skip: !HAVE_GCC }, () => {
    const res = broker(['gamma']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /not allowed/);
  });

  it('rejects a non-allow-listed name even WITH trailing args', { skip: !HAVE_GCC }, () => {
    const res = broker(['gamma', '--task=x', 'ATTEMPTS=2']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /not allowed/);
  });

  it('lets an allow-listed name WITH trailing args past the gate', { skip: !HAVE_GCC }, () => {
    // Past the allow-list it proceeds to the privilege drop: non-root fails at
    // initgroups (exit 1); root execs /bin/echo (exit 0). Either way it is NOT
    // the exit-2 "not allowed" rejection — proving extra args don't trip the gate.
    const res = broker(['alpha', '--task=x', 'ATTEMPTS=2']);
    assert.notEqual(res.status, 2);
    assert.doesNotMatch(res.stderr || '', /not allowed/);
  });

  it('rejects too many arguments (argc > 256)', { skip: !HAVE_GCC }, () => {
    const many = Array.from({ length: 300 }, (_, i) => `a${i}`);
    const res = broker(['alpha', ...many]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /too many/);
  });
});
