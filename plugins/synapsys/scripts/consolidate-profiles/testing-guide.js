'use strict';

// TODO: Implement the testing-guide profile.
// Future direction: parse the repository testing guide (e.g.
// `docs/testing-guide.md`) into atomic items per testing convention
// (selectors, waits, mocking rules, fixture patterns) and emit one
// synapsys memory per convention that fires on PreToolUse for
// Edit/Write of `*.test.{ts,tsx,js}` and Playwright spec files.
// Content matchers should target the anti-pattern (e.g. `getByRole`,
// `\.first\(\)`, hardcoded `setTimeout`) so the agent is reminded only
// when about to introduce the violation.

module.exports = {
  name: 'testing-guide',
  description: 'Stub profile for the repository testing guide (not yet implemented).',
  sources: [],
  parse(_text, _sourcePath) {
    return [];
  },
  toMemory(_item, _ctx) {
    return null;
  },
};
