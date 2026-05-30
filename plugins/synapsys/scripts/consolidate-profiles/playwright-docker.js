'use strict';

// TODO: Implement the playwright-docker profile.
// Future direction: parse the repository Playwright + Docker runbook
// (e.g. `docs/playwright-docker.md`) into atomic items per operational
// concern (container start command, port mapping, network mode,
// `--ipc=host` requirement, video/trace artifact paths) and emit one
// synapsys memory per concern that fires on PreToolUse for Bash
// commands invoking `playwright`, `docker run`, or edits to
// `playwright.config.{ts,js}` / Dockerfile / compose files. Content
// matchers should target the specific command fragment about to be
// authored so the reminder is surgical.

module.exports = {
  name: 'playwright-docker',
  description: 'Stub profile for the Playwright + Docker runbook (not yet implemented).',
  sources: [],
  parse(_text, _sourcePath) {
    return [];
  },
  toMemory(_item, _ctx) {
    return null;
  },
};
