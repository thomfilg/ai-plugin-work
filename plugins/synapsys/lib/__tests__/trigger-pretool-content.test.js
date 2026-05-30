'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeRegex,
  extractPretoolContent,
  evaluatePretoolContent,
  matchPreTool,
} = require('../matcher');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-crystallize-'));
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

test('safeRegex defaults to case-insensitive flag (backwards-compat)', () => {
  const re = safeRegex('foo');
  assert.ok(re instanceof RegExp, 'should return a RegExp');
  assert.equal(re.flags, 'i');
});

test('safeRegex accepts a flags argument (e.g. "im") and applies both flags', () => {
  const re = safeRegex('foo', 'im');
  assert.ok(re instanceof RegExp, 'should return a RegExp');
  assert.ok(re.flags.includes('i'), 'flags should include i');
  assert.ok(re.flags.includes('m'), 'flags should include m');
});

test('safeRegex returns null on invalid pattern even when flags are supplied', () => {
  assert.equal(safeRegex('(unclosed', 'im'), null);
});

// --- Task 2: extractPretoolContent ---

test('extractPretoolContent Edit returns tool_input.new_string', () => {
  assert.equal(
    extractPretoolContent('Edit', {
      file_path: 'a.tsx',
      old_string: 'x',
      new_string: '<button>Go</button>',
    }),
    '<button>Go</button>'
  );
});

test('extractPretoolContent Edit returns null when new_string is missing', () => {
  assert.equal(extractPretoolContent('Edit', { file_path: 'a.tsx' }), null);
});

test('extractPretoolContent Edit returns null when new_string is non-string', () => {
  assert.equal(extractPretoolContent('Edit', { new_string: 123 }), null);
});

test('extractPretoolContent Write returns tool_input.content', () => {
  assert.equal(
    extractPretoolContent('Write', { file_path: 'a.tsx', content: 'hello world' }),
    'hello world'
  );
});

test('extractPretoolContent Write returns null when content missing', () => {
  assert.equal(extractPretoolContent('Write', { file_path: 'a.tsx' }), null);
});

test('extractPretoolContent Write returns null when content is non-string', () => {
  assert.equal(extractPretoolContent('Write', { content: { not: 'a string' } }), null);
});

test('extractPretoolContent MultiEdit joins edits[].new_string with newline', () => {
  const out = extractPretoolContent('MultiEdit', {
    file_path: 'a.tsx',
    edits: [
      { old_string: 'a', new_string: '<button>1</button>' },
      { old_string: 'b', new_string: '<button>2</button>' },
    ],
  });
  assert.equal(out, '<button>1</button>\n<button>2</button>');
});

test('extractPretoolContent MultiEdit filters non-string new_string entries', () => {
  const out = extractPretoolContent('MultiEdit', {
    edits: [
      { new_string: 'keep' },
      { new_string: 42 },
      {
        /* missing */
      },
      { new_string: 'also' },
    ],
  });
  assert.equal(out, 'keep\nalso');
});

test('extractPretoolContent MultiEdit returns null when edits is not an array', () => {
  assert.equal(extractPretoolContent('MultiEdit', { edits: 'nope' }), null);
  assert.equal(extractPretoolContent('MultiEdit', {}), null);
});

test('extractPretoolContent MultiEdit returns null when edits is empty array (fail closed)', () => {
  assert.equal(extractPretoolContent('MultiEdit', { edits: [] }), null);
});

test('extractPretoolContent MultiEdit returns null when all entries lack string new_string (fail closed)', () => {
  assert.equal(
    extractPretoolContent('MultiEdit', {
      edits: [{ new_string: 42 }, {}, { new_string: null }],
    }),
    null
  );
});

test('extractPretoolContent NotebookEdit returns tool_input.new_source', () => {
  assert.equal(
    extractPretoolContent('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'print(1)' }),
    'print(1)'
  );
});

test('extractPretoolContent NotebookEdit returns null when new_source missing', () => {
  assert.equal(extractPretoolContent('NotebookEdit', { notebook_path: 'n.ipynb' }), null);
});

test('extractPretoolContent NotebookEdit returns null when new_source is non-string', () => {
  assert.equal(extractPretoolContent('NotebookEdit', { new_source: ['arr'] }), null);
});

test('extractPretoolContent returns null for other tools (Bash, Read, Grep, etc.)', () => {
  assert.equal(extractPretoolContent('Bash', { command: 'ls' }), null);
  assert.equal(extractPretoolContent('Read', { file_path: 'a' }), null);
  assert.equal(extractPretoolContent('Grep', { pattern: 'x' }), null);
  assert.equal(extractPretoolContent('Unknown', { anything: 'here' }), null);
});

test('extractPretoolContent handles missing/empty toolInput safely', () => {
  assert.equal(extractPretoolContent('Edit', null), null);
  assert.equal(extractPretoolContent('Edit', undefined), null);
  assert.equal(extractPretoolContent('Write', null), null);
});

// --- Task 3: evaluatePretoolContent ---

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

test('evaluatePretoolContent returns false on empty triggerPretoolContent array', () => {
  const memory = { name: 'mem-empty', triggerPretoolContent: [] };
  assert.equal(evaluatePretoolContent(memory, '<button>Go</button>'), false);
});

test('One invalid regex in trigger_pretool_content is skipped with a stderr warning; remaining patterns still match', () => {
  const memory = {
    name: 'mem-mixed',
    triggerPretoolContent: ['(unclosed', '<button'],
  };
  const { ret, stderr } = captureStderr(() =>
    evaluatePretoolContent(memory, 'here is <button>Go</button>')
  );
  assert.equal(ret, true);
  assert.match(
    stderr,
    /^\[synapsys\] memory mem-mixed: invalid trigger_pretool_content regex "\(unclosed": .+\n/
  );
});

test('All-invalid trigger_pretool_content fails closed', () => {
  const memory = {
    name: 'mem-all-bad',
    triggerPretoolContent: ['(unclosed', '[bad'],
  };
  const { ret, stderr } = captureStderr(() => evaluatePretoolContent(memory, 'any content here'));
  assert.equal(ret, false);
  assert.match(
    stderr,
    /\[synapsys\] memory mem-all-bad: invalid trigger_pretool_content regex "\(unclosed":/
  );
  assert.match(
    stderr,
    /\[synapsys\] memory mem-all-bad: invalid trigger_pretool_content regex "\[bad":/
  );
});

test('Case-insensitive flag (i) matches uppercase content', () => {
  const memory = {
    name: 'mem-case',
    triggerPretoolContent: ['<button'],
  };
  assert.equal(evaluatePretoolContent(memory, '<BUTTON>Go</BUTTON>'), true);
});

test('Multiline flag (m) matches an anchored pattern on a non-first line', () => {
  const memory = {
    name: 'mem-multiline',
    triggerPretoolContent: ['^import React'],
  };
  const content = "'use client';\nimport React from 'react';\n";
  assert.equal(evaluatePretoolContent(memory, content), true);
});

// --- Task 4: matchPreTool AND semantics ---

test('Edit on a .tsx file with raw <button> in new_string fires the memory', () => {
  const memory = {
    name: 'use-Button-not-raw',
    events: ['PreToolUse'],
    triggerPretool: ['Edit:.*\\.tsx'],
    triggerPretoolContent: ['<button\\b'],
  };
  const payload = {
    tool_name: 'Edit',
    tool_input: {
      file_path: 'src/Foo.tsx',
      old_string: 'x',
      new_string: '<button onClick={x}>Go</button>',
    },
  };
  const result = matchPreTool(memory, payload);
  assert.equal(result.fired, true);
  assert.equal(result.matched.content_pattern, '<button\\b');
  assert.ok(
    typeof result.matched.content_substring === 'string' &&
      result.matched.content_substring.length > 0,
    'matched.content_substring should be non-empty string'
  );
  assert.ok(result.matched.pretool_pattern, 'matched.pretool_pattern should be set');
});

test('Edit on a .tsx file with <Button> in new_string does NOT fire the memory', () => {
  const memory = {
    name: 'use-Button-not-raw',
    events: ['PreToolUse'],
    triggerPretool: ['Edit:.*\\.tsx'],
    triggerPretoolContent: ['<button\\b'],
  };
  const payload = {
    tool_name: 'Edit',
    tool_input: {
      file_path: 'src/Foo.tsx',
      old_string: 'x',
      new_string: '<Buttonish onClick={x}>Go</Buttonish>',
    },
  };
  // The PascalCase `<Buttonish>` token has no `<button\b` occurrence: after the trailing `n`
  // of the case-insensitive `<button` match comes `i` (a word char), so `\b` cannot anchor.
  const result = matchPreTool(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-content-match');
});

test('Edit on a .ts (not .tsx) file with <button> does NOT fire because trigger_pretool excludes', () => {
  const memory = {
    name: 'mem-tsx-only',
    events: ['PreToolUse'],
    triggerPretool: ['Edit:.*\\.tsx'],
    triggerPretoolContent: ['<button\\b'],
  };
  const payload = {
    tool_name: 'Edit',
    tool_input: {
      file_path: 'src/Foo.ts',
      old_string: 'x',
      new_string: '<button onClick={x}>Go</button>',
    },
  };
  const result = matchPreTool(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-pretool-match');
});

test('Bash tool with trigger_pretool_content fails closed (no content field for Bash)', () => {
  const memory = {
    name: 'mem-bash-failclosed',
    events: ['PreToolUse'],
    triggerPretool: ['Bash:git push'],
    triggerPretoolContent: ['anything'],
  };
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
  };
  const result = matchPreTool(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-content-match');
});

test('MultiEdit joins edits[].new_string with newline before evaluating content patterns', () => {
  const memory = {
    name: 'mem-multiedit-join',
    events: ['PreToolUse'],
    triggerPretool: ['Edit:.*\\.tsx', 'MultiEdit:.*\\.tsx'],
    triggerPretoolContent: ['<button\\b'],
  };
  const payload = {
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: 'a.tsx',
      edits: [
        { old_string: 'a', new_string: 'no match here' },
        { old_string: 'b', new_string: '<button>Go</button>' },
      ],
    },
  };
  assert.equal(matchPreTool(memory, payload).fired, true);
});

test('NotebookEdit uses new_source as content', () => {
  const memory = {
    name: 'mem-notebook',
    events: ['PreToolUse'],
    triggerPretool: ['NotebookEdit:.*\\.ipynb'],
    triggerPretoolContent: ['console\\.log'],
  };
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: 'n.ipynb', new_source: "console.log('x')" },
  };
  assert.equal(matchPreTool(memory, payload).fired, true);
});

// --- Task 6: synapsys-crystallize-write.js emits trigger_pretool_content ---

test('Crystallize writer round-trip preserves trigger_pretool_content (no loss)', () => {
  const { cwd, storeDir } = makeTempStore();
  const manifest = {
    memories: [
      {
        name: 'mem-roundtrip',
        description: 'rt',
        events: ['PreToolUse'],
        trigger_prompt: '',
        trigger_pretool: ['Edit:.*\\.tsx'],
        trigger_pretool_content: ['<button\\b', '<input\\b'],
        trigger_session: false,
        inject: 'summary',
        body: 'body text',
      },
    ],
  };
  const res = runCrystallizeWrite(cwd, manifest);
  assert.equal(res.status, 0, `writer failed: stderr=${res.stderr}`);

  const out = path.join(storeDir, 'mem-roundtrip.md');
  const raw = fs.readFileSync(out, 'utf8');
  assert.match(raw, /^trigger_pretool_content: <button\\b,<input\\b$/m);

  const { meta } = parseFrontmatter(raw);
  const list = Array.isArray(meta.trigger_pretool_content)
    ? meta.trigger_pretool_content
    : String(meta.trigger_pretool_content || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  assert.deepEqual(list, ['<button\\b', '<input\\b']);
});

// --- Task 7: Backwards-compat regression ---

test('Memory without trigger_pretool_content keeps existing behaviour (backwards compatibility)', () => {
  // Mirror the real `auto-followup-pr-after-push` memory shape: it has
  // `trigger_pretool` but NO `trigger_pretool_content`. Pre-feature, this
  // memory fired on `Bash:git push ...`. Post-feature it MUST still fire.
  const memory = {
    name: 'auto-followup-pr-after-push',
    events: ['PreToolUse', 'Stop'],
    triggerPretool: ['Bash:git\\s+push'],
    // triggerPretoolContent intentionally absent (parser yields [])
    triggerPretoolContent: [],
  };
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
  };
  assert.equal(
    matchPreTool(memory, payload).fired,
    true,
    'memory without trigger_pretool_content must still fire on its prior trigger'
  );

  // Regression guard: also assert that adding an unrelated triggerPretool entry
  // does not break prefix-match path.
  const memory2 = { ...memory, triggerPretool: ['Bash:git\\s+push', 'Edit:.*\\.tsx'] };
  assert.equal(matchPreTool(memory2, payload).fired, true);

  // And the negative: a different Bash command must NOT fire.
  const payloadNoMatch = { tool_name: 'Bash', tool_input: { command: 'ls -la' } };
  const noMatchResult = matchPreTool(memory, payloadNoMatch);
  assert.equal(noMatchResult.fired, false);
  assert.equal(noMatchResult.reason, 'no-pretool-match');
});

test('Crystallize writer omits trigger_pretool_content line when field is absent', () => {
  const { cwd, storeDir } = makeTempStore();
  const manifest = {
    memories: [
      {
        name: 'mem-absent',
        description: 'no content trigger',
        events: ['PreToolUse'],
        trigger_prompt: '',
        trigger_pretool: ['Edit:.*\\.tsx'],
        trigger_session: false,
        inject: 'summary',
        body: 'body text',
      },
    ],
  };
  const res = runCrystallizeWrite(cwd, manifest);
  assert.equal(res.status, 0, `writer failed: stderr=${res.stderr}`);

  const raw = fs.readFileSync(path.join(storeDir, 'mem-absent.md'), 'utf8');
  assert.doesNotMatch(raw, /trigger_pretool_content:/);
});
