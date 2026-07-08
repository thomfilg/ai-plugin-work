/**
 * Tests for lib/hooks/policies/scope-protection.js (Gate D policy).
 *
 * Run: node --test scripts/workflows/lib/hooks/policies/__tests__/scope-protection.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { decideEdit, globToRegex, relativizePath, findMatch } = require('../scope-protection');

describe('globToRegex', () => {
  it('matches exact path', () => {
    const re = globToRegex('lib/x.ts');
    assert.equal(re.test('lib/x.ts'), true);
    assert.equal(re.test('lib/y.ts'), false);
    assert.equal(re.test('lib/x.tsx'), false);
  });

  it('** matches any number of segments', () => {
    const re = globToRegex('lib/**');
    assert.equal(re.test('lib/a.ts'), true);
    assert.equal(re.test('lib/a/b/c.ts'), true);
    assert.equal(re.test('other/x.ts'), false);
  });

  it('* matches within a single segment', () => {
    const re = globToRegex('lib/*.ts');
    assert.equal(re.test('lib/x.ts'), true);
    assert.equal(re.test('lib/sub/x.ts'), false);
  });

  it('? matches a single non-slash char', () => {
    const re = globToRegex('lib/?.ts');
    assert.equal(re.test('lib/x.ts'), true);
    assert.equal(re.test('lib/xy.ts'), false);
    assert.equal(re.test('lib//.ts'), false);
  });

  it('**/* combinator', () => {
    const re = globToRegex('**/*.test.js');
    assert.equal(re.test('lib/x.test.js'), true);
    assert.equal(re.test('deep/nest/x.test.js'), true);
    assert.equal(re.test('lib/x.js'), false);
  });

  it('escapes regex metachars', () => {
    const re = globToRegex('lib/foo+bar.ts');
    assert.equal(re.test('lib/foo+bar.ts'), true);
    assert.equal(re.test('lib/foobar.ts'), false);
  });

  it('strips trailing slash', () => {
    const re = globToRegex('lib/sub/');
    assert.equal(re.test('lib/sub'), true);
  });
});

describe('relativizePath', () => {
  it('returns posix relative path when inside workDir', () => {
    assert.equal(relativizePath('/repo/lib/x.ts', '/repo'), 'lib/x.ts');
  });

  it('returns null for paths outside workDir', () => {
    assert.equal(relativizePath('/elsewhere/x.ts', '/repo'), null);
    assert.equal(relativizePath('/tmp/abc', '/repo'), null);
  });

  it('accepts relative input', () => {
    assert.equal(relativizePath('lib/x.ts', '/repo'), 'lib/x.ts');
  });

  it('returns null for missing inputs', () => {
    assert.equal(relativizePath('', '/repo'), null);
    assert.equal(relativizePath('/repo/lib/x.ts', ''), null);
  });
});

describe('findMatch', () => {
  it('returns first matching pattern', () => {
    assert.equal(findMatch('lib/x.ts', ['lib/*.ts']), 'lib/*.ts');
  });

  it('returns null when no match', () => {
    assert.equal(findMatch('lib/x.ts', ['other/*.ts']), null);
  });

  it('skips invalid entries', () => {
    assert.equal(findMatch('lib/x.ts', [null, undefined, '', 'lib/*.ts']), 'lib/*.ts');
  });

  it('returns null for empty patterns', () => {
    assert.equal(findMatch('lib/x.ts', []), null);
    assert.equal(findMatch('lib/x.ts', null), null);
  });
});

describe('decideEdit', () => {
  const base = {
    workDir: '/repo',
    filesInScope: ['lib/components/**', 'tests/**/*.test.js'],
    filesOutOfScope: ['app/api/trpc/routers/**', 'lib/validation/**'],
    activeTask: 'Task 1',
  };

  it('allows file inside Files in scope', () => {
    const d = decideEdit({ ...base, filePath: '/repo/lib/components/foo.ts' });
    assert.equal(d.blocked, false);
    assert.equal(d.category, 'allow');
    assert.equal(d.match, 'lib/components/**');
  });

  it('blocks file matching Files explicitly out of scope (sibling-owned)', () => {
    const d = decideEdit({ ...base, filePath: '/repo/app/api/trpc/routers/views.ts' });
    assert.equal(d.blocked, true);
    assert.equal(d.category, 'sibling-owned');
    assert.match(d.reason, /sibling-owned|out of scope/i);
    assert.match(d.reason, /views\.ts/);
  });

  it('blocks file outside both lists (out-of-scope)', () => {
    const d = decideEdit({ ...base, filePath: '/repo/scripts/random.js' });
    assert.equal(d.blocked, true);
    assert.equal(d.category, 'out-of-scope');
    assert.match(d.reason, /outside the active task/i);
  });

  it('passes through paths outside the worktree', () => {
    const d = decideEdit({ ...base, filePath: '/tmp/x.ts' });
    assert.equal(d.blocked, false);
    assert.equal(d.category, 'outside-worktree');
  });

  it('precedence: out-of-scope wins over in-scope', () => {
    const d = decideEdit({
      ...base,
      filesInScope: ['lib/**'],
      filesOutOfScope: ['lib/validation/**'],
      filePath: '/repo/lib/validation/zod.ts',
    });
    assert.equal(d.blocked, true);
    assert.equal(d.category, 'sibling-owned');
  });

  it('empty in-scope blocks everything (defensive)', () => {
    const d = decideEdit({
      ...base,
      filesInScope: [],
      filesOutOfScope: [],
      filePath: '/repo/lib/x.ts',
    });
    assert.equal(d.blocked, true);
    assert.equal(d.category, 'out-of-scope');
  });
});

// ─── GH-392 follow-up: traversal & symlink-escape hardening ──────────────────

describe('relativizePath — path traversal hardening', () => {
  const fs = require('node:fs');
  const os = require('node:os');

  it('rejects ../ traversal in relative input', () => {
    assert.equal(relativizePath('../../etc/passwd', '/repo'), null);
    assert.equal(relativizePath('lib/../../etc/passwd', '/repo'), null);
  });

  it('rejects absolute paths outside workDir', () => {
    assert.equal(relativizePath('/etc/passwd', '/repo'), null);
  });

  it('rejects symlink that escapes workDir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-symlink-'));
    try {
      const work = path.join(tmp, 'work');
      const outside = path.join(tmp, 'outside.ts');
      fs.mkdirSync(work);
      fs.mkdirSync(path.join(work, 'src'));
      fs.writeFileSync(outside, 'leak');
      const linkPath = path.join(work, 'src', 'legit.ts');
      try {
        fs.symlinkSync(outside, linkPath);
      } catch (e) {
        // Some FS / privilege configs forbid symlinks; skip silently.
        if (e.code === 'EPERM' || e.code === 'ENOSYS') return;
        throw e;
      }
      // Without symlink-escape check this would return 'src/legit.ts' (allowed).
      assert.equal(relativizePath(linkPath, work), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows ordinary symlink that stays inside workDir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-symlink-ok-'));
    try {
      const work = path.join(tmp, 'work');
      fs.mkdirSync(work);
      fs.mkdirSync(path.join(work, 'src'));
      const realFile = path.join(work, 'src', 'real.ts');
      fs.writeFileSync(realFile, '');
      const linkPath = path.join(work, 'src', 'alias.ts');
      try {
        fs.symlinkSync(realFile, linkPath);
      } catch (e) {
        if (e.code === 'EPERM' || e.code === 'ENOSYS') return;
        throw e;
      }
      assert.equal(relativizePath(linkPath, work), 'src/alias.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('findMatch — traversal hardening', () => {
  it('refuses to match a candidate containing ..', () => {
    assert.equal(findMatch('../etc/passwd', ['**/*']), null);
    assert.equal(findMatch('lib/../etc/passwd', ['**/*']), null);
  });

  it('refuses to match against an absolute pattern', () => {
    assert.equal(findMatch('etc/passwd', ['/etc/passwd']), null);
  });

  it('refuses to match against a pattern with ..', () => {
    assert.equal(findMatch('etc/passwd', ['../../etc/passwd']), null);
  });

  it('refuses to match an absolute candidate', () => {
    assert.equal(findMatch('/repo/lib/x.ts', ['lib/x.ts']), null);
  });
});
