'use strict';

/**
 * Tests for scripts/ghostwriter-scan.js — the layer that does not care how a
 * line got into the change.
 *
 * These run against REAL repositories and real `git diff` output. The whole
 * question is whether what git reports as added reaches the rules, and a
 * stubbed diff would answer a question nobody asked.
 *
 * Run with: node --test plugins/ghostwriter/scripts/__tests__/ghostwriter-scan.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCANNER = path.resolve(__dirname, '..', 'ghostwriter-scan.js');
const TOOL = ['Cl', 'aude'].join('');
const FOOTER = `// Generated with ${TOOL} Code`;

let repo;

function git(...args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15000 });
}

function scan(...args) {
  const env = { ...process.env };
  delete env.GHOSTWRITER_ALLOW_ATTRIBUTION;
  const result = spawnSync(process.execPath, [SCANNER, '--repo', repo, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function write(file, text) {
  fs.writeFileSync(path.join(repo, file), text);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-scan-'));
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' });
  git('config', 'user.name', 'Ada Lovelace');
  git('config', 'user.email', 'ada@example.com');
  write('README.md', '# Project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: init');
});

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('ghostwriter-scan — staged changes', () => {
  it('reports a footer added to a source file', () => {
    write('src.js', `${FOOTER}\nconst a = 1;\n`);
    git('add', '-A');
    const result = scan('--staged');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /aiGeneratedPhrase/);
    assert.match(result.stderr, /src\.js/);
  });

  it('passes a clean change', () => {
    write('src.js', 'const a = 1;\n');
    git('add', '-A');
    assert.equal(scan('--staged').code, 0);
  });

  it('passes a change that REMOVES a footer', () => {
    // Deleting an attribution shows the offending line with a `-`. Refusing
    // that would block the cleanup this plugin exists to encourage.
    write('src.js', `${FOOTER}\nconst a = 1;\n`);
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: seed');
    write('src.js', 'const a = 1;\n');
    git('add', '-A');
    assert.equal(scan('--staged').code, 0, scan('--staged').stderr);
  });

  it('ignores an unstaged edit — this is what the COMMIT would add', () => {
    write('src.js', `${FOOTER}\n`);
    assert.equal(scan('--staged').code, 0);
  });

  it('honours .ghostwriterignore', () => {
    write('.ghostwriterignore', 'vendor/**\n');
    fs.mkdirSync(path.join(repo, 'vendor'), { recursive: true });
    write('vendor/lib.js', `${FOOTER}\n`);
    git('add', '-A');
    assert.equal(scan('--staged').code, 0);
  });
});

describe('ghostwriter-scan — a branch against its base', () => {
  it('reports a footer committed anywhere in the branch', () => {
    git('checkout', '-q', '-b', 'feature');
    write('src.js', `${FOOTER}\n`);
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'feat: add src');
    write('other.js', 'const b = 2;\n');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'feat: add other');

    const result = scan('--diff', 'main');
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /src\.js/);
  });

  it('passes a clean branch', () => {
    git('checkout', '-q', '-b', 'feature');
    write('src.js', 'const a = 1;\n');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'feat: add src');
    assert.equal(scan('--diff', 'main').code, 0);
  });
});

describe('ghostwriter-scan — whole files and usage', () => {
  it('reads named files as they stand', () => {
    write('src.js', `${FOOTER}\n`);
    assert.equal(scan('--files', 'src.js').code, 1);
    write('src.js', 'const a = 1;\n');
    assert.equal(scan('--files', 'src.js').code, 0);
  });

  it('reports a usage error rather than a verdict it cannot support', () => {
    assert.equal(scan().code, 2, 'no mode');
    assert.equal(scan('--bogus').code, 2);
    assert.equal(scan('--diff').code, 2, '--diff with no base');
    assert.equal(scan('--files').code, 2, '--files with no path');
    assert.equal(scan('--diff', 'no-such-revision').code, 2, 'unreadable range');
  });

  it('passes everything when the operator set the override', () => {
    write('src.js', `${FOOTER}\n`);
    git('add', '-A');
    const result = spawnSync(process.execPath, [SCANNER, '--repo', repo, '--staged'], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, GHOSTWRITER_ALLOW_ATTRIBUTION: '1' },
    });
    assert.equal(result.status, 0);
  });
});
