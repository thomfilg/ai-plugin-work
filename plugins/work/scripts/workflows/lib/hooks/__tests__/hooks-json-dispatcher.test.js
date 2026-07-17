'use strict';

/**
 * Guard test for the reminder-dispatcher registration in
 * plugins/work/hooks/hooks.json. Asserts:
 *   - hooks.json parses as valid JSON;
 *   - exactly ONE UserPromptSubmit hook invokes reminder-dispatcher.js
 *     (one process per prompt, regardless of manifest entry count);
 *   - it uses direct `node ${CLAUDE_PLUGIN_ROOT}/...` invocation (no `sh -c`);
 *   - the existing /work router entry (work-hook.js) is preserved.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOOKS_JSON = path.resolve(__dirname, '..', '..', '..', '..', '..', 'hooks', 'hooks.json');

function loadHooks() {
  return JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
}

function allUpsCommands(cfg) {
  const groups = cfg.hooks.UserPromptSubmit || [];
  return groups.flatMap((g) => (g.hooks || []).map((h) => h.command || ''));
}

describe('hooks.json reminder-dispatcher registration', () => {
  it('parses as valid JSON', () => {
    assert.doesNotThrow(loadHooks);
  });

  it('registers reminder-dispatcher.js exactly once under UserPromptSubmit', () => {
    const cmds = allUpsCommands(loadHooks());
    const hits = cmds.filter((c) => c.includes('reminder-dispatcher.js'));
    assert.equal(hits.length, 1);
  });

  it('invokes the dispatcher via direct node, not sh -c', () => {
    const cmd = allUpsCommands(loadHooks()).find((c) => c.includes('reminder-dispatcher.js'));
    assert.ok(cmd);
    assert.match(
      cmd,
      /node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/workflows\/lib\/hooks\/reminder-dispatcher\.js/
    );
    assert.doesNotMatch(cmd, /sh\s+-c/);
  });

  it('preserves the /work router entry', () => {
    const cfg = loadHooks();
    const groups = cfg.hooks.UserPromptSubmit || [];
    const router = groups.find((g) => g.matcher === '^\\s*/work\\s+');
    assert.ok(router, 'router entry missing');
    assert.ok((router.hooks || []).some((h) => (h.command || '').includes('work-hook.js')));
  });
});
