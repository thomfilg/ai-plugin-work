'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Lazily require the module UNDER TEST inside each test body. During the RED
// phase the source file does not exist yet. A top-level (or uncaught in-test)
// require surfaces the runtime's "Cannot find module" / "MODULE_NOT_FOUND"
// text in the runner output, which the RED gate flags as a structural load
// failure rather than a behavior gap. We catch that specific bootstrap error
// and re-fail with a clean, signature-free assertion message so the RED
// failure reflects the missing behavior (unimplemented exports). Once the
// source lands (GREEN) the require succeeds and the real assertions run.
function usage() {
  try {
    return require('../context-usage');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      assert.fail('context-usage not implemented yet (unimplemented behavior)');
    }
    throw err;
  }
}

// ─── Temp-fixture helpers ────────────────────────────────────────────────────

let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-usage-'));
});

test.afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

/**
 * Write JSONL lines (objects → JSON, raw strings passed through verbatim so a
 * test can inject a deliberately corrupt line) to a temp transcript file.
 */
function writeTranscript(lines) {
  const file = path.join(tmpDir, 'transcript.jsonl');
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, `${body}\n`);
  return file;
}

/** A claude-shaped assistant turn carrying a nested message.usage block. */
function claudeTurn({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0 } = {}) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
    },
  };
}

/**
 * A codex-shaped `token_count` record. `total_token_usage` is a CUMULATIVE
 * running total; `last_token_usage` is the MOST RECENT turn's usage (the
 * current-occupancy signal). `model_context_window` is the real context limit.
 * Mirrors tests/fixtures/runtime/codex/rollout.jsonl.
 *
 *   - `total`      → last_token_usage.total_tokens (this turn's occupancy)
 *   - `cumulative` → total_token_usage.total_tokens (session running total)
 *   - `omitLast`   → legacy shape carrying only total_token_usage
 */
function codexTokenCount({
  input = 0,
  output = 0,
  total,
  cumulative,
  window = 258400,
  omitLast = false,
} = {}) {
  const lastTotal = total === undefined ? input + output : total;
  const info = {
    total_token_usage: {
      input_tokens: input,
      cached_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: cumulative === undefined ? lastTotal : cumulative,
    },
    model_context_window: window,
  };
  if (!omitLast) {
    info.last_token_usage = {
      input_tokens: input,
      cached_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: lastTotal,
    };
  }
  return { type: 'event_msg', payload: { type: 'token_count', info } };
}

// ─── R1: current occupancy = the LAST turn, not the cross-turn sum ────────────

test('readCumulativeUsage: returns the LAST turn occupancy, not the cross-turn sum', () => {
  // Summing (40000+20000)+(44000+20000)=124000 is the B1 over-count. The
  // current occupancy is the most recent turn only: 44000+20000 = 64000.
  const file = writeTranscript([
    { type: 'user', message: { role: 'user' } },
    claudeTurn({ input: 40000, output: 20000 }),
    claudeTurn({ input: 44000, output: 20000 }),
  ]);
  assert.equal(usage().readCumulativeUsage(file), 64000);
});

test('readCumulativeUsage: multi-turn growing cache_read is NOT summed (B1 regression)', () => {
  // Each turn re-sends the prior context as cache_read — the exact pattern that
  // makes a cross-turn sum explode. Summing the three occupancies would give
  // 6000+9500+13500=29000; the correct current occupancy is the last turn only.
  const file = writeTranscript([
    claudeTurn({ input: 5000, output: 1000, cacheRead: 0 }), // occ 6000
    claudeTurn({ input: 2000, output: 1500, cacheRead: 6000 }), // occ 9500
    claudeTurn({ input: 2000, output: 2000, cacheRead: 9500 }), // occ 13500
  ]);
  assert.equal(usage().readCumulativeUsage(file), 13500);
});

test('readCumulativeUsage: counts cache token fields on the last turn', () => {
  const file = writeTranscript([
    claudeTurn({ input: 1000, output: 500, cacheRead: 2000, cacheCreate: 300 }),
  ]);
  assert.equal(usage().readCumulativeUsage(file), 3800);
});

test('readCumulativeUsage: a single turn with only input+output', () => {
  const file = writeTranscript([claudeTurn({ input: 62000, output: 62000 })]);
  assert.equal(usage().readCumulativeUsage(file), 124000);
});

test('readCumulativeUsage: trailing non-usage records do not reset the last occupancy', () => {
  const file = writeTranscript([
    claudeTurn({ input: 100, output: 24 }),
    { type: 'user', message: { role: 'user' } },
    { type: 'summary', summary: 'nothing here' },
  ]);
  assert.equal(usage().readCumulativeUsage(file), 124);
});

test('readContextUsage: claude reports { tokens, contextWindow: 0 } (no window in transcript)', () => {
  const file = writeTranscript([claudeTurn({ input: 100, output: 24 })]);
  assert.deepEqual(usage().readContextUsage(file), { tokens: 124, contextWindow: 0 });
});

// ─── R1/R8/R12: fail-safe reads ──────────────────────────────────────────────

test('readCumulativeUsage: nonexistent path → 0 and never throws', () => {
  const missing = path.join(tmpDir, 'does-not-exist.jsonl');
  let result;
  assert.doesNotThrow(() => {
    result = usage().readCumulativeUsage(missing);
  });
  assert.equal(result, 0);
});

test('readCumulativeUsage: undefined path → 0 and never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = usage().readCumulativeUsage(undefined);
  });
  assert.equal(result, 0);
});

test('readContextUsage: nonexistent path → { tokens: 0, contextWindow: 0 }', () => {
  const missing = path.join(tmpDir, 'nope.jsonl');
  assert.deepEqual(usage().readContextUsage(missing), { tokens: 0, contextWindow: 0 });
});

test('readCumulativeUsage: empty file → 0', () => {
  const file = path.join(tmpDir, 'empty.jsonl');
  fs.writeFileSync(file, '');
  assert.equal(usage().readCumulativeUsage(file), 0);
});

test('readCumulativeUsage: a malformed JSONL line is skipped, last valid turn wins', () => {
  const file = writeTranscript([
    claudeTurn({ input: 1000, output: 200 }),
    '{ this is not valid json',
    claudeTurn({ input: 3000, output: 800 }),
  ]);
  let result;
  assert.doesNotThrow(() => {
    result = usage().readCumulativeUsage(file);
  });
  assert.equal(result, 3800);
});

test('readCumulativeUsage: blank lines are ignored, last turn wins', () => {
  const file = path.join(tmpDir, 'blanks.jsonl');
  fs.writeFileSync(
    file,
    `${JSON.stringify(claudeTurn({ input: 10, output: 5 }))}\n\n\n${JSON.stringify(
      claudeTurn({ input: 20, output: 5 })
    )}\n`
  );
  assert.equal(usage().readCumulativeUsage(file), 25);
});

// ─── B3: bounded tail read (last-turn occupancy lives at the file's end) ──────

test('readCumulativeUsage: reads the last-turn occupancy from a large transcript (tail scan)', () => {
  const filler = Array.from({ length: 8000 }, (_, i) =>
    JSON.stringify({ type: 'noise', i, pad: 'x'.repeat(90) })
  );
  const file = path.join(tmpDir, 'big.jsonl');
  const lastTurn = JSON.stringify(claudeTurn({ input: 5000, output: 1200 }));
  fs.writeFileSync(file, `${[...filler, lastTurn].join('\n')}\n`);
  assert.equal(usage().readCumulativeUsage(file), 6200);
});

test('readCumulativeUsage: falls back to a full read when the only usage turn precedes the tail window', () => {
  const head = JSON.stringify(claudeTurn({ input: 7000, output: 800 }));
  const filler = Array.from({ length: 9000 }, (_, i) =>
    JSON.stringify({ type: 'noise', i, pad: 'x'.repeat(90) })
  );
  const file = path.join(tmpDir, 'head-usage.jsonl');
  fs.writeFileSync(file, `${[head, ...filler].join('\n')}\n`);
  // The last 512KB (the tail slice) is pure filler — the fallback full read
  // must still find the head usage turn.
  assert.equal(usage().readCumulativeUsage(file), 7800);
});

// ─── Codex leg: last-turn occupancy from last_token_usage (not cumulative) ────

test('readCumulativeUsage: codex uses the last turn last_token_usage, not the cumulative total', () => {
  // total_token_usage is a running COST total (33143 after two turns); the
  // current occupancy is the last snapshot's last_token_usage (20100).
  const file = writeTranscript([
    { type: 'session_meta', payload: { session_id: 'x' } },
    codexTokenCount({ input: 12950, output: 93, total: 13043, cumulative: 13043 }),
    { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    codexTokenCount({ input: 19000, output: 1100, total: 20100, cumulative: 33143 }),
  ]);
  assert.equal(usage().readCumulativeUsage(file), 20100);
});

test('readCumulativeUsage: codex prefers last_token_usage.total_tokens over summing fields', () => {
  // total_tokens (50000) is authoritative even though input+output (13000+43) differ.
  const file = writeTranscript([
    { type: 'session_meta', payload: { session_id: 'x' } },
    codexTokenCount({ input: 13000, output: 43, total: 50000, cumulative: 50000 }),
  ]);
  assert.equal(usage().readCumulativeUsage(file), 50000);
});

test('readCumulativeUsage: codex sums input+output when last_token_usage.total_tokens is absent', () => {
  const rec = codexTokenCount({ input: 8000, output: 500 });
  delete rec.payload.info.last_token_usage.total_tokens;
  const file = writeTranscript([{ type: 'session_meta', payload: { session_id: 'x' } }, rec]);
  assert.equal(usage().readCumulativeUsage(file), 8500);
});

test('readCumulativeUsage: codex falls back to total_token_usage when last_token_usage is absent (legacy)', () => {
  const rec = codexTokenCount({ input: 7000, output: 0, cumulative: 7000, omitLast: true });
  const file = writeTranscript([{ type: 'session_meta', payload: { session_id: 'x' } }, rec]);
  assert.equal(usage().readCumulativeUsage(file), 7000);
});

test('readContextUsage: codex surfaces the model_context_window as the limit', () => {
  const file = writeTranscript([
    codexTokenCount({ input: 100, output: 10, total: 110, cumulative: 110, window: 258400 }),
  ]);
  assert.deepEqual(usage().readContextUsage(file), { tokens: 110, contextWindow: 258400 });
});

test('readCumulativeUsage: codex with no token_count records → 0', () => {
  const file = writeTranscript([
    { type: 'session_meta', payload: { session_id: 'x' } },
    { type: 'response_item', payload: { type: 'message', role: 'user' } },
  ]);
  assert.equal(usage().readCumulativeUsage(file), 0);
});

test('readCumulativeUsage: codex skips a malformed line and still returns the last valid occupancy', () => {
  const file = writeTranscript([
    { type: 'session_meta', payload: { session_id: 'x' } },
    codexTokenCount({ input: 100, output: 10, total: 110, cumulative: 110 }),
    '{ not valid json',
    codexTokenCount({ input: 200, output: 20, total: 220, cumulative: 330 }),
  ]);
  let result;
  assert.doesNotThrow(() => {
    result = usage().readCumulativeUsage(file);
  });
  assert.equal(result, 220);
});
