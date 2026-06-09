'use strict';

// RED phase — Task 2 (GH-513): integration test for `lib/domains.js`.
//
// Exercises the full filesystem lookup against:
//   - a real tmpdir-backed `~/.claude/synapsys/DOMAINS.md`
//   - a real bundled fallback path
// Verifies precedence and mtime cache across real reads (no mocks).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadDomainRegistry, _resetDomainCache } = require('../domains');

function mkTmp(prefix = 'synapsys-domains-int-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BUNDLED_BODY = `root: e2e
  leaf: local-execution
    signal_prompt: \\be2e\\b
    signal_pretool: \\bplaywright\\b
root: git
  leaf: plumbing-ops
    signal_prompt: \\bgit\\s+merge\\b
    signal_pretool: \\bgit\\s+rebase\\b
`;

const USER_BODY = `root: ticket-ops
  leaf: write
    signal_prompt: \\bticket\\b
    signal_pretool: \\bgh\\s+issue\\s+create\\b
`;

test('integration: bundled fallback wins when user file absent', () => {
  _resetDomainCache();
  const home = mkTmp();
  const bundledDir = mkTmp('synapsys-bundle-');
  const bundledPath = path.join(bundledDir, 'DOMAINS.md');
  fs.writeFileSync(bundledPath, BUNDLED_BODY);

  const reg = loadDomainRegistry({ home, bundledPath });
  assert.ok(reg.roots.has('e2e'));
  assert.ok(reg.roots.has('git'));
  assert.ok(!reg.roots.has('ticket-ops'));
});

test('integration: user file wins when both exist', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, USER_BODY);

  const bundledDir = mkTmp('synapsys-bundle-');
  const bundledPath = path.join(bundledDir, 'DOMAINS.md');
  fs.writeFileSync(bundledPath, BUNDLED_BODY);

  const reg = loadDomainRegistry({ home, bundledPath });
  assert.ok(reg.roots.has('ticket-ops'));
  assert.ok(!reg.roots.has('e2e'));
});

test('integration: mtime cache holds across two real reads, invalidates on rewrite', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, USER_BODY);

  const a = loadDomainRegistry({ home });
  const b = loadDomainRegistry({ home });
  assert.equal(a, b, 'cache hit returns same object');

  const future = new Date(Date.now() + 10000);
  fs.writeFileSync(userFile, USER_BODY + '\n# bump\n');
  fs.utimesSync(userFile, future, future);

  const c = loadDomainRegistry({ home });
  assert.notEqual(a, c, 'rewrite + mtime bump invalidates cache');
  assert.ok(c.roots.has('ticket-ops'));
});

test('integration: fail-open returns empty registry when both paths missing', () => {
  _resetDomainCache();
  const home = mkTmp();
  const bundledPath = path.join(mkTmp('synapsys-bundle-'), 'absent.md');
  const reg = loadDomainRegistry({ home, bundledPath });
  assert.equal(reg.roots.size, 0);
});
