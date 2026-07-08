'use strict';

// RED phase — Task 2 (GH-513): `lib/domains.js` registry parser with mtime cache (fail-open).
//
// Unit tests cover:
//   - bundled fallback when user file is missing
//   - user-file precedence when present
//   - mtime cache hit on unchanged mtime
//   - fail-open on EACCES / malformed file / invalid regex (no throw, empty registry)
//   - safeRegex used to compile each pattern (invalid regex dropped, not fatal)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadDomainRegistry, _resetDomainCache } = require('../domains');

function mkTmp(prefix = 'synapsys-domains-unit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRegistry(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

const SAMPLE_REGISTRY = `# DOMAINS
root: e2e
  leaf: local-execution
    signal_prompt: \\be2e\\b
    signal_pretool: \\bplaywright\\b
  leaf: flake-triage
    signal_prompt: \\bflake\\b
    signal_pretool: \\bretry\\b
root: git
  leaf: plumbing-ops
    signal_prompt: \\bgit\\s+merge\\b
    signal_pretool: \\bgit\\s+rebase\\b
`;

test('loadDomainRegistry: parses user file when present', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  writeRegistry(userFile, SAMPLE_REGISTRY);

  const registry = loadDomainRegistry({ home });

  assert.ok(registry.roots instanceof Map, 'roots is a Map');
  assert.ok(registry.roots.has('e2e'), 'e2e root present');
  assert.ok(registry.roots.has('git'), 'git root present');

  const e2e = registry.roots.get('e2e');
  assert.ok(e2e.leaves instanceof Map);
  assert.ok(e2e.leaves.has('local-execution'));
  assert.ok(e2e.leaves.has('flake-triage'));

  const localExec = e2e.leaves.get('local-execution');
  assert.ok(Array.isArray(localExec.signal_prompt));
  assert.ok(Array.isArray(localExec.signal_pretool));
  assert.equal(localExec.signal_prompt.length, 1);
  assert.ok(localExec.signal_prompt[0] instanceof RegExp);
  assert.ok(localExec.signal_prompt[0].test('this is e2e here'));
  assert.ok(localExec.signal_pretool[0].test('use playwright now'));
});

test('loadDomainRegistry: falls back to bundled registry when user file is absent', () => {
  _resetDomainCache();
  const home = mkTmp(); // no DOMAINS.md created
  const bundledDir = mkTmp('synapsys-domains-bundle-');
  const bundledPath = path.join(bundledDir, 'DOMAINS.md');
  writeRegistry(bundledPath, SAMPLE_REGISTRY);

  const registry = loadDomainRegistry({ home, bundledPath });
  assert.ok(registry.roots.has('e2e'), 'bundled fallback loaded');
  assert.ok(registry.roots.has('git'));
});

test('loadDomainRegistry: user file takes precedence over bundled', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  const userOnly = `root: ticket-ops
  leaf: write
    signal_prompt: \\bticket\\b
    signal_pretool: \\bgh\\s+issue\\b
`;
  writeRegistry(userFile, userOnly);

  const bundledDir = mkTmp('synapsys-domains-bundle-');
  const bundledPath = path.join(bundledDir, 'DOMAINS.md');
  writeRegistry(bundledPath, SAMPLE_REGISTRY); // has e2e/git, not ticket-ops

  const registry = loadDomainRegistry({ home, bundledPath });
  assert.ok(registry.roots.has('ticket-ops'), 'user-file root present');
  assert.ok(!registry.roots.has('e2e'), 'bundled root NOT loaded when user file exists');
});

test('loadDomainRegistry: mtime cache hit returns identical object on unchanged file', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  writeRegistry(userFile, SAMPLE_REGISTRY);

  const first = loadDomainRegistry({ home });
  const second = loadDomainRegistry({ home });
  assert.equal(first, second, 'cached registry returned by reference');
});

test('loadDomainRegistry: cache invalidates when mtime changes', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  writeRegistry(userFile, SAMPLE_REGISTRY);

  const first = loadDomainRegistry({ home });

  // Bump mtime by writing again with a future timestamp
  const future = new Date(Date.now() + 5000);
  fs.writeFileSync(userFile, SAMPLE_REGISTRY + '\n# touched\n');
  fs.utimesSync(userFile, future, future);

  const second = loadDomainRegistry({ home });
  assert.notEqual(first, second, 'new registry returned after mtime change');
});

test('loadDomainRegistry: fail-open on malformed body returns empty registry', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  // Garbage that has no recognizable root/leaf lines
  writeRegistry(userFile, '!!!\n@@@ not a registry\n');

  let registry;
  assert.doesNotThrow(() => {
    registry = loadDomainRegistry({ home });
  });
  assert.ok(registry.roots instanceof Map);
  assert.equal(registry.roots.size, 0);
});

test('loadDomainRegistry: fail-open when no file anywhere', () => {
  _resetDomainCache();
  const home = mkTmp();
  const bundledPath = path.join(mkTmp('synapsys-domains-bundle-'), 'does-not-exist.md');

  let registry;
  assert.doesNotThrow(() => {
    registry = loadDomainRegistry({ home, bundledPath });
  });
  assert.ok(registry.roots instanceof Map);
  assert.equal(registry.roots.size, 0);
});

test('loadDomainRegistry: invalid regex is dropped, not fatal', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  const body = `root: e2e
  leaf: local-execution
    signal_prompt: [unclosed
    signal_prompt: \\bvalid\\b
    signal_pretool: (also[broken
`;
  writeRegistry(userFile, body);

  const registry = loadDomainRegistry({ home });
  const leaf = registry.roots.get('e2e').leaves.get('local-execution');
  // The invalid one is dropped; the valid one survives.
  assert.equal(leaf.signal_prompt.length, 1);
  assert.ok(leaf.signal_prompt[0].test('this is valid'));
  // pretool was only an invalid pattern → empty array, not undefined
  assert.equal(leaf.signal_pretool.length, 0);
});

test('loadDomainRegistry: fail-open on EACCES (unreadable file)', () => {
  _resetDomainCache();
  const home = mkTmp();
  const userFile = path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
  writeRegistry(userFile, SAMPLE_REGISTRY);
  try {
    fs.chmodSync(userFile, 0o000);
  } catch {
    // best-effort; if chmod is unsupported skip the EACCES branch
    return;
  }
  try {
    let registry;
    assert.doesNotThrow(() => {
      registry = loadDomainRegistry({ home });
    });
    assert.ok(registry.roots instanceof Map);
  } finally {
    try {
      fs.chmodSync(userFile, 0o644);
    } catch {}
  }
});
