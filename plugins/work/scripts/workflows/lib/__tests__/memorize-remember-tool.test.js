'use strict';

/**
 * memorize-remember-tool.test.js
 *
 * The memory-plugin descriptor exposes `rememberTool` (see
 * work-brief/lib/memory-plugin-config.js — cortex/mem0 candidates and the
 * BRIEF_MEMORY_PLUGINS_JSON contract both name it). Two memorize phases
 * interpolated `ctx.memory.remember`, which is not a property: the agent was
 * told to "Call `undefined` with the review verdict", an instruction it cannot
 * follow, in the one phase whose whole job is to persist decisions.
 *
 * A grep guard rather than a per-file assertion: the phases are copies of one
 * another, so the next copy inherits whatever the last one did.
 *
 * Run: node --test workflows/lib/__tests__/memorize-remember-tool.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.resolve(__dirname, '..', '..');

/** Every workflow's memorize phase module. */
function memorizePhases() {
  return fs
    .readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(WORKFLOWS_DIR, e.name, 'lib', 'phases', 'memorize.js'))
    .filter((p) => fs.existsSync(p));
}

describe('memorize phases: memory tool property', () => {
  it('finds the memorize phases (guard is not vacuous)', () => {
    assert.ok(memorizePhases().length >= 8, 'expected the memorize phase family');
  });

  it('never reads `remember` off the memory descriptor', () => {
    const offenders = memorizePhases().filter((file) =>
      /\bmemory\s*\.\s*remember\b(?!Tool)/.test(fs.readFileSync(file, 'utf8'))
    );
    assert.deepEqual(
      offenders.map((f) => path.relative(WORKFLOWS_DIR, f)),
      [],
      'the descriptor property is `rememberTool`; `remember` renders as undefined'
    );
  });

  it('names the remember tool in every phase that mentions a memory plugin', () => {
    for (const file of memorizePhases()) {
      const src = fs.readFileSync(file, 'utf8');
      if (!/memory/.test(src)) continue;
      assert.match(
        src,
        /rememberTool/,
        `${path.relative(WORKFLOWS_DIR, file)} should tell the agent which tool to call`
      );
    }
  });
});
