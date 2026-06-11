'use strict';

/**
 * Task 5 (GH-517) — replay-report.js security-comment cleanup.
 *
 * Asserts:
 *  (a) the production source of `replay-report.js` contains no stale
 *      `ANTHROPIC_API_KEY` reference (R4 — zero ANTHROPIC_API_KEY in code), and
 *  (b) `renderJson`/`renderReport` produce byte-identical output for a fixed
 *      per-memory aggregate fixture (R10 — the `{relevant, irrelevant,
 *      judge_failed}` integer contract + renderer logic are unchanged).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPORT_PATH = path.resolve(__dirname, '..', 'replay-report.js');
const { renderJson, renderReport } = require(REPORT_PATH);

// A fixed aggregate fixture exercising the `{relevant, irrelevant, judge_failed}`
// integer contract, including a null-fp_rate (unjudged) memory and a judged one.
const AGG = {
  'memory.alpha': {
    fires: 10,
    relevant: 6,
    irrelevant: 4,
    judge_failed: 0,
    fp_rate: 0.4,
    sample_matches: ['ctx-a', 'ctx-b', 'ctx-c', 'ctx-d'],
  },
  'memory.beta': {
    fires: 3,
    relevant: null,
    irrelevant: null,
    judge_failed: 0,
    fp_rate: null,
    sample_matches: ['ctx-e'],
  },
};

const SUGGESTIONS = [{ memory: 'memory.alpha', candidates: ['arm-1', 'arm-2'] }];

const META = {
  store: 'shared',
  window: '30d',
  events_total: 100,
  events_ups: 40,
  events_ptu: 60,
  judgeCalls: 2,
  itemsJudged: 10,
  extrapolated: false,
};

// Golden output captured from the renderers (behavior-locking snapshot). The
// comment edit in GREEN must NOT change a single byte of these strings.
const EXPECTED_JSON = JSON.stringify(
  {
    memories: [
      {
        name: 'memory.alpha',
        fires: 10,
        relevant: 6,
        irrelevant: 4,
        judge_failed: 0,
        fp_rate: 0.4,
        sample_matches: ['ctx-a', 'ctx-b', 'ctx-c', 'ctx-d'],
      },
      {
        name: 'memory.beta',
        fires: 3,
        relevant: null,
        irrelevant: null,
        judge_failed: 0,
        fp_rate: null,
        sample_matches: ['ctx-e'],
      },
    ],
    suggestions: [{ memory: 'memory.alpha', candidates: ['arm-1', 'arm-2'] }],
    store: 'shared',
    window: '30d',
    events_total: 100,
    events_ups: 40,
    events_ptu: 60,
    judge_calls: 2,
    items_judged: 10,
    extrapolated: false,
  },
  null,
  2
);

test('replay-report.js source contains no ANTHROPIC_API_KEY reference', () => {
  const body = fs.readFileSync(REPORT_PATH, 'utf8');
  assert.ok(
    !/ANTHROPIC_API_KEY/.test(body),
    'replay-report.js must not reference ANTHROPIC_API_KEY'
  );
});

test('renderJson output is byte-identical for the fixed aggregate fixture', () => {
  assert.equal(renderJson(AGG, SUGGESTIONS, META), EXPECTED_JSON);
});

test('renderReport output is stable for the fixed aggregate fixture', () => {
  const out = renderReport(AGG, SUGGESTIONS, META);
  // Lock the structurally-significant rows so the comment edit cannot
  // change rendering. memory.alpha (fp 40%) ranks above memory.beta (null).
  assert.match(out, /store=shared window=30d events=100 UPS=40 PTU=60/);
  assert.match(out, /memory\.alpha[\s\S]*memory\.beta/);
  assert.match(out, /memory\.alpha\s+10\s+6\s+40%/);
  assert.match(out, /memory\.beta\s+3\s+—\s+—/);
  assert.match(out, /- memory\.alpha: tighten short arms \[arm-1, arm-2\]/);
  assert.match(out, /est\. cost ≈ \$0\.0052 \(10 items judged across 2 batched API calls\)/);
  assert.ok(out.endsWith('\n'), 'report must end with a trailing newline');
});

test('renderer contract: aggregate integer counts flow through unchanged', () => {
  const parsed = JSON.parse(renderJson(AGG, SUGGESTIONS, META));
  const alpha = parsed.memories.find((m) => m.name === 'memory.alpha');
  assert.equal(alpha.fires, 10);
  assert.equal(alpha.relevant, 6);
  assert.equal(alpha.irrelevant, 4);
  assert.equal(alpha.judge_failed, 0);
  assert.equal(alpha.fp_rate, 0.4);
});
