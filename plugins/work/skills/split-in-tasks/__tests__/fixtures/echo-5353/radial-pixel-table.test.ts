// Fixture for ECHO-5353 Pass C regression.
//
// This file is intentionally NOT in any task's `Files in scope` in the
// sibling tasks.md fixture. It contains an `it.skip(...)` call that
// violates the `no-test-focus` lint rule recorded in eslint-output.json.
// Pass C must surface this as a SPLIT-WARNING citing the file, line,
// rule, and the three resolution options.
//
// NOTE: This file lives under __tests__/fixtures/ and is excluded from
// the real test runner via the fixtures path filter — it is a data
// artifact, not an executable test.

import { describe, it } from 'node:test';

describe('radial-pixel-table', () => {
  it.skip('renders the radial pixel grid (skipped — pending design review)', () => {
    // intentionally skipped — triggers `no-test-focus` rule
  });
});
