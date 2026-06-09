const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', 'lib', 'emit-warnings.js');

describe('emit-warnings — formatWarnings', () => {
  it('renders a blockquote line starting with > ⚠️ SPLIT-WARNING: containing kind/file/message/hint', () => {
    const { formatWarnings } = require(MODULE_PATH);
    const out = formatWarnings([
      {
        kind: 'A',
        file: 'surfaces/foo.ts',
        message: 'collision detected',
        hint: 'merge-with-prior-task',
      },
    ]);
    assert.ok(typeof out === 'string', 'output must be a string');
    const firstLine = out.split('\n')[0];
    assert.ok(
      firstLine.startsWith('> ⚠️ SPLIT-WARNING:'),
      `expected first line to start with "> ⚠️ SPLIT-WARNING:", got: ${firstLine}`
    );
    assert.match(out, /surfaces\/foo\.ts/, 'output must contain file');
    assert.match(out, /collision detected/, 'output must contain message');
    assert.match(out, /merge-with-prior-task/, 'output must contain hint');
  });

  it('strips $HOME prefix from emitted paths replacing with ~', () => {
    const { formatWarnings } = require(MODULE_PATH);
    const home = process.env.HOME || '/home/test';
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const out = formatWarnings([
        { kind: 'B', file: `${home}/repo/src/x.ts`, message: 'm', hint: 'h' },
      ]);
      assert.ok(!out.includes(home), `output must not contain raw $HOME (${home}): ${out}`);
      assert.match(out, /~\/repo\/src\/x\.ts/, 'output must replace $HOME with ~');
    } finally {
      process.env.HOME = prev;
    }
  });

  it('renders multiple warnings — one block per record', () => {
    const { formatWarnings } = require(MODULE_PATH);
    const out = formatWarnings([
      { kind: 'A', file: 'x', message: 'm1', hint: 'h1' },
      { kind: 'C', file: 'y', message: 'm2', hint: 'h2' },
    ]);
    const count = (out.match(/> ⚠️ SPLIT-WARNING:/g) || []).length;
    assert.equal(count, 2, 'must emit one SPLIT-WARNING line per warning');
    assert.match(out, /m1/);
    assert.match(out, /m2/);
  });
});

describe('emit-warnings — dedupe', () => {
  it('collapses same-file warnings across passes into one warning citing all kinds', () => {
    const { dedupe } = require(MODULE_PATH);
    const result = dedupe([
      { file: 'x', kind: 'A', message: 'm1', hint: 'h1' },
      { file: 'x', kind: 'C', message: 'm2', hint: 'h2' },
    ]);
    assert.equal(result.length, 1, 'must collapse same-file warnings into one');
    const merged = result[0];
    assert.equal(merged.file, 'x');
    const haystack = JSON.stringify(merged);
    assert.match(haystack, /A/, 'merged warning must cite Pass A');
    assert.match(haystack, /C/, 'merged warning must cite Pass C');
    assert.match(haystack, /m1/, 'merged warning must include message m1');
    assert.match(haystack, /m2/, 'merged warning must include message m2');
  });

  it('leaves distinct file paths as separate warnings', () => {
    const { dedupe } = require(MODULE_PATH);
    const result = dedupe([
      { file: 'x', kind: 'A', message: 'm1', hint: 'h1' },
      { file: 'y', kind: 'A', message: 'm2', hint: 'h2' },
    ]);
    assert.equal(result.length, 2, 'distinct files must remain separate');
    const files = result.map((r) => r.file).sort();
    assert.deepEqual(files, ['x', 'y']);
  });

  it('returns empty array on empty input', () => {
    const { dedupe } = require(MODULE_PATH);
    assert.deepEqual(dedupe([]), []);
  });

  it('iterative merge of A+B+C produces a single non-nested citation prefix', () => {
    const { dedupe } = require(MODULE_PATH);
    const result = dedupe([
      { file: 'x', kind: 'A', message: 'm1', hint: 'h1' },
      { file: 'x', kind: 'B', message: 'm2', hint: 'h2' },
      { file: 'x', kind: 'C', message: 'm3', hint: 'h3' },
    ]);
    assert.equal(result.length, 1, 'must collapse all same-file warnings into one');
    const merged = result[0];
    assert.equal(merged.kind, 'A+B+C', 'kind must be sorted union joined with +');
    // Citation must appear exactly once — no inner "cites Pass" embedded in the hint.
    const citationCount = (merged.hint.match(/cites Pass/g) || []).length;
    assert.equal(
      citationCount,
      1,
      `hint must contain exactly one "cites Pass" prefix, got: ${merged.hint}`
    );
    assert.equal(
      merged.hint,
      'cites Pass A+B+C: h1 | h2 | h3',
      'hint must list raw hints once, prefixed by a single citation'
    );
  });
});

describe('emit-warnings — purity', () => {
  it('module exports formatWarnings and dedupe', () => {
    const mod = require(MODULE_PATH);
    assert.equal(typeof mod.formatWarnings, 'function');
    assert.equal(typeof mod.dedupe, 'function');
  });

  it('library functions contain no console.* calls (CLI exit is gated to require.main === module)', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(MODULE_PATH, 'utf-8');
    assert.ok(!/console\.[a-z]+\s*\(/.test(src), 'module must not call console.*');
    // process.exit IS allowed — but only inside the CLI runCli() helper
    // and only when invoked via the `require.main === module` guard. The
    // library exports (formatWarnings, dedupe, etc.) remain pure.
    assert.match(
      src,
      /if \(require\.main === module\)/,
      'process.exit must be guarded by `if (require.main === module)` so library callers stay pure'
    );
  });
});
