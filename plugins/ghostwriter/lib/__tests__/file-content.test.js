/**
 * Unit tests for lib/file-content.js and lib/ignore.js — attribution inside
 * the files a change carries.
 *
 * The distinction under test is where a line LIVES, not what it says. The same
 * sentence is a signature in a source comment, a quoted example in a document,
 * and ordinary data in an object literal — and a rule set that cannot tell
 * those apart is one an operator turns off within a week.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/file-content.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inspectFileWrites,
  checkFileText,
  patchAdditions,
  unifiedAdditions,
  writeFiles,
  isProseFile,
} = require('../file-content');
const { isIgnored, resetIgnoreCache } = require('../ignore');

const TOOL = ['Cl', 'aude'].join('');
const BOT = ['cur', 'sor'].join('');

describe('checkFileText — source is read strictly', () => {
  it('blocks a generated-with footer in a code comment', () => {
    const hit = checkFileText(
      'src/index.js',
      `// Generated with ${TOOL} Code\nmodule.exports = 1;`
    );
    assert.equal(hit.rule, 'aiGeneratedPhrase');
    assert.equal(hit.where, 'src/index.js');
  });

  it('blocks a trailer wearing the local comment syntax', () => {
    // A trailer anchored to column zero misses every one of these, and a file
    // is exactly where a trailer arrives with a comment marker in front of it.
    for (const line of [
      `// Signed-off-by: ${TOOL} <a@b>`,
      `# Authored-by: ${TOOL}`,
      ` * Co-Authored-By: ${TOOL} <a@b>`,
    ]) {
      const hit = checkFileText('src/a.js', `const x = 1;\n${line}\n`);
      assert.ok(hit, `expected a finding for ${JSON.stringify(line)}`);
      assert.equal(hit.rule, 'aiCoAuthorTrailer');
    }
  });

  it('allows a bare product mention in ordinary code', () => {
    assert.equal(checkFileText('src/a.js', `// ${TOOL} adapter: see docs\nconst a = 1;`), null);
  });

  it('allows `author:` as an object key naming a bot', () => {
    // `author:` is a trailer key in a commit message and an ordinary property
    // everywhere else. A fixture describing a review left by a bot is data
    // about who reviewed something, not a commit signed by it.
    assert.equal(checkFileText('t/fixture.js', `const review = { author: '${BOT}[bot]' };`), null);
  });

  it('still reads `author:` as a trailer in a commit message', () => {
    // The tier only relaxes for FILE content — the message path is untouched.
    const { checkText } = require('../attribution');
    assert.equal(checkText(`feat: x\n\nAuthor: ${TOOL} <a@b>`).rule, 'aiCoAuthorTrailer');
  });
});

describe('checkFileText — documentation is read as prose', () => {
  it('allows a document quoting the trailer it documents', () => {
    const doc = [
      '# Policy',
      '',
      'We reject the trailer:',
      '',
      '```',
      `Co-Authored-By: ${TOOL}`,
      '```',
      '',
    ].join('\n');
    assert.equal(checkFileText('docs/policy.md', doc), null);
  });

  it('blocks a footer that signs the document itself', () => {
    // A real footer never sits in a fence.
    const doc = `# Notes\n\nSome content.\n\n---\nGenerated with ${TOOL} Code\n`;
    assert.equal(checkFileText('docs/notes.md', doc).rule, 'aiGeneratedPhrase');
  });

  it('does not read an authorship claim across a sentence boundary', () => {
    // "…(created by WP-02). <Tool> payloads…" is a note about a work package
    // followed by a note about a runtime. Joining them credits a tool the text
    // never names as an author.
    const doc = `- Fixtures live under runtime/ (created by WP-02). ${TOOL} payloads differ.\n`;
    assert.equal(checkFileText('docs/plan.md', doc), null);
  });

  it('reads an unknown extension strictly', () => {
    assert.equal(isProseFile('a.md'), true);
    assert.equal(isProseFile('a.js'), false);
    assert.equal(isProseFile(''), false);
  });
});

describe('writeFiles — what each write tool would author', () => {
  it('pairs a Write with its target path', () => {
    assert.deepEqual(writeFiles('Write', { file_path: 'a.js', content: 'x' }), [
      { path: 'a.js', text: 'x' },
    ]);
  });

  it('reads every replacement of a MultiEdit', () => {
    const files = writeFiles('MultiEdit', {
      file_path: 'a.js',
      edits: [{ new_string: 'one' }, { new_string: 'two' }],
    });
    assert.deepEqual(
      files.map((f) => f.text),
      ['one', 'two']
    );
  });

  it('returns nothing for a tool that writes no file', () => {
    assert.deepEqual(writeFiles('Read', { file_path: 'a.js' }), []);
    assert.deepEqual(writeFiles('Bash', { command: 'ls' }), []);
  });

  it('splits an apply_patch per file, keeping each line with its own path', () => {
    // The runtime flattens every added line into one blob, which loses the
    // association a patch already carries — and that association is the whole
    // input to the prose/strict decision.
    const patch = [
      '*** Begin Patch',
      '*** Add File: docs/a.md',
      '+prose line',
      '*** Add File: src/b.js',
      '+const x = 1;',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(patchAdditions(patch), [
      { path: 'docs/a.md', text: 'prose line' },
      { path: 'src/b.js', text: 'const x = 1;' },
    ]);
  });

  it('reads a fenced quote in a patched document as prose, not as a footer', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: docs/a.md',
      '+Rejected example:',
      '+```',
      `+Co-Authored-By: ${TOOL}`,
      '+```',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(inspectFileWrites(patchAdditions(patch), { cwd: '/repo' }), {
      blocked: false,
    });
  });

  it('blocks the same line added to a source file by a patch', () => {
    const patch = `*** Begin Patch\n*** Update File: src/b.js\n+// Co-Authored-By: ${TOOL} <a@b>\n*** End Patch`;
    const verdict = inspectFileWrites(patchAdditions(patch), { cwd: '/repo' });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'src/b.js');
  });
});

describe('.ghostwriterignore', () => {
  let repo;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-ignore-'));
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.ghostwriterignore'),
      ['# policy exemptions', '', 'docs/attribution.md', 'vendor/**', '*.snap', ''].join('\n')
    );
  });

  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  beforeEach(() => resetIgnoreCache());

  it('exempts a named file, a subtree and a basename anywhere', () => {
    assert.equal(isIgnored('docs/attribution.md', repo), true);
    assert.equal(isIgnored('vendor/pkg/lib.js', repo), true);
    assert.equal(isIgnored('src/deep/tree/fixture.snap', repo), true);
  });

  it('exempts nothing else', () => {
    assert.equal(isIgnored('docs/other.md', repo), false);
    assert.equal(isIgnored('src/index.js', repo), false);
  });

  it('is found by walking up from a subdirectory', () => {
    assert.equal(isIgnored('attribution.md', path.join(repo, 'docs')), true);
  });

  it('lets a write through only for an exempt path', () => {
    const dirty = `// Generated with ${TOOL} Code`;
    assert.deepEqual(
      inspectFileWrites([{ path: 'vendor/pkg/lib.js', text: dirty }], { cwd: repo }),
      { blocked: false }
    );
    assert.equal(
      inspectFileWrites([{ path: 'src/index.js', text: dirty }], { cwd: repo }).blocked,
      true
    );
  });

  it('names every path an exemption let through', () => {
    // A silent skip and a working rule look identical. The CI scanner prints
    // these, so an exemption is visible in the check as well as in the diff.
    const seen = [];
    inspectFileWrites([{ path: 'vendor/pkg/lib.js', text: `// Generated with ${TOOL} Code` }], {
      cwd: repo,
      onExempt: (file) => seen.push(file),
    });
    assert.deepEqual(seen, ['vendor/pkg/lib.js']);
  });

  it('can take the list from another tree while judging this one', () => {
    // What CI does: a change that adds an attribution-bearing file AND the
    // line exempting it would otherwise clear itself. The list comes from the
    // base revision, so the new exemption does not apply until it merges.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-base-'));
    try {
      fs.writeFileSync(path.join(other, '.ghostwriterignore'), 'docs/attribution.md\n');
      resetIgnoreCache();
      // `vendor/**` is exempt in `repo` and not in `other`.
      assert.equal(isIgnored('vendor/pkg/lib.js', repo, other), false, 'the local list is ignored');
      assert.equal(isIgnored('docs/attribution.md', repo, other), true, 'the given list applies');
      assert.equal(
        inspectFileWrites([{ path: 'vendor/pkg/lib.js', text: `// Generated with ${TOOL} Code` }], {
          cwd: repo,
          ignoreFrom: other,
        }).blocked,
        true
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('exempts nothing when no ignore file exists', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-bare-'));
    try {
      assert.equal(isIgnored('anything.js', bare), false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

// A source line of `++i;` arrives in a diff as `+++i;`. A reader that skips
// anything starting with `+++` drops it — which is a way to write an
// attribution the scanner never reads.
describe('unifiedAdditions — every added line, headers told apart by position', () => {
  function diff(...body) {
    return ['diff --git a/x.c b/x.c', '--- a/x.c', '+++ b/x.c', '@@ -1 +1,2 @@', ...body].join(
      '\n'
    );
  }

  it('keeps an added line that begins with a plus', () => {
    const [file] = unifiedAdditions(diff('+++i;', '+  return 0;'));
    assert.equal(file.path, 'x.c');
    assert.equal(file.text, '++i;\n  return 0;');
  });

  it('reads attribution hidden behind a doubled plus', () => {
    const [file] = unifiedAdditions(diff(`++ Generated with ${TOOL} Code`));
    assert.equal(checkFileText(file.path, file.text).blocked, true);
  });

  it('reads the real file header, and only where a header can be', () => {
    const [file] = unifiedAdditions(diff('++ b/evil.c', '+ok'));
    assert.equal(file.path, 'x.c', 'a mid-hunk +++ line is content, not a new file');
    assert.equal(file.text, '+ b/evil.c\nok');
  });

  // Under `-U0` a deleted line starting `-- ` and an added line starting
  // `++ ` land adjacent, encoded as `--- ` and `+++ `. Adjacency alone would
  // read the second as a file header and swallow the addition whole.
  it('does not let hunk content spoof a file header', () => {
    const spoof = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1 +1 @@',
      '--- old text',
      `+++ Generated with ${TOOL} Code`,
    ].join('\n');
    const files = unifiedAdditions(spoof);
    assert.equal(files.length, 1, 'the addition must not open a second file');
    assert.equal(files[0].path, 'x.md');
    assert.equal(checkFileText(files[0].path, files[0].text).blocked, true);
  });

  // The hunk header declares how many lines follow, so nothing inside a hunk
  // can end it early — not `--- `, not `+++ `, not a line that reads exactly
  // like a new file boundary.
  it('treats a whole hunk as content, whatever its lines look like', () => {
    const spoof = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1 +1,3 @@',
      '+diff --git a/z b/z',
      '+-- old',
      `++ Generated with ${TOOL} Code`,
    ].join('\n');
    const files = unifiedAdditions(spoof);
    assert.equal(files.length, 1, 'nothing in a hunk may open a second file');
    assert.equal(checkFileText(files[0].path, files[0].text).blocked, true);
  });

  // Even hand-fed text that git would never emit: the counts still bound it.
  it('counts its way past an unprefixed boundary inside a hunk', () => {
    const spoof = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1 +1,3 @@',
      '+a',
      'diff --git a/z b/z',
      '--- a/z',
      `+++ Generated with ${TOOL} Code`,
    ].join('\n');
    const files = unifiedAdditions(spoof);
    assert.equal(files.length, 1);
    assert.equal(checkFileText(files[0].path, files[0].text).blocked, true);
  });

  it('spends context, addition and deletion lines against the right sides', () => {
    const mixed = [
      'diff --git a/c.js b/c.js',
      '--- a/c.js',
      '+++ b/c.js',
      '@@ -1,3 +1,4 @@',
      ' one',
      '-two',
      '+TWO',
      '+three',
      ' four',
    ].join('\n');
    assert.deepEqual(unifiedAdditions(mixed), [{ path: 'c.js', text: 'TWO\nthree' }]);
  });

  it('still reads the header of every real file in a multi-file diff', () => {
    const two = [
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1 +1 @@',
      '+const x = 1;',
      'diff --git a/b.js b/b.js',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -1 +1 @@',
      '+const y = 2;',
    ].join('\n');
    assert.deepEqual(unifiedAdditions(two), [
      { path: 'a.js', text: 'const x = 1;' },
      { path: 'b.js', text: 'const y = 2;' },
    ]);
  });

  it('drops what a deletion adds, which is nothing', () => {
    const gone = ['diff --git a/x.c b/x.c', '--- a/x.c', '+++ /dev/null'].join('\n');
    assert.deepEqual(unifiedAdditions(gone), []);
  });

  it('ignores removed and context lines', () => {
    const [file] = unifiedAdditions(diff(` const keep = '${TOOL}';`, `-// Generated with ${TOOL}`));
    assert.equal(file.text, '');
  });
});

// An exemption is only an exemption where it was reviewed. A repository
// checked out below a directory that happens to hold an ignore file must not
// adopt rules written for something else.
describe('.ghostwriterignore — the repository boundary', () => {
  let outer;

  before(() => {
    outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-boundary-'));
    fs.writeFileSync(path.join(outer, '.ghostwriterignore'), '**\n');
    fs.mkdirSync(path.join(outer, 'repo', '.git'), { recursive: true });
  });

  after(() => {
    if (outer) fs.rmSync(outer, { recursive: true, force: true });
  });

  beforeEach(() => resetIgnoreCache());

  it('does not adopt an ignore file from outside the repository', () => {
    assert.equal(isIgnored('src/a.js', path.join(outer, 'repo')), false);
  });

  it('still honours one at the repository root', () => {
    const root = path.join(outer, 'repo');
    fs.writeFileSync(path.join(root, '.ghostwriterignore'), 'src/a.js\n');
    resetIgnoreCache();
    assert.equal(isIgnored('src/a.js', root), true);
    fs.rmSync(path.join(root, '.ghostwriterignore'));
  });

  // A nested list is not a scoping convenience, it is a way to grant yourself
  // an exemption: writing `sub/.ghostwriterignore` is not attribution, so
  // nothing stops it, and every later write under `sub/` would be excused.
  it('ignores a nested list and keeps the root one', () => {
    const repo = path.join(outer, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.ghostwriterignore'), 'sub/allowed.js\n');
    fs.writeFileSync(path.join(repo, 'sub', '.ghostwriterignore'), '**\n');
    const sub = path.join(repo, 'sub');

    resetIgnoreCache();
    assert.equal(isIgnored('x.js', sub), false, 'the nested ** must not apply');
    resetIgnoreCache();
    assert.equal(isIgnored('allowed.js', sub), true, 'the root list must still reach here');

    fs.rmSync(path.join(repo, '.ghostwriterignore'));
    fs.rmSync(path.join(repo, 'sub'), { recursive: true });
  });

  it('applies normally where there is no repository at all', () => {
    resetIgnoreCache();
    assert.equal(isIgnored('anything.js', outer), true);
  });
});
