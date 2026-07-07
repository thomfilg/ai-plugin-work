/**
 * Tests for factories/runtime/emit.js — channel matrix, the C16
 * allow+updatedInput pairing, empty-stderr padding, and process-exit behavior
 * (exercised via spawned node processes, entrypoint-style).
 *
 * Run: node --test factories/runtime/__tests__/emit.spec.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const {
  contextChannel,
  renderContext,
  renderUpdatedCommand,
  pad,
  EMPTY_REASON_PAD,
} = require('../emit');

const EMIT_PATH = require.resolve('../emit');

function runEmit(expr) {
  const script = `const emit = require(${JSON.stringify(EMIT_PATH)}); ${expr}`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

describe('contextChannel matrix', () => {
  const rows = [
    ['claude', 'UserPromptSubmit', 'stdout'],
    ['claude', 'SessionStart', 'stdout'],
    ['claude', 'PreToolUse', 'stdout'],
    ['claude', 'PostToolUse', 'stdout'],
    ['claude', 'Stop', 'stdout'],
    ['codex', 'UserPromptSubmit', 'stdout'],
    ['codex', 'SessionStart', 'stdout'],
    ['codex', 'SubagentStart', 'stdout'],
    ['codex', 'PreToolUse', 'envelope'],
    ['codex', 'PostToolUse', 'envelope'],
    ['codex', 'Stop', 'suppressed'],
    ['codex', 'SubagentStop', 'suppressed'],
  ];
  for (const [runtime, event, expected] of rows) {
    it(`${runtime}/${event} → ${expected}`, () => {
      assert.equal(contextChannel(runtime, event), expected);
    });
  }
});

describe('renderContext', () => {
  it('claude PostToolUse output is the plain text console.log would print', () => {
    assert.deepEqual(renderContext('claude', 'PostToolUse', 'BANNER'), {
      channel: 'stdout',
      output: 'BANNER\n',
    });
  });

  it('codex PostToolUse wraps the identical text in the additionalContext envelope', () => {
    const rendered = renderContext('codex', 'PostToolUse', 'BANNER');
    assert.equal(rendered.channel, 'envelope');
    assert.deepEqual(JSON.parse(rendered.output), {
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'BANNER' },
    });
  });

  it('codex Stop is suppressed (no codex channel for Stop context)', () => {
    assert.deepEqual(renderContext('codex', 'Stop', 'info'), { channel: 'suppressed', output: '' });
  });
});

describe('renderUpdatedCommand — C16 per-runtime pairing', () => {
  it("claude bytes are exactly today's heimdall emission (bare updatedInput)", () => {
    assert.equal(
      renderUpdatedCommand('claude', 'LD_PRELOAD=/g.so cmd', 'why'),
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"LD_PRELOAD=/g.so cmd"}}}'
    );
  });

  it('codex pairs allow + non-empty reason + updatedInput (the ONLY accepted form)', () => {
    const parsed = JSON.parse(renderUpdatedCommand('codex', 'CMD', 'guarded'));
    assert.deepEqual(parsed.hookSpecificOutput, {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'guarded',
      updatedInput: { command: 'CMD' },
    });
  });

  it('codex empty reason is padded (empty reason ⇒ hook Failed on codex)', () => {
    const parsed = JSON.parse(renderUpdatedCommand('codex', 'CMD', ''));
    assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, EMPTY_REASON_PAD);
  });
});

describe('pad', () => {
  it('pads empty/whitespace/null reasons and passes real ones through', () => {
    assert.equal(pad(''), EMPTY_REASON_PAD);
    assert.equal(pad('   '), EMPTY_REASON_PAD);
    assert.equal(pad(null), EMPTY_REASON_PAD);
    assert.equal(pad('real reason'), 'real reason');
  });
});

describe('process behavior (spawned)', () => {
  it('block: exit 2 with the reason on stderr', () => {
    const res = runEmit("emit.createEmit('claude').block('NOPE: locked');");
    assert.equal(res.status, 2);
    assert.equal(res.stderr, 'NOPE: locked');
    assert.equal(res.stdout, '');
  });

  it('block with an empty reason still writes non-empty stderr (codex fail-open guard)', () => {
    const res = runEmit("emit.createEmit('codex').block('');");
    assert.equal(res.status, 2);
    assert.equal(res.stderr, EMPTY_REASON_PAD);
  });

  it('deny: exit 0 with the synapsys emitDeny JSON shape on stdout', () => {
    const res = runEmit("emit.createEmit('claude').deny('not allowed');");
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'not allowed',
      },
    });
  });

  it('stopContinue: exit 0 with the decision:block JSON (valid on both runtimes)', () => {
    const res = runEmit("emit.createEmit('codex').stopContinue('keep going');");
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.stdout), { decision: 'block', reason: 'keep going' });
  });

  it('silent: exit 0, zero output', () => {
    const res = runEmit("emit.createEmit('claude').silent();");
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, '');
  });

  it('context does not exit; codex Stop writes nothing, claude Stop prints', () => {
    const codex = runEmit(
      "emit.createEmit('codex').context('Stop', 'note'); console.error('alive');"
    );
    assert.equal(codex.status, 0);
    assert.equal(codex.stdout, '');
    assert.equal(codex.stderr, 'alive\n');
    const claude = runEmit("emit.createEmit('claude').context('Stop', 'note');");
    assert.equal(claude.stdout, 'note\n');
  });
});
