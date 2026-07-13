'use strict';

/**
 * Dual-runtime unit tests for the shared lib/auto-advance.js emission helpers
 * (WP-06): printInstruction claude bytes are pinned to the pre-port
 * console.log sequence; codex output is the PostToolUse additionalContext
 * envelope; the runOrchestrator failure warning follows the same channel
 * matrix. Helpers are exercised in spawned child processes because
 * rt.emit.context writes to the real stdout.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const LIB = path.resolve(__dirname, '..', 'auto-advance.js');

const BANNERS = {
  execute: ['═══ FOLLOW-UP2: NEXT STEP ═══', '══════════════════════════════'],
  surface: ['═══ FOLLOW-UP2: SURFACE ═══', '═══════════════════════════'],
};
const INSTRUCTION = { action: 'execute', step: 'monitor' };

function runInChild(expr, runtime) {
  const script = `const lib = require(${JSON.stringify(LIB)}); ${expr}`;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_RUNTIME: runtime },
  });
}

describe('printInstruction — channel matrix', () => {
  const printExpr = `lib.printInstruction(${JSON.stringify(INSTRUCTION)}, ${JSON.stringify(
    BANNERS
  )});`;

  it('claude: bytes match the pre-port console.log sequence exactly', () => {
    const r = runInChild(printExpr, 'claude');
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      `\n═══ FOLLOW-UP2: NEXT STEP ═══\n${JSON.stringify(
        INSTRUCTION,
        null,
        2
      )}\n══════════════════════════════\n\n`
    );
  });

  it('codex: same text inside the additionalContext envelope', () => {
    const r = runInChild(printExpr, 'codex');
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    const claude = runInChild(printExpr, 'claude');
    assert.equal(`${parsed.hookSpecificOutput.additionalContext}\n`, claude.stdout);
  });

  it('surface extra line renders between banner and instruction (claude bytes)', () => {
    const instr = { action: 'surface', payload: { reason: 'infra-stuck' } };
    const expr = `lib.printInstruction(${JSON.stringify(instr)}, ${JSON.stringify(
      BANNERS
    )}, (i) => 'reason: ' + i.payload.reason);`;
    const r = runInChild(expr, 'claude');
    assert.equal(
      r.stdout,
      `\n═══ FOLLOW-UP2: SURFACE ═══\nreason: infra-stuck\n${JSON.stringify(
        instr,
        null,
        2
      )}\n═══════════════════════════\n\n`
    );
  });

  it('unknown action prints nothing on either runtime', () => {
    const expr = `lib.printInstruction({ action: 'mystery' }, ${JSON.stringify(BANNERS)});`;
    for (const runtime of ['claude', 'codex']) {
      assert.equal(runInChild(expr, runtime).stdout, '');
    }
  });
});

describe('runOrchestrator failure warning — channel matrix', () => {
  const expr = `lib.runOrchestrator('/nonexistent/orchestrator.js', 'AAA-1', 1000);`;

  it('claude: warning bytes match the pre-port console.log line', () => {
    const r = runInChild(expr, 'claude');
    assert.equal(r.status, 0);
    assert.match(
      r.stdout,
      /^\n⚠ \[auto-advance\] orchestrator failed: .* — workflow did NOT advance\. Re-run `node \/nonexistent\/orchestrator\.js AAA-1` to continue\.\n\n$/s
    );
  });

  it('codex: warning rides the additionalContext envelope', () => {
    const r = runInChild(expr, 'codex');
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /workflow did NOT advance/);
  });
});
