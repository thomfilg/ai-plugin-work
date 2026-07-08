/**
 * Tests for scripts/lint-vocab.js + scripts/lib/js-strings.js (WP-10).
 *
 * Proves:
 *   - the lint passes on the real emitted-instruction SCOPE files (WP-08
 *     acceptance: "vocab lint has no violations in these files")
 *   - raw Task(/AskUserQuestion/TodoWrite/Monitor(//plugin:skill literals in
 *     strings ARE flagged, while renderer-wrapped ones are not
 *   - the documented work-pr.workflow.js display-label exceptions hold (the
 *     file still contains the literals, and still lints clean)
 *   - the string scanner ignores comments and regex literals and tracks
 *     enclosing calls through template literals
 *
 * Run with: node --test scripts/__tests__/lint-vocab.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LINT_PATH = path.join(REPO_ROOT, 'scripts', 'lint-vocab.js');
const { lintFile, SCOPE, EXCEPTIONS } = require(LINT_PATH);
const { scanStrings } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'js-strings.js'));

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tempJs(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-vocab-test-'));
  const file = path.join(dir, 'emit.js');
  fs.writeFileSync(file, source);
  return file;
}

describe('lint-vocab — real scope files', () => {
  it('exits 0 over the checked-in emitted-instruction surface', () => {
    const res = spawnSync('node', [LINT_PATH], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    for (const rel of SCOPE) assert.match(res.stdout, new RegExp(`OK ${escapeRegExp(rel)}`));
  });

  it('work-pr.workflow.js still carries the display labels the exception documents', () => {
    const rel = 'plugins/work/scripts/workflows/work-pr/work-pr.workflow.js';
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const snippet of EXCEPTIONS[rel]) {
      assert.ok(src.includes(snippet), `expected documented exception "${snippet}" in ${rel}`);
    }
  });
});

describe('lint-vocab — violation detection (self-test)', () => {
  it('flags each raw pattern in an emitted string', () => {
    const out = lintFile(
      tempJs(
        `const a = 'Launch Task(dev) now';
const b = "Use AskUserQuestion to ask";
const c = \`plan with TodoWrite then Monitor(tail -f x)\`;
const d = 'invoke /work-workflow:check';`
      )
    );
    for (const label of [
      'Task\\(',
      'AskUserQuestion',
      'TodoWrite',
      'Monitor\\(',
      '/plugin:skill',
    ]) {
      assert.ok(
        out.some((v) => new RegExp(`un-rendered "${label}"`).test(v)),
        `${label}\n${out.join('\n')}`
      );
    }
  });

  it('does not flag renderer-wrapped strings or vocab token keys', () => {
    const out = lintFile(
      tempJs(
        `const a = renderQuestionText('Use AskUserQuestion to resolve it', rt);
const b = renderInstruction(\`plan with TodoWrite via /work-workflow:check\`, 'codex');
const c = T('tool.question', {}, rt.name);
const d = wrap(deep(renderQuestionText(['Use AskUserQuestion', 'lines'].join('\\n'))));`
      )
    );
    assert.deepStrictEqual(out, []);
  });

  it('does not flag comments or regex literals', () => {
    const out = lintFile(
      tempJs(
        `// AskUserQuestion in a line comment
/* TodoWrite in a block comment */
const re = /AskUserQuestion|TodoWrite/;
const ok = 'plain string';`
      )
    );
    assert.deepStrictEqual(out, []);
  });
});

describe('js-strings scanner', () => {
  it('reports enclosing calls innermost-last and survives interpolations', () => {
    const strings = scanStrings('outer(inner(`a ${x(1)} b`))');
    assert.strictEqual(strings.length, 1);
    assert.strictEqual(strings[0].content, 'a   b');
    assert.deepStrictEqual(strings[0].calls, ['outer', 'inner']);
  });

  it('treats regex after return as a regex, not division', () => {
    const strings = scanStrings("function f() { return /'quote(/.test(s); } const a = 'kept';");
    assert.deepStrictEqual(
      strings.map((s) => s.content),
      ['kept']
    );
  });

  it('tracks line numbers across multi-line templates', () => {
    const strings = scanStrings('const a = 1;\nconst b = `x`;\nconst c = "y";');
    assert.deepStrictEqual(
      strings.map((s) => s.line),
      [2, 3]
    );
  });
});
