/**
 * Tests for factories/runtime/tools.js — canonical tool kinds, the
 * apply_patch parser (add/update/delete/move + unparseable), write-target and
 * write-content extraction, and matchesToolSpec's Edit→apply_patch alias hop.
 *
 * Run: node --test factories/runtime/__tests__/tools.spec.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalToolKind,
  parseApplyPatch,
  extractWriteTargets,
  extractWriteContent,
  matchesToolSpec,
  parseToolSpec,
  safeRegex,
} = require('../tools');
const { normalizeHookPayload } = require('../payload');

const FIXTURES = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'runtime');

describe('canonicalToolKind', () => {
  const table = [
    ['Bash', 'claude', 'shell'],
    ['Bash', 'codex', 'shell'],
    ['Edit', 'claude', 'write'],
    ['Write', 'claude', 'write'],
    ['MultiEdit', 'claude', 'write'],
    ['NotebookEdit', 'claude', 'write'],
    ['apply_patch', 'codex', 'write'],
    ['Task', 'claude', 'agent'],
    ['spawn_agent', 'codex', 'agent'],
    ['Skill', 'claude', 'skill'],
    ['AskUserQuestion', 'claude', 'question'],
    ['request_user_input', 'codex', 'question'],
    ['TodoWrite', 'claude', 'plan'],
    ['update_plan', 'codex', 'plan'],
    ['mcp__memory__read_graph', 'claude', 'mcp'],
    ['mcp__filesystem__read', 'codex', 'mcp'],
    ['Read', 'claude', 'read'],
    ['Grep', 'claude', 'read'],
    ['Glob', 'claude', 'read'],
    ['view_image', 'codex', 'read'],
    ['read_mcp_resource', 'codex', 'read'],
    ['web_search', 'codex', 'other'],
    ['SomethingNew', 'claude', 'other'],
  ];
  for (const [name, runtime, expected] of table) {
    it(`${name} (${runtime}) → ${expected}`, () => {
      assert.equal(canonicalToolKind(name, runtime), expected);
    });
  }

  it('missing name → null', () => {
    assert.equal(canonicalToolKind(null, 'claude'), null);
    assert.equal(canonicalToolKind('', 'codex'), null);
  });
});

describe('parseApplyPatch', () => {
  it('Add File', () => {
    const patch = '*** Begin Patch\n*** Add File: a/new.txt\n+hello\n*** End Patch\n';
    assert.deepEqual(parseApplyPatch(patch), [{ path: 'a/new.txt', op: 'create', ok: true }]);
  });

  it('Update File', () => {
    const patch = '*** Begin Patch\n*** Update File: src/x.js\n@@\n-old\n+new\n*** End Patch\n';
    assert.deepEqual(parseApplyPatch(patch), [{ path: 'src/x.js', op: 'modify', ok: true }]);
  });

  it('Delete File', () => {
    const patch = '*** Begin Patch\n*** Delete File: junk.txt\n*** End Patch\n';
    assert.deepEqual(parseApplyPatch(patch), [{ path: 'junk.txt', op: 'delete', ok: true }]);
  });

  it('Move to: both source and destination become targets', () => {
    const patch =
      '*** Begin Patch\n*** Update File: old/name.js\n*** Move to: new/name.js\n@@\n-a\n+b\n*** End Patch\n';
    assert.deepEqual(parseApplyPatch(patch), [
      { path: 'old/name.js', op: 'move', ok: true },
      { path: 'new/name.js', op: 'move', ok: true },
    ]);
  });

  it('multi-file patch yields every target', () => {
    const patch =
      '*** Begin Patch\n*** Add File: a.txt\n+1\n*** Update File: b.txt\n@@\n+2\n*** Delete File: c.txt\n*** End Patch\n';
    assert.deepEqual(
      parseApplyPatch(patch).map((t) => t.path),
      ['a.txt', 'b.txt', 'c.txt']
    );
  });

  it('missing Begin Patch sentinel → single ok:false target (fail-closed signal)', () => {
    assert.deepEqual(parseApplyPatch('not a patch at all'), [{ path: null, op: null, ok: false }]);
    assert.deepEqual(parseApplyPatch(undefined), [{ path: null, op: null, ok: false }]);
  });

  it('sentinel but zero file headers → ok:false', () => {
    assert.deepEqual(parseApplyPatch('*** Begin Patch\n+orphan\n*** End Patch\n'), [
      { path: null, op: null, ok: false },
    ]);
  });

  it('parses the live probe apply_patch fixture', () => {
    const payload = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, 'codex', 'pre-apply-patch.json'), 'utf8')
    );
    assert.deepEqual(parseApplyPatch(payload.tool_input.command), [
      { path: 'created-by-patch.txt', op: 'create', ok: true },
    ]);
  });
});

describe('extractWriteTargets', () => {
  it('non-write tools yield no targets', () => {
    assert.deepEqual(extractWriteTargets('Bash', { command: 'rm -rf /' }, 'claude'), []);
    assert.deepEqual(extractWriteTargets('Task', {}, 'claude'), []);
  });

  it('claude Write/Edit read file_path; NotebookEdit reads notebook_path', () => {
    assert.deepEqual(
      extractWriteTargets('Write', { file_path: '/a.txt', content: 'x' }, 'claude'),
      [{ path: '/a.txt', op: 'create', ok: true }]
    );
    assert.deepEqual(extractWriteTargets('NotebookEdit', { notebook_path: '/n.ipynb' }, 'claude'), [
      { path: '/n.ipynb', op: 'modify', ok: true },
    ]);
  });

  it('write tool with a missing path is an ok:false target', () => {
    assert.deepEqual(extractWriteTargets('Edit', {}, 'claude'), [
      { path: null, op: 'modify', ok: false },
    ]);
  });

  it('apply_patch routes through the patch parser', () => {
    const input = { command: '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch\n' };
    assert.deepEqual(extractWriteTargets('apply_patch', input, 'codex'), [
      { path: 'gone.txt', op: 'delete', ok: true },
    ]);
  });
});

describe('extractWriteContent', () => {
  it('claude field extractors', () => {
    assert.deepEqual(extractWriteContent('Edit', { new_string: 'abc' }), ['abc']);
    assert.deepEqual(extractWriteContent('Write', { content: 'body' }), ['body']);
    assert.deepEqual(
      extractWriteContent('MultiEdit', { edits: [{ new_string: 'a' }, {}, { new_string: 'b' }] }),
      ['a', 'b']
    );
    assert.deepEqual(extractWriteContent('NotebookEdit', { new_source: 'cell' }), ['cell']);
  });

  it("apply_patch: the '+'-prefixed lines", () => {
    const input = {
      command: '*** Begin Patch\n*** Add File: a.txt\n+line one\n+line two\n*** End Patch\n',
    };
    assert.deepEqual(extractWriteContent('apply_patch', input), ['line one', 'line two']);
  });

  it('unknown tools and bad input yield []', () => {
    assert.deepEqual(extractWriteContent('Bash', { command: 'x' }), []);
    assert.deepEqual(extractWriteContent('Edit', null), []);
  });
});

describe('matchesToolSpec', () => {
  const applyPatchEvt = normalizeHookPayload(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Update File: .claude/settings.json\n+x\n*** End Patch\n',
      },
    },
    { runtime: 'codex' }
  );

  it('native exact-tool + regex-over-input semantics (synapsys parity)', () => {
    const bashEvt = normalizeHookPayload(
      { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
      { runtime: 'claude', event: 'PreToolUse' }
    );
    assert.equal(matchesToolSpec('Bash:git\\s+commit', bashEvt), true);
    assert.equal(matchesToolSpec('Bash:gh pr create', bashEvt), false);
    assert.equal(matchesToolSpec('Bash', bashEvt), true);
    assert.equal(matchesToolSpec('*:git', bashEvt), true);
  });

  it('alias hop: Edit spec matches apply_patch by parsed target path', () => {
    assert.equal(matchesToolSpec('Edit:\\.claude/', applyPatchEvt), true);
    assert.equal(matchesToolSpec('Write:\\.claude/', applyPatchEvt), true);
    assert.equal(matchesToolSpec('Edit:\\.heimdall/', applyPatchEvt), false);
    assert.equal(matchesToolSpec('Edit', applyPatchEvt), true);
  });

  it('non-write specs never alias to apply_patch', () => {
    assert.equal(matchesToolSpec('Task:.*', applyPatchEvt), false);
    assert.equal(matchesToolSpec('Bash:.*', applyPatchEvt), false);
  });

  it('invalid pattern regex never matches', () => {
    assert.equal(matchesToolSpec('Edit:[', applyPatchEvt), false);
  });

  it('parseToolSpec splits on the FIRST colon (synapsys parity)', () => {
    assert.deepEqual(parseToolSpec('Edit:\\.claude/:x'), { tool: 'Edit', pat: '\\.claude/:x' });
    assert.deepEqual(parseToolSpec('Bash'), { tool: 'Bash', pat: '' });
    assert.deepEqual(parseToolSpec(undefined), { tool: '', pat: '' });
  });

  it('safeRegex returns null on invalid patterns', () => {
    assert.ok(safeRegex('git\\s+commit') instanceof RegExp);
    assert.equal(safeRegex('['), null);
  });
});
