'use strict';

/**
 * playwright-docker profile (stub — GH-442 P0 #5).
 *
 * TODO: implement once a reference `docs/playwright-docker.md` doc is
 * identified. Future direction: parse Playwright-in-Docker invocation
 * conventions (compose service, env vars, traces path) into PreToolUse
 * memories that fire when the agent is about to write a docker-compose
 * or Playwright config touching the test runner image.
 */

function parse(/* text, sourcePath */) {
  return [];
}

function toMemory(/* item, ctx */) {
  return null;
}

module.exports = {
  name: 'playwright-docker',
  description:
    'Stub — future profile for docs/playwright-docker.md. Currently emits zero memories.',
  sources: ['docs/playwright-docker.md'],
  parse,
  toMemory,
};
