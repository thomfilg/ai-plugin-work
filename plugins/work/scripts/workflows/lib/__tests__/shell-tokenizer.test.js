/**
 * Tests for lib/shell-tokenizer.js — quote-aware tokenizer (GH-590 task2).
 *
 * Run: node --test plugins/work/scripts/workflows/lib/__tests__/shell-tokenizer.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const MODULE_PATH = path.join(__dirname, '..', 'shell-tokenizer.js');

function loadTokenizer() {
  if (!fs.existsSync(MODULE_PATH)) {
    const missing = () => {
      throw new Error('shell-tokenizer module not implemented yet');
    };
    return { tokenize: missing, splitTopLevelCommands: missing };
  }
  return require(MODULE_PATH);
}

describe('shell-tokenizer tokenize', () => {
  it('bare command tokenizes as a single segment', () => {
    const { tokenize } = loadTokenizer();
    const tokens = tokenize('grep foo bar.ts');
    assert.ok(Array.isArray(tokens));
    const segments = tokens.filter((t) => t.kind === 'segment');
    const ops = tokens.filter((t) => t.kind === 'op');
    assert.equal(segments.length, 1);
    assert.equal(ops.length, 0);
    assert.equal(segments[0].value.trim(), 'grep foo bar.ts');
  });

  it('&& chain produces two segments and an && op', () => {
    const { tokenize } = loadTokenizer();
    const tokens = tokenize('pnpm dev:typecheck && grep -q foo bar.ts');
    const segments = tokens.filter((t) => t.kind === 'segment').map((t) => t.value.trim());
    const ops = tokens.filter((t) => t.kind === 'op').map((t) => t.value);
    assert.deepEqual(segments, ['pnpm dev:typecheck', 'grep -q foo bar.ts']);
    assert.deepEqual(ops, ['&&']);
  });

  it('operator inside double quotes is NOT a split', () => {
    const { tokenize } = loadTokenizer();
    const tokens = tokenize('echo "a && b" && echo done');
    const segments = tokens.filter((t) => t.kind === 'segment').map((t) => t.value.trim());
    const ops = tokens.filter((t) => t.kind === 'op').map((t) => t.value);
    assert.deepEqual(segments, ['echo "a && b"', 'echo done']);
    assert.deepEqual(ops, ['&&']);
  });

  it('operator inside single quotes is NOT a split', () => {
    const { tokenize } = loadTokenizer();
    const tokens = tokenize("echo 'a | b ; c' | wc -l");
    const segments = tokens.filter((t) => t.kind === 'segment').map((t) => t.value.trim());
    const ops = tokens.filter((t) => t.kind === 'op').map((t) => t.value);
    assert.deepEqual(segments, ["echo 'a | b ; c'", 'wc -l']);
    assert.deepEqual(ops, ['|']);
  });
});

describe('shell-tokenizer splitTopLevelCommands', () => {
  it('returns single command for bare input', () => {
    const { splitTopLevelCommands } = loadTokenizer();
    assert.deepEqual(splitTopLevelCommands('grep foo bar.ts'), ['grep foo bar.ts']);
  });

  it('splits at top-level && and ||', () => {
    const { splitTopLevelCommands } = loadTokenizer();
    assert.deepEqual(splitTopLevelCommands('a && b || c'), ['a', 'b', 'c']);
  });

  it('splits at top-level ; and pipe', () => {
    const { splitTopLevelCommands } = loadTokenizer();
    assert.deepEqual(splitTopLevelCommands('a ; b | c'), ['a', 'b', 'c']);
  });

  it('mixed pipe and && with quoted operator', () => {
    const { splitTopLevelCommands } = loadTokenizer();
    assert.deepEqual(splitTopLevelCommands('cat "x && y" | grep z && echo ok'), [
      'cat "x && y"',
      'grep z',
      'echo ok',
    ]);
  });

  it('implementation does NOT use regex (state-machine assertion)', () => {
    assert.ok(fs.existsSync(MODULE_PATH), 'shell-tokenizer.js must exist');
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.equal(src.includes('new RegExp'), false, 'must not use new RegExp');
    // Detect any regex literal by scanning for unescaped slashes likely used as delimiters.
    // Use indexOf/split, not regex, to avoid creating one ourselves.
    let inString = false;
    let stringChar = '';
    let hasRegex = false;
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      const prev = i > 0 ? src[i - 1] : '';
      if (inString) {
        if (ch === stringChar && prev !== '\\') inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        // line comment — skip to newline
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
        i += 1;
        continue;
      }
      if (ch === '/') {
        // candidate regex literal — bare-source slash outside strings/comments
        hasRegex = true;
        break;
      }
    }
    assert.equal(hasRegex, false, 'must not contain regex literals');
  });
});
