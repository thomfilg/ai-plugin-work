'use strict';

/**
 * WP-05 codex dual-runtime matcher coverage.
 *
 * Codex delivers file edits as `apply_patch` with a raw-patch payload and no
 * `file_path` (ground truth §2.5.5), so user memories written with
 * `Edit:`/`Write:`/`MultiEdit:`/`NotebookEdit:` specs would silently stop
 * firing. The alias hop (matcher.js pretoolSpecMatches → runtime write-target
 * parser) keeps them firing on parsed patch target paths with ZERO memory
 * data migration. Claude payloads never carry tool_name 'apply_patch', so
 * every claude-shaped assertion here pins the pre-port behavior byte-for-byte.
 *
 * Codex payload fixtures are the checked-in probe captures under
 * tests/fixtures/runtime/codex/ (live-verified 2026-07-07).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const matcher = require(path.resolve(__dirname, '..', 'matcher'));
const { extractPretoolContent } = require(path.resolve(__dirname, '..', 'matcher-content'));

const FIXTURES = path.resolve(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'runtime');
const codexFixture = (name) => require(path.join(FIXTURES, 'codex', name));

const DOTCLAUDE_PATCH =
  '*** Begin Patch\n*** Update File: .claude/settings.json\n+{"hooks": []}\n*** End Patch\n';

function applyPatchPayload(patchText) {
  // Real codex PreToolUse envelope shape (probe capture pre-apply-patch.json).
  return {
    session_id: '019f3c4e-0eed-7e11-bab2-6c1b30b4943e',
    turn_id: '019f3c4e-0fa1-7db2-8979-a470735cf498',
    cwd: '/tmp/codex-probe-repo',
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.5',
    permission_mode: 'bypassPermissions',
    tool_name: 'apply_patch',
    tool_input: { command: patchText },
    tool_use_id: 'call_DHHGzmcYvfXtIIYeL6gIhjxO',
  };
}

function makeMemory(overrides) {
  return Object.assign(
    {
      name: 'codex-mem',
      events: ['PreToolUse'],
      triggerPrompt: '',
      triggerPretool: [],
      triggerSession: false,
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// pretoolSpecMatches — the alias hop unit matrix
// ---------------------------------------------------------------------------

test('Edit spec matches an apply_patch event whose parsed target hits the pattern', () => {
  const blob = JSON.stringify({ command: DOTCLAUDE_PATCH });
  assert.equal(matcher.pretoolSpecMatches('Edit:\\.claude/', 'apply_patch', blob), true);
});

test('every Claude write-tool spec aliases onto apply_patch by target path', () => {
  const blob = JSON.stringify({ command: DOTCLAUDE_PATCH });
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(
      matcher.pretoolSpecMatches(`${tool}:\\.claude/`, 'apply_patch', blob),
      true,
      `${tool}: spec must alias onto apply_patch`
    );
  }
});

test('alias hop misses when no parsed target matches the pattern', () => {
  const blob = JSON.stringify({ command: DOTCLAUDE_PATCH });
  assert.equal(matcher.pretoolSpecMatches('Edit:^src/', 'apply_patch', blob), false);
});

test('bare Edit spec (no pattern) matches any apply_patch event', () => {
  const blob = JSON.stringify({ command: DOTCLAUDE_PATCH });
  assert.equal(matcher.pretoolSpecMatches('Edit', 'apply_patch', blob), true);
});

test('a multi-file patch matches when ANY target hits the pattern', () => {
  const multi =
    '*** Begin Patch\n*** Add File: src/index.js\n+x\n*** Update File: .claude/rules.md\n+y\n*** End Patch\n';
  const blob = JSON.stringify({ command: multi });
  assert.equal(matcher.pretoolSpecMatches('Edit:\\.claude/', 'apply_patch', blob), true);
});

test('a patterned spec fails closed on an unparseable patch payload', () => {
  const blob = JSON.stringify({ command: 'not a patch at all' });
  assert.equal(matcher.pretoolSpecMatches('Edit:\\.claude/', 'apply_patch', blob), false);
});

test('Bash: specs do NOT alias onto apply_patch (unchanged semantics)', () => {
  const blob = JSON.stringify({ command: DOTCLAUDE_PATCH });
  assert.equal(matcher.pretoolSpecMatches('Bash:\\.claude/', 'apply_patch', blob), false);
});

test('non-write tool specs (Read/Grep/Task) never alias onto apply_patch', () => {
  const blob = JSON.stringify({ command: DOTCLAUDE_PATCH });
  for (const spec of ['Read:\\.claude/', 'Grep:settings', 'Task:.*']) {
    assert.equal(matcher.pretoolSpecMatches(spec, 'apply_patch', blob), false, spec);
  }
});

test('claude byte-identity: Edit spec against a claude Edit payload is unchanged', () => {
  const blob = JSON.stringify({ file_path: '/repo/.claude/settings.json', new_string: 'x' });
  assert.equal(matcher.pretoolSpecMatches('Edit:\\.claude/', 'Edit', blob), true);
  assert.equal(matcher.pretoolSpecMatches('Edit:^src/', 'Edit', blob), false);
  assert.equal(
    matcher.pretoolSpecMatches('Bash:git', 'Bash', JSON.stringify({ command: 'git push' })),
    true
  );
});

// ---------------------------------------------------------------------------
// matchPreTool — end-to-end memory evaluation on the codex fixture shapes
// ---------------------------------------------------------------------------

test('an Edit:\\.claude/ memory fires on an apply_patch payload touching .claude/', () => {
  const memory = makeMemory({ triggerPretool: ['Edit:\\.claude/'] });
  const result = matcher.matchPreTool(memory, applyPatchPayload(DOTCLAUDE_PATCH));
  assert.equal(result.fired, true);
  assert.equal(result.matched.pretool_pattern, 'Edit:\\.claude/');
});

test('the checked-in probe apply_patch fixture fires a matching Write: memory', () => {
  const payload = codexFixture('pre-apply-patch.json');
  const memory = makeMemory({ triggerPretool: ['Write:created-by-patch'] });
  const result = matcher.matchPreTool(memory, payload);
  assert.equal(result.fired, true);
});

test('a Bash: memory stays silent on an apply_patch payload', () => {
  const memory = makeMemory({ triggerPretool: ['Bash:patch'] });
  const result = matcher.matchPreTool(memory, applyPatchPayload(DOTCLAUDE_PATCH));
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-pretool-match');
});

test('a Bash: memory fires on the codex Bash fixture (tool_name is Bash on both runtimes)', () => {
  const payload = codexFixture('pre-bash.json');
  const memory = makeMemory({ triggerPretool: ['Bash:'] });
  const result = matcher.matchPreTool(memory, payload);
  assert.equal(result.fired, true);
});

test('trigger_pretool_content matches the +lines of an apply_patch payload', () => {
  const memory = makeMemory({
    triggerPretool: ['Edit:'],
    triggerPretoolContent: ['hooks'],
  });
  const result = matcher.matchPreTool(memory, applyPatchPayload(DOTCLAUDE_PATCH));
  assert.equal(result.fired, true);
  assert.equal(result.matched.content_pattern, 'hooks');
  assert.equal(result.matched.content_substring, 'hooks');
});

test('trigger_pretool_content misses when the +lines do not contain the pattern', () => {
  const memory = makeMemory({
    triggerPretool: ['Edit:'],
    triggerPretoolContent: ['not-in-the-patch'],
  });
  const result = matcher.matchPreTool(memory, applyPatchPayload(DOTCLAUDE_PATCH));
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-content-match');
});

test('trigger_pretool_content_not suppresses an apply_patch content match', () => {
  const memory = makeMemory({
    triggerPretool: ['Edit:'],
    triggerPretoolContent: ['hooks'],
    triggerPretoolContentNot: ['hooks'],
  });
  const result = matcher.matchPreTool(memory, applyPatchPayload(DOTCLAUDE_PATCH));
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'negative-excludes');
});

test('exclude_pretool with a write-tool spec also aliases onto apply_patch', () => {
  const memory = makeMemory({
    triggerPretool: ['Edit:'],
    excludePretool: ['Edit:\\.claude/'],
  });
  const result = matcher.matchPreTool(memory, applyPatchPayload(DOTCLAUDE_PATCH));
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'exclude-matched');
  assert.equal(result.matched.excluded_pattern, 'Edit:\\.claude/');
});

test('extractPretoolContent returns null for a patch that adds no lines', () => {
  const del = '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch\n';
  assert.equal(extractPretoolContent('apply_patch', { command: del }), null);
});

// ---------------------------------------------------------------------------
// matchStop — codex last_assistant_message surface
// ---------------------------------------------------------------------------

test('a stop-trigger memory fires on the codex Stop fixture via last_assistant_message', () => {
  const payload = codexFixture('stop.json');
  const memory = makeMemory({ events: ['Stop'], triggerStopResponse: 'ready for review' });
  const result = matcher.matchStop(memory, payload);
  assert.equal(result.fired, true);
  assert.equal(result.matched.stop_response_substring, 'ready for review');
});

test('payload.response still wins over last_assistant_message (claude surface order)', () => {
  const memory = makeMemory({ events: ['Stop'], triggerStopResponse: 'ready for review' });
  const payload = { response: 'nothing to see', last_assistant_message: 'ready for review' };
  const result = matcher.matchStop(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-stop-response-match');
});

test('claude byte-identity: a Stop payload without the codex field behaves as before', () => {
  const memory = makeMemory({ events: ['Stop'], triggerStopResponse: 'done' });
  assert.equal(matcher.matchStop(memory, { response: 'all done' }).fired, true);
  assert.equal(matcher.matchStop(memory, {}).fired, false);
});

// ---------------------------------------------------------------------------
// matchPostTool — codex realshape (string tool_response, probe-verified P4)
// ---------------------------------------------------------------------------

test('a content-gated PostToolUse memory fires on the codex apply_patch realshape', () => {
  const payload = codexFixture('post-apply-patch.json');
  assert.equal(
    typeof payload.tool_response,
    'string',
    'probe shape: apply_patch response is a string'
  );
  const memory = makeMemory({
    events: ['PostToolUse'],
    triggerPretool: ['Write:created-by-patch'],
    triggerPosttoolContent: ['Exit code: 0'],
  });
  const result = matcher.matchPostTool(memory, payload);
  assert.equal(result.fired, true);
  assert.equal(result.matched.posttool_content_pattern, 'Exit code: 0');
});

test('a content-gated PostToolUse memory fires on the codex Bash realshape (string response)', () => {
  const payload = codexFixture('post-bash.json');
  const memory = makeMemory({
    events: ['PostToolUse'],
    triggerPretool: ['Bash:'],
    triggerPosttoolContent: ['.'],
  });
  const result = matcher.matchPostTool(memory, payload);
  assert.equal(result.fired, true);
});
