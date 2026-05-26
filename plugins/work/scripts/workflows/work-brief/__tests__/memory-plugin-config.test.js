/**
 * Tests for lib/memory-plugin-config.js
 *
 * Run: node --test ./scripts/workflows/work-brief/__tests__/memory-plugin-config.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  loadMemoryPluginCandidates,
  DEFAULT_CANDIDATES,
  DEFAULT_MANIFEST_GLOB,
} = require('../lib/memory-plugin-config');

describe('memory-plugin-config — env-driven detection list', () => {
  it('default env returns built-in cortex + mem0 candidates', () => {
    const list = loadMemoryPluginCandidates({});
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'cortex');
    assert.equal(list[1].name, 'mem0');
    assert.ok(list[0].probe instanceof RegExp);
    assert.equal(list[0].recallTool, DEFAULT_CANDIDATES[0].recallTool);
  });

  it('BRIEF_MEMORY_DISABLED=1 returns []', () => {
    assert.deepEqual(loadMemoryPluginCandidates({ BRIEF_MEMORY_DISABLED: '1' }), []);
    assert.deepEqual(loadMemoryPluginCandidates({ BRIEF_MEMORY_DISABLED: 'true' }), []);
    assert.deepEqual(loadMemoryPluginCandidates({ BRIEF_MEMORY_DISABLED: 'yes' }), []);
  });

  it('BRIEF_MEMORY_DISABLED falsy values do NOT disable', () => {
    assert.equal(loadMemoryPluginCandidates({ BRIEF_MEMORY_DISABLED: '' }).length, 2);
    assert.equal(loadMemoryPluginCandidates({ BRIEF_MEMORY_DISABLED: '0' }).length, 2);
  });

  it('BRIEF_MEMORY_PLUGIN_DIRS overrides manifest glob for built-in candidates', () => {
    const list = loadMemoryPluginCandidates({
      BRIEF_MEMORY_PLUGIN_DIRS: 'custom/dir1:custom/dir2',
    });
    assert.deepEqual(list[0].manifestGlob, ['custom/dir1', 'custom/dir2']);
    assert.deepEqual(list[1].manifestGlob, ['custom/dir1', 'custom/dir2']);
  });

  it('per-plugin tool overrides apply to recall/remember/save', () => {
    const list = loadMemoryPluginCandidates({
      BRIEF_MEMORY_CORTEX_RECALL_TOOL: 'my_recall',
      BRIEF_MEMORY_CORTEX_REMEMBER_TOOL: 'my_remember',
      BRIEF_MEMORY_CORTEX_SAVE_TOOL: 'my_save',
    });
    const cortex = list.find((c) => c.name === 'cortex');
    assert.equal(cortex.recallTool, 'my_recall');
    assert.equal(cortex.rememberTool, 'my_remember');
    assert.equal(cortex.saveTool, 'my_save');
    // mem0 untouched
    const mem0 = list.find((c) => c.name === 'mem0');
    assert.equal(mem0.rememberTool, DEFAULT_CANDIDATES[1].rememberTool);
  });

  it('BRIEF_MEMORY_<NAME>_SAVE_TOOL=none clears saveTool', () => {
    const list = loadMemoryPluginCandidates({
      BRIEF_MEMORY_CORTEX_SAVE_TOOL: 'none',
    });
    assert.equal(list.find((c) => c.name === 'cortex').saveTool, null);
  });

  it('BRIEF_MEMORY_PLUGINS_JSON fully replaces defaults', () => {
    const customJson = JSON.stringify([
      {
        name: 'mythril',
        probe: 'mythril|myth',
        recallTool: 'myth_recall',
        rememberTool: 'myth_remember',
        saveTool: 'myth_save',
      },
    ]);
    const list = loadMemoryPluginCandidates({ BRIEF_MEMORY_PLUGINS_JSON: customJson });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'mythril');
    assert.ok(list[0].probe instanceof RegExp);
    assert.ok(list[0].probe.test('mythril-plugin-v1'));
    assert.equal(list[0].recallTool, 'myth_recall');
    assert.deepEqual(list[0].manifestGlob, DEFAULT_MANIFEST_GLOB);
  });

  it('BRIEF_MEMORY_PLUGINS_JSON respects per-entry manifestGlob', () => {
    const customJson = JSON.stringify([
      {
        name: 'x',
        probe: 'x',
        recallTool: 'r',
        rememberTool: 'rm',
        manifestGlob: ['custom/x'],
      },
    ]);
    const list = loadMemoryPluginCandidates({ BRIEF_MEMORY_PLUGINS_JSON: customJson });
    assert.deepEqual(list[0].manifestGlob, ['custom/x']);
  });

  it('invalid BRIEF_MEMORY_PLUGINS_JSON (not array) falls back to defaults', () => {
    // Suppress stderr in test.
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      const list = loadMemoryPluginCandidates({ BRIEF_MEMORY_PLUGINS_JSON: '{"name":"oops"}' });
      assert.equal(list.length, 2);
      assert.equal(list[0].name, 'cortex');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('invalid BRIEF_MEMORY_PLUGINS_JSON (bad JSON) falls back to defaults', () => {
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      const list = loadMemoryPluginCandidates({ BRIEF_MEMORY_PLUGINS_JSON: 'not json' });
      assert.equal(list.length, 2);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('BRIEF_MEMORY_PLUGINS_JSON entry missing required fields is skipped', () => {
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      const customJson = JSON.stringify([
        { name: 'incomplete', probe: 'x' }, // missing recallTool/rememberTool
        { name: 'good', probe: 'good', recallTool: 'r', rememberTool: 'rm' },
      ]);
      const list = loadMemoryPluginCandidates({ BRIEF_MEMORY_PLUGINS_JSON: customJson });
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'good');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('default candidates remain frozen — load does not mutate them', () => {
    const list = loadMemoryPluginCandidates({
      BRIEF_MEMORY_CORTEX_RECALL_TOOL: 'override',
      BRIEF_MEMORY_PLUGIN_DIRS: 'x:y',
    });
    assert.equal(list[0].recallTool, 'override');
    // Re-load WITHOUT env overrides: must still be the original defaults.
    const fresh = loadMemoryPluginCandidates({});
    assert.equal(fresh[0].recallTool, DEFAULT_CANDIDATES[0].recallTool);
    assert.deepEqual(fresh[0].manifestGlob, DEFAULT_MANIFEST_GLOB);
  });
});
