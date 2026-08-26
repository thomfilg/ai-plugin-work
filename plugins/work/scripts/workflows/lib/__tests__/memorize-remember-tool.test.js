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

  // The phases are no longer copies of one another: they delegate to
  // `lib/memory-record.js`, which builds the instruction text once. So the
  // guard follows the delegation instead of demanding the literal in every
  // file — and pins it in the shared module, where a regression would now hit
  // all of them at once rather than one copy at a time.
  it('names the remember tool in the shared instruction builder', () => {
    const shared = fs.readFileSync(path.join(WORKFLOWS_DIR, 'lib', 'memory-record.js'), 'utf8');
    assert.match(shared, /rememberTool/, 'the shared builder must name the tool to call');
  });

  it('every phase mentioning a memory plugin either names the tool or delegates', () => {
    for (const file of memorizePhases()) {
      const src = fs.readFileSync(file, 'utf8');
      if (!/memory/.test(src)) continue;
      const namesTool = /rememberTool/.test(src);
      const delegates = /require\([^)]*memory-record[^)]*\)/.test(src);
      assert.ok(
        namesTool || delegates,
        `${path.relative(WORKFLOWS_DIR, file)} should tell the agent which tool to call, ` +
          'or delegate to lib/memory-record.js which does'
      );
    }
  });
});
