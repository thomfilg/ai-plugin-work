/**
 * Tests for scripts/lint-skill-frontmatter.js (WP-10 — skills surface pass).
 *
 * Proves:
 *   - the lint passes on every real plugins/<p>/skills/**\/SKILL.md
 *   - it catches each strict-YAML failure mode codex silently drops skills
 *     on (GT §3.1): missing closing ---, tab indent, unquoted inner colon,
 *     bad indicator start, duplicate keys, missing name/description,
 *     unterminated quotes, multi-line scalars
 *   - --fix quotes plain-value offenders and the result lints clean
 *
 * Run with: node --test scripts/__tests__/lint-skill-frontmatter.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LINT_PATH = path.join(REPO_ROOT, 'scripts', 'lint-skill-frontmatter.js');
const { lintContent, fixFile, quoteScalar } = require(LINT_PATH);

function md(frontmatterLines) {
  return ['---', ...frontmatterLines, '---', '', 'body'].join('\n');
}

const VALID = ['name: demo', 'description: A perfectly plain description'];

describe('lint-skill-frontmatter — real skill files', () => {
  it('passes on every SKILL.md in the repo', () => {
    const res = spawnSync('node', [LINT_PATH], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /OK plugins\/work\/skills\/work\/SKILL\.md/);
  });
});

describe('lint-skill-frontmatter — strict-YAML failure modes (self-test)', () => {
  it('accepts a minimal valid frontmatter', () => {
    assert.deepStrictEqual(lintContent(md(VALID)), []);
  });

  it('rejects a missing closing fence', () => {
    const raw = ['---', ...VALID, '', 'body with no closing fence'].join('\n');
    assert.match(lintContent(raw)[0], /missing closing "---"/);
  });

  it('rejects a missing opening fence', () => {
    assert.match(lintContent('name: demo\n')[0], /first line must be exactly "---"/);
  });

  it('rejects TAB indentation', () => {
    const out = lintContent(md(['name: demo', '\tdescription: tabbed']));
    assert.ok(
      out.some((v) => /TAB character/.test(v)),
      out.join('\n')
    );
  });

  it('rejects an unquoted inner colon (the codex probe failure)', () => {
    const out = lintContent(md(['name: demo', 'description: tuple { protect: [paths] } here']));
    assert.ok(
      out.some((v) => /quote it/.test(v)),
      out.join('\n')
    );
  });

  it('rejects a plain value starting with a YAML indicator', () => {
    const out = lintContent(md([...VALID, 'argument-hint: [repo-dir]']));
    assert.ok(
      out.some((v) => /starts with YAML indicator/.test(v)),
      out.join('\n')
    );
  });

  it('rejects duplicate keys', () => {
    const out = lintContent(md([...VALID, 'name: again']));
    assert.ok(
      out.some((v) => /duplicate key "name"/.test(v)),
      out.join('\n')
    );
  });

  it('rejects missing required keys', () => {
    const out = lintContent(md(['name: demo']));
    assert.ok(
      out.some((v) => /"description" is missing/.test(v)),
      out.join('\n')
    );
  });

  it('rejects an unterminated quoted value', () => {
    const out = lintContent(md(['name: demo', 'description: "no closing quote']));
    assert.ok(
      out.some((v) => /unterminated\/malformed/.test(v)),
      out.join('\n')
    );
  });

  it('accepts properly quoted values with inner colons and quotes', () => {
    const out = lintContent(
      md([
        'name: demo',
        `description: 'Says "hi": a colon, a | pipe, and [brackets]'`,
        'argument-hint: "don\'t worry: it\'s quoted"',
      ])
    );
    assert.deepStrictEqual(out, []);
  });

  it('rejects multi-line/block scalars (outside the strict subset)', () => {
    const out = lintContent(md(['name: demo', 'description: >', '  folded scalar line']));
    assert.ok(
      out.some((v) => /not a single-line/.test(v) || /quote it/.test(v)),
      out.join('\n')
    );
  });
});

describe('lint-skill-frontmatter — --fix', () => {
  it('quotes offenders in place and the result lints clean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-fm-fix-'));
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(
      file,
      md(['name: demo', 'description: has an inner colon: right here', 'argument-hint: [x|y]'])
    );
    assert.strictEqual(fixFile(file), true);
    const fixed = fs.readFileSync(file, 'utf8');
    assert.match(fixed, /description: 'has an inner colon: right here'/);
    assert.match(fixed, /argument-hint: '\[x\|y\]'/);
    assert.deepStrictEqual(lintContent(fixed), []);
    assert.strictEqual(fixFile(file), false, 'second fix pass must be a no-op');
  });

  it('quoteScalar picks single quotes, falling back to escaped double quotes', () => {
    assert.strictEqual(quoteScalar('a: b'), "'a: b'");
    assert.strictEqual(quoteScalar(`don't say "hi": ok`), `"don't say \\"hi\\": ok"`);
  });
});
