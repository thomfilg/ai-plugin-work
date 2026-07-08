'use strict';

/**
 * testing-guide profile (stub — GH-442 P0 #5).
 *
 * TODO: implement once a reference `packages/testing/guide.md` doc is
 * identified. Future direction: parse per-tool-kind testing guidance
 * (vitest unit, playwright e2e, integration harness) into PreToolUse
 * memories that fire when the agent is about to write a test file
 * matching the relevant runner.
 */

function parse(/* text, sourcePath */) {
  return [];
}

function toMemory(/* item, ctx */) {
  return null;
}

module.exports = {
  name: 'testing-guide',
  description:
    'Stub — future profile for packages/testing/guide.md. Currently emits zero memories.',
  sources: ['packages/testing/guide.md'],
  parse,
  toMemory,
};
