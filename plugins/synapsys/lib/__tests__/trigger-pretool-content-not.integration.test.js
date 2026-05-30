'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const matcherModule = require('../matcher');
const {
  evaluatePretoolContentNot,
  hasNegativeContentPatterns,
  matchPreTool,
  matchPreToolResult,
} = matcherModule;

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const ret = fn();
    return { ret, stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

// --- Task 2: evaluatePretoolContentNot helper ---

test('evaluatePretoolContentNot returns {excluded:true, pattern} when a negative regex matches', () => {
  const memory = {
    name: 'ui-use-Button-not-raw',
    triggerPretoolContentNot: ['@app-services-monitoring/ui'],
  };
  const content = "import { Button } from '@app-services-monitoring/ui';";
  const result = evaluatePretoolContentNot(memory, content);
  assert.deepEqual(result, { excluded: true, pattern: '@app-services-monitoring/ui' });
});

test('evaluatePretoolContentNot returns {excluded:false, pattern:null} when no pattern matches', () => {
  const memory = {
    name: 'mem-no-match',
    triggerPretoolContentNot: ['@app-services-monitoring/ui'],
  };
  const content = "import { Button } from 'somewhere-else';";
  const result = evaluatePretoolContentNot(memory, content);
  assert.deepEqual(result, { excluded: false, pattern: null });
});

test('evaluatePretoolContentNot returns {excluded:false, pattern:null} on empty triggerPretoolContentNot array', () => {
  const memory = { name: 'mem-empty', triggerPretoolContentNot: [] };
  const result = evaluatePretoolContentNot(memory, '<button>Go</button>');
  assert.deepEqual(result, { excluded: false, pattern: null });
});

test('evaluatePretoolContentNot compiles regex with case-insensitive (i) flag', () => {
  const memory = {
    name: 'mem-case',
    triggerPretoolContentNot: ['<BUTTON'],
  };
  const result = evaluatePretoolContentNot(memory, '<button>Go</button>');
  assert.equal(result.excluded, true);
  assert.equal(result.pattern, '<BUTTON');
});

test('evaluatePretoolContentNot compiles regex with multiline (m) flag', () => {
  const memory = {
    name: 'mem-multiline',
    triggerPretoolContentNot: ['^import React'],
  };
  const content = "'use client';\nimport React from 'react';\n";
  const result = evaluatePretoolContentNot(memory, content);
  assert.equal(result.excluded, true);
  assert.equal(result.pattern, '^import React');
});

test('evaluatePretoolContentNot: one invalid regex is skipped with stderr warning; remaining patterns still gate', () => {
  const memory = {
    name: 'mem-mixed',
    triggerPretoolContentNot: ['(unclosed', '@app-services-monitoring/ui'],
  };
  const { ret, stderr } = captureStderr(() =>
    evaluatePretoolContentNot(memory, "import x from '@app-services-monitoring/ui';")
  );
  assert.equal(ret.excluded, true);
  assert.equal(ret.pattern, '@app-services-monitoring/ui');
  assert.match(
    stderr,
    /\[synapsys\] memory mem-mixed: invalid trigger_pretool_content_not regex "\(unclosed":/
  );
});

test('evaluatePretoolContentNot: all-invalid returns {excluded:false, pattern:null} (positive-only fallback)', () => {
  const memory = {
    name: 'mem-all-bad',
    triggerPretoolContentNot: ['(unclosed', '[bad'],
  };
  const { ret, stderr } = captureStderr(() =>
    evaluatePretoolContentNot(memory, 'any content here')
  );
  assert.deepEqual(ret, { excluded: false, pattern: null });
  assert.match(
    stderr,
    /\[synapsys\] memory mem-all-bad: invalid trigger_pretool_content_not regex "\(unclosed":/
  );
  assert.match(
    stderr,
    /\[synapsys\] memory mem-all-bad: invalid trigger_pretool_content_not regex "\[bad":/
  );
});

test('hasNegativeContentPatterns returns true when triggerPretoolContentNot is non-empty array', () => {
  const memory = { triggerPretoolContentNot: ['foo'] };
  assert.equal(hasNegativeContentPatterns(memory), true);
});

test('hasNegativeContentPatterns returns false when triggerPretoolContentNot is empty array', () => {
  const memory = { triggerPretoolContentNot: [] };
  assert.equal(hasNegativeContentPatterns(memory), false);
});

test('hasNegativeContentPatterns returns false when triggerPretoolContentNot is missing/undefined', () => {
  assert.equal(hasNegativeContentPatterns({}), false);
});

test('hasNegativeContentPatterns returns false when triggerPretoolContentNot is not an array', () => {
  assert.equal(hasNegativeContentPatterns({ triggerPretoolContentNot: 'foo' }), false);
  assert.equal(hasNegativeContentPatterns({ triggerPretoolContentNot: null }), false);
});

test('evaluatePretoolContentNot and hasNegativeContentPatterns are exported from lib/matcher.js', () => {
  const matcher = require('../matcher');
  assert.equal(typeof matcher.evaluatePretoolContentNot, 'function');
  assert.equal(typeof matcher.hasNegativeContentPatterns, 'function');
});

// --- Task 3: matchPreTool AND-NOT gate integration ---

const BUTTON_MEMORY_BASE = {
  name: 'ui-use-Button-not-raw',
  events: ['PreToolUse'],
  triggerPretool: ['Edit:.*\\.tsx'],
  triggerPretoolContent: ['<button\\b'],
};

function editPayload(newString, filePath = 'src/Foo.tsx') {
  return {
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'x', new_string: newString },
  };
}

// S1 — fires on positive match w/ no negative present
test('P0 #1, #2 — memory fires when positive matches and no negative pattern is present', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: [],
  };
  assert.equal(matchPreTool(memory, editPayload('<button>Go</button>')), true);
});

// S2 — UI-package import excludes
test('P0 #2, #3 — UI-package import excludes the memory', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: ['@app-services-monitoring/ui'],
  };
  const newString =
    "import { Button } from '@app-services-monitoring/ui';\n<button>Go</button>";
  assert.equal(matchPreTool(memory, editPayload(newString)), false);
});

// S3 — named import excludes
test('P0 #2 — named import excludes the memory', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    // named-import-style negative regex: matches `import { Button }`
    triggerPretoolContentNot: ['import\\s*\\{[^}]*\\bButton\\b[^}]*\\}'],
  };
  const newString = "import { Button } from 'somewhere';\n<button>Go</button>";
  assert.equal(matchPreTool(memory, editPayload(newString)), false);
});

// S4 — short-circuit on positive miss (evaluatePretoolContentNot NOT invoked)
test('P0 #2 (short-circuit) — no positive match means negative is never evaluated', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: ['@app-services-monitoring/ui'],
  };
  const orig = matcherModule.evaluatePretoolContentNot;
  let callCount = 0;
  matcherModule.evaluatePretoolContentNot = (...args) => {
    callCount += 1;
    return orig(...args);
  };
  try {
    // new_string has no <button — positive pattern misses
    const result = matchPreTool(memory, editPayload('<Buttonish>Go</Buttonish>'));
    assert.equal(result, false);
    assert.equal(callCount, 0, 'evaluatePretoolContentNot must not be called when positive misses');
  } finally {
    matcherModule.evaluatePretoolContentNot = orig;
  }
});

// S5 — backwards-compat: memory without trigger_pretool_content_not behaves identically
test('P0 §Compatibility — memory without trigger_pretool_content_not behaves identically to pre-change runtime', () => {
  const memory = { ...BUTTON_MEMORY_BASE }; // no triggerPretoolContentNot at all
  assert.equal(matchPreTool(memory, editPayload('<button>Go</button>')), true);
  assert.equal(matchPreTool(memory, editPayload('<Buttonish>Go</Buttonish>')), false);
});

// S6 — backwards-compat: empty trigger_pretool_content_not array behaves like absent field
test('P0 §Compatibility — empty trigger_pretool_content_not array behaves like absent field', () => {
  const memory = { ...BUTTON_MEMORY_BASE, triggerPretoolContentNot: [] };
  assert.equal(matchPreTool(memory, editPayload('<button>Go</button>')), true);
});

// S7 — partial-invalid negative regex: invalid skipped, remaining still gates
test('P0 #4 — one invalid negative regex is skipped and the rest still gate', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: ['(unclosed', '@app-services-monitoring/ui'],
  };
  const newString =
    "import { Button } from '@app-services-monitoring/ui';\n<button>Go</button>";
  // Silence stderr to keep test output clean
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    assert.equal(matchPreTool(memory, editPayload(newString)), false);
  } finally {
    process.stderr.write = origWrite;
  }
});

// S8 — all-invalid negative regex: falls back to positive-only behavior (fires)
test('P0 #4 — all-invalid negative regex falls back to positive-only behavior', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: ['(unclosed', '[bad'],
  };
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    assert.equal(matchPreTool(memory, editPayload('<button>Go</button>')), true);
  } finally {
    process.stderr.write = origWrite;
  }
});

// --- Task 4: matchPreToolResult object-mode wrapper ---

// S9 — MatchResult exposes negative-excludes reason and matched.negative_pattern
//
// Locked decision (brief P0 #8, spec §Architecture Decisions):
//   On negative exclusion:  { matched: false, reason: 'negative-excludes',
//                             matched: { negative_pattern: P } }
// In JS the second `matched` key wins, so the observable shape is:
//   { reason: 'negative-excludes', matched: { negative_pattern: P } }
// On positive match:        { matched: true }
// On positive miss:         { matched: false } (no `negative-excludes` reason)
test('P0 #8 — MatchResult exposes negative-excludes reason and matched.negative_pattern', () => {
  assert.equal(typeof matchPreToolResult, 'function', 'matchPreToolResult must be exported');
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: ['@app-services-monitoring/ui'],
  };
  const newString =
    "import { Button } from '@app-services-monitoring/ui';\n<button>Go</button>";
  const result = matchPreToolResult(memory, editPayload(newString));
  assert.equal(result.reason, 'negative-excludes', 'reason must be "negative-excludes"');
  assert.ok(result.matched && typeof result.matched === 'object', 'matched must be the details object');
  assert.equal(
    result.matched.negative_pattern,
    '@app-services-monitoring/ui',
    'matched.negative_pattern must equal the excluding pattern'
  );
});

test('P0 #8 / S9 — matchPreToolResult on positive match (no exclusion) returns {matched:true} with no reason', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: ['@app-services-monitoring/ui'],
  };
  const result = matchPreToolResult(memory, editPayload('<button>Go</button>'));
  assert.equal(result.matched, true);
  assert.equal(result.reason, undefined, 'no reason on positive match');
});

test('P0 #8 / S9 — matchPreToolResult on positive miss returns {matched:false} without negative-excludes reason', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: ['@app-services-monitoring/ui'],
  };
  const result = matchPreToolResult(memory, editPayload('<Buttonish>Go</Buttonish>'));
  assert.equal(result.matched, false);
  assert.notEqual(
    result.reason,
    'negative-excludes',
    'positive-miss must not report negative-excludes'
  );
});

test('P0 #8 — boolean matchPreTool export remains unchanged (returns boolean)', () => {
  const memory = {
    ...BUTTON_MEMORY_BASE,
    triggerPretoolContentNot: ['@app-services-monitoring/ui'],
  };
  const newString =
    "import { Button } from '@app-services-monitoring/ui';\n<button>Go</button>";
  const result = matchPreTool(memory, editPayload(newString));
  assert.equal(typeof result, 'boolean');
  assert.equal(result, false);
});

// R7 — backwards-compat regression: real-shape positive-only memory unchanged
test('R7: positive-only memory (no negative field) matches identically to pre-change runtime', () => {
  // Mirror the real `auto-followup-pr-after-push` memory shape
  const memory = {
    name: 'auto-followup-pr-after-push',
    events: ['PreToolUse', 'Stop'],
    triggerPretool: ['Bash:git\\s+push'],
    triggerPretoolContent: [], // no content gating
    // triggerPretoolContentNot intentionally absent
  };
  const payload = { tool_name: 'Bash', tool_input: { command: 'git push origin main' } };
  assert.equal(matchPreTool(memory, payload), true);
  const noMatch = { tool_name: 'Bash', tool_input: { command: 'ls -la' } };
  assert.equal(matchPreTool(memory, noMatch), false);
});

// --- Task 5: synapsys-crystallize-write.js emits trigger_pretool_content_not ---

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFrontmatter } = require('../memory-store');

const CRYSTALLIZE_WRITE = path.resolve(
  __dirname,
  '..',
  '..',
  'scripts',
  'synapsys-crystallize-write.js'
);

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-crystallize-not-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), JSON.stringify({ projectName: 'test' }));
  return { cwd: dir, storeDir };
}

function runCrystallizeWrite(cwd, manifest) {
  return spawnSync(
    process.execPath,
    [CRYSTALLIZE_WRITE, '--store=local', `--cwd=${cwd}`, '--force'],
    { input: JSON.stringify(manifest), encoding: 'utf8' }
  );
}

// S10 — writer round-trips trigger_pretool_content_not from manifest to frontmatter
test('P0 #5 — writer round-trips trigger_pretool_content_not from manifest to frontmatter', () => {
  const { cwd, storeDir } = makeTempStore();
  const manifest = {
    memories: [
      {
        name: 'mem-neg-roundtrip',
        description: 'rt-neg',
        events: ['PreToolUse'],
        trigger_prompt: '',
        trigger_pretool: ['Edit:.*\\.tsx'],
        trigger_pretool_content: ['<button\\b'],
        trigger_pretool_content_not: ['@app-services-monitoring/ui'],
        trigger_session: false,
        inject: 'summary',
        body: 'body text',
      },
    ],
  };
  const res = runCrystallizeWrite(cwd, manifest);
  assert.equal(res.status, 0, `writer failed: stderr=${res.stderr}`);

  const out = path.join(storeDir, 'mem-neg-roundtrip.md');
  const raw = fs.readFileSync(out, 'utf8');
  assert.match(raw, /^trigger_pretool_content_not: @app-services-monitoring\/ui$/m);

  const { meta } = parseFrontmatter(raw);
  const list = Array.isArray(meta.trigger_pretool_content_not)
    ? meta.trigger_pretool_content_not
    : String(meta.trigger_pretool_content_not || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  assert.deepEqual(list, ['@app-services-monitoring/ui']);
});

// S10 — absent-field omission
test('S10 — writer omits trigger_pretool_content_not line when manifest field is absent', () => {
  const { cwd, storeDir } = makeTempStore();
  const manifest = {
    memories: [
      {
        name: 'mem-no-neg',
        description: 'no neg',
        events: ['PreToolUse'],
        trigger_prompt: '',
        trigger_pretool: ['Edit:.*\\.tsx'],
        trigger_pretool_content: ['<button\\b'],
        // trigger_pretool_content_not intentionally absent
        trigger_session: false,
        inject: 'summary',
        body: 'body text',
      },
    ],
  };
  const res = runCrystallizeWrite(cwd, manifest);
  assert.equal(res.status, 0, `writer failed: stderr=${res.stderr}`);

  const out = path.join(storeDir, 'mem-no-neg.md');
  const raw = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(raw, /^trigger_pretool_content_not:/m);
});

// Empty-array omission
test('S10 — writer omits trigger_pretool_content_not line when manifest field is an empty array', () => {
  const { cwd, storeDir } = makeTempStore();
  const manifest = {
    memories: [
      {
        name: 'mem-empty-neg',
        description: 'empty neg',
        events: ['PreToolUse'],
        trigger_prompt: '',
        trigger_pretool: ['Edit:.*\\.tsx'],
        trigger_pretool_content: ['<button\\b'],
        trigger_pretool_content_not: [],
        trigger_session: false,
        inject: 'summary',
        body: 'body text',
      },
    ],
  };
  const res = runCrystallizeWrite(cwd, manifest);
  assert.equal(res.status, 0, `writer failed: stderr=${res.stderr}`);

  const out = path.join(storeDir, 'mem-empty-neg.md');
  const raw = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(raw, /^trigger_pretool_content_not:/m);
});
