/**
 * Tests for workflows/work/lib/parse-gherkin.js
 *
 * Pure-logic Gherkin parser for spec.md Test Scenarios sections.
 * No I/O, no side effects.
 *
 * Run: node --test workflows/work/lib/__tests__/parse-gherkin.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parse,
  validate,
  hasSkipOverride,
  parseRaw,
  DEFAULT_MIN_SCENARIOS,
  DEFAULT_REQUIRED_TAGS,
} = require('../parse-gherkin');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURE_WELL_FORMED = `# Spec

## Test Scenarios (Gherkin)

Feature: User login
  @integration
  Scenario: Successful login with valid credentials
    Given a registered user with email "test@example.com"
    When the user submits valid credentials
    Then the user is redirected to the dashboard
    And a session token is issued

  @unit
  Scenario: Failed login with invalid password
    Given a registered user with email "test@example.com"
    When the user submits an invalid password
    Then an error message is displayed
    But the account is not locked

Feature: Password reset
  @e2e
  Scenario: Request password reset email
    Given a registered user
    When the user requests a password reset
    Then a reset email is sent

## Implementation Notes

Some notes here.
`;

const FIXTURE_MISSING_SECTION = `# Spec

## Requirements

- Requirement 1
- Requirement 2

## Implementation Notes

Some notes.
`;

const FIXTURE_LEGACY_FREE_TEXT = `# Spec

## Test Scenarios

- Test that the user can log in
- Test that the API returns 200
- Verify error handling works

## Other
`;

const FIXTURE_MALFORMED_NO_STEPS = `# Spec

## Test Scenarios (Gherkin)

Feature: Broken feature
  @integration
  Scenario: Scenario with no steps

  Scenario: Another scenario with no steps

  Scenario: Valid scenario
    Given something
    When something happens
    Then something is true
`;

const FIXTURE_MULTIPLE_TAGS = `# Spec

## Test Scenarios (Gherkin)

Feature: Multi-tag feature
  @integration @e2e
  Scenario: Has multiple tags
    Given a setup
    When action occurs
    Then result is correct

  @unit
  Scenario: Unit scenario
    Given unit setup
    When unit action
    Then unit result
`;

const FIXTURE_WITH_SKIP = `# Spec

<!-- gherkin-skip: config-only change -->

## Test Scenarios (Gherkin)

Feature: Something
  Scenario: A test
    Given x
    When y
    Then z
`;

const FIXTURE_WITH_BARE_SKIP = `# Spec

<!-- gherkin-skip -->

## Test Scenarios (Gherkin)

Feature: Something
  Scenario: A test
    Given x
    When y
    Then z
`;

const FIXTURE_WITH_MULTIPLE_SKIPS = `# Spec

<!-- gherkin-skip: first reason -->
<!-- gherkin-skip: second reason -->

## Summary
`;

const FIXTURE_ALTERNATE_HEADING = `# Spec

## Test Scenarios

Feature: Login
  @integration
  Scenario: Basic login
    Given a user
    When they log in
    Then they see the dashboard
`;

const FIXTURE_BUT_KEYWORD = `# Spec

## Test Scenarios (Gherkin)

Feature: Edge cases
  @integration
  Scenario: With But keyword
    Given initial state
    When action performed
    Then expected outcome
    But not this outcome
    And also this
`;

// ─── parse() ────────────────────────────────────────────────────────────────

describe('parse-gherkin: parse', () => {
  it('parses well-formed Gherkin with multiple features and scenarios', () => {
    const result = parse(FIXTURE_WELL_FORMED);
    assert.deepEqual(result.errors, []);
    assert.equal(result.features.length, 2);

    const [login, reset] = result.features;
    assert.equal(login.name, 'User login');
    assert.equal(login.scenarios.length, 2);
    assert.equal(reset.name, 'Password reset');
    assert.equal(reset.scenarios.length, 1);
  });

  it('extracts scenario names correctly', () => {
    const result = parse(FIXTURE_WELL_FORMED);
    const scenarios = result.features[0].scenarios;
    assert.equal(scenarios[0].name, 'Successful login with valid credentials');
    assert.equal(scenarios[1].name, 'Failed login with invalid password');
  });

  it('extracts steps with correct keywords', () => {
    const result = parse(FIXTURE_WELL_FORMED);
    const steps = result.features[0].scenarios[0].steps;
    assert.equal(steps.length, 4);
    assert.equal(steps[0].keyword, 'Given');
    assert.ok(steps[0].text.includes('registered user'));
    assert.equal(steps[1].keyword, 'When');
    assert.equal(steps[2].keyword, 'Then');
    assert.equal(steps[3].keyword, 'And');
  });

  it('extracts But keyword in steps', () => {
    const result = parse(FIXTURE_BUT_KEYWORD);
    const steps = result.features[0].scenarios[0].steps;
    assert.equal(steps[3].keyword, 'But');
    assert.equal(steps[3].text, 'not this outcome');
    assert.equal(steps[4].keyword, 'And');
  });

  it('extracts @unit, @integration, @e2e tags on scenarios', () => {
    const result = parse(FIXTURE_WELL_FORMED);
    assert.deepEqual(result.features[0].scenarios[0].tags, ['@integration']);
    assert.deepEqual(result.features[0].scenarios[1].tags, ['@unit']);
    assert.deepEqual(result.features[1].scenarios[0].tags, ['@e2e']);
  });

  it('extracts multiple tags on a single scenario', () => {
    const result = parse(FIXTURE_MULTIPLE_TAGS);
    assert.deepEqual(result.features[0].scenarios[0].tags, ['@integration', '@e2e']);
  });

  it('returns error for missing Gherkin section', () => {
    const result = parse(FIXTURE_MISSING_SECTION);
    assert.equal(result.features.length, 0);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('No Gherkin section found'));
  });

  it('returns error for empty/null/undefined input without throwing', () => {
    const empty = parse('');
    assert.equal(empty.features.length, 0);
    assert.ok(empty.errors.length > 0);

    const nullResult = parse(null);
    assert.equal(nullResult.features.length, 0);
    assert.ok(nullResult.errors.length > 0);

    const undefinedResult = parse(undefined);
    assert.equal(undefinedResult.features.length, 0);
    assert.ok(undefinedResult.errors.length > 0);
  });

  it('reports error for scenario with no steps but does not throw', () => {
    const result = parse(FIXTURE_MALFORMED_NO_STEPS);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.includes('no steps')));
    // Valid scenario should still be parsed
    const allScenarios = result.features.flatMap((f) => f.scenarios);
    assert.ok(allScenarios.some((s) => s.name === 'Valid scenario'));
  });

  it('handles legacy free-text test scenarios (no Gherkin structure)', () => {
    const result = parse(FIXTURE_LEGACY_FREE_TEXT);
    // No Feature/Scenario structure → no features parsed, error reported
    assert.equal(result.features.length, 0);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('No Feature/Scenario structure found'));
  });

  it('handles orphan scenario before any Feature line', () => {
    const md = '## Test Scenarios (Gherkin)\n  Scenario: Orphan\n    Given something\n';
    const result = parse(md);
    // Should not crash; features should be empty or scenario silently dropped
    assert.equal(result.features.length, 0);
  });

  it('recognizes alternate heading "## Test Scenarios" without (Gherkin)', () => {
    const result = parse(FIXTURE_ALTERNATE_HEADING);
    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].name, 'Login');
    assert.deepEqual(result.errors, []);
  });

  it('stops parsing at the next heading (does not bleed)', () => {
    const result = parse(FIXTURE_WELL_FORMED);
    // Should not pick up anything from "## Implementation Notes"
    const allStepTexts = result.features
      .flatMap((f) => f.scenarios)
      .flatMap((s) => s.steps)
      .map((st) => st.text);
    assert.ok(!allStepTexts.some((t) => t.includes('notes')));
  });
});

// ─── validate() ─────────────────────────────────────────────────────────────

describe('parse-gherkin: validate', () => {
  it('passes with sufficient scenarios and required tags', () => {
    const parseResult = parse(FIXTURE_WELL_FORMED);
    const result = validate(parseResult);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('fails when scenario count is below threshold', () => {
    const parseResult = {
      features: [
        {
          name: 'F',
          scenarios: [
            {
              name: 'S',
              tags: ['@integration'],
              steps: [
                { keyword: 'Given', text: 'x' },
                { keyword: 'When', text: 'y' },
                { keyword: 'Then', text: 'z' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult, { minScenarios: 2 });
    assert.equal(result.valid, false);
    // Must use proper singular (no trailing 's' for count of 1)
    assert.ok(result.errors[0].includes('Found 1 scenario,'));
    assert.ok(!result.errors[0].includes('scenario(s)'));
  });

  it('passes when scenario count is exactly at threshold', () => {
    const parseResult = {
      features: [
        {
          name: 'F',
          scenarios: [
            {
              name: 'S1',
              tags: ['@integration'],
              steps: [
                { keyword: 'Given', text: 'x' },
                { keyword: 'When', text: 'y' },
                { keyword: 'Then', text: 'z' },
              ],
            },
            {
              name: 'S2',
              tags: [],
              steps: [
                { keyword: 'Given', text: 'a' },
                { keyword: 'When', text: 'b' },
                { keyword: 'Then', text: 'c' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult, { minScenarios: 2, requireTags: ['@integration'] });
    assert.equal(result.valid, true);
  });

  it('passes when scenario count is above threshold', () => {
    const parseResult = parse(FIXTURE_WELL_FORMED);
    const result = validate(parseResult, { minScenarios: 1 });
    assert.equal(result.valid, true);
  });

  it('fails when neither @integration nor @e2e tag is present (default OR semantics)', () => {
    const parseResult = {
      features: [
        {
          name: 'F',
          scenarios: [
            {
              name: 'S1',
              tags: ['@unit'],
              steps: [
                { keyword: 'Given', text: 'x' },
                { keyword: 'When', text: 'y' },
                { keyword: 'Then', text: 'z' },
              ],
            },
            {
              name: 'S2',
              tags: ['@unit'],
              steps: [
                { keyword: 'Given', text: 'a' },
                { keyword: 'When', text: 'b' },
                { keyword: 'Then', text: 'c' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('@integration') && e.includes('@e2e')));
  });

  it('passes when only @integration is present (OR semantics)', () => {
    const parseResult = {
      features: [
        {
          name: 'F',
          scenarios: [
            {
              name: 'S1',
              tags: ['@integration'],
              steps: [
                { keyword: 'Given', text: 'x' },
                { keyword: 'When', text: 'y' },
                { keyword: 'Then', text: 'z' },
              ],
            },
            {
              name: 'S2',
              tags: [],
              steps: [
                { keyword: 'Given', text: 'a' },
                { keyword: 'When', text: 'b' },
                { keyword: 'Then', text: 'c' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult);
    assert.equal(result.valid, true);
  });

  it('passes when only @e2e is present (OR semantics)', () => {
    const parseResult = {
      features: [
        {
          name: 'F',
          scenarios: [
            {
              name: 'S1',
              tags: ['@e2e'],
              steps: [
                { keyword: 'Given', text: 'x' },
                { keyword: 'When', text: 'y' },
                { keyword: 'Then', text: 'z' },
              ],
            },
            {
              name: 'S2',
              tags: [],
              steps: [
                { keyword: 'Given', text: 'a' },
                { keyword: 'When', text: 'b' },
                { keyword: 'Then', text: 'c' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult);
    assert.equal(result.valid, true);
  });

  it('supports custom options override', () => {
    const parseResult = {
      features: [
        {
          name: 'F',
          scenarios: [
            {
              name: 'S1',
              tags: ['@e2e'],
              steps: [
                { keyword: 'Given', text: 'x' },
                { keyword: 'When', text: 'y' },
                { keyword: 'Then', text: 'z' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult, { minScenarios: 1, requireTags: ['@e2e'] });
    assert.equal(result.valid, true);
  });

  it('handles empty parse result', () => {
    const parseResult = { features: [], errors: ['No Gherkin section found'] };
    const result = validate(parseResult);
    assert.equal(result.valid, false);
    // Must use proper plural (no parenthesized 's')
    assert.ok(result.errors[0].includes('Found 0 scenarios,'));
    assert.ok(!result.errors[0].includes('scenario(s)'));
  });

  it('reports single error when none of the required tags are present (OR semantics)', () => {
    const parseResult = {
      features: [
        {
          name: 'F',
          scenarios: [
            {
              name: 'S',
              tags: ['@unit'],
              steps: [
                { keyword: 'Given', text: 'x' },
                { keyword: 'When', text: 'y' },
                { keyword: 'Then', text: 'z' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult, {
      minScenarios: 1,
      requireTags: ['@integration', '@e2e'],
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('@integration'));
    assert.ok(result.errors[0].includes('@e2e'));
  });

  it('passes with requireTags: [] and minScenarios: 0', () => {
    const parseResult = { features: [], errors: [] };
    const result = validate(parseResult, { minScenarios: 0, requireTags: [] });
    assert.equal(result.valid, true);
  });

  it('uses DEFAULT_MIN_SCENARIOS and DEFAULT_REQUIRED_TAGS when no options given', () => {
    assert.equal(DEFAULT_MIN_SCENARIOS, 2);
    assert.deepEqual(DEFAULT_REQUIRED_TAGS, ['@integration', '@e2e']);
  });

  it('passes when scenario has Given/When/Then plus And (And extends previous)', () => {
    const parseResult = {
      features: [
        {
          name: 'F',
          scenarios: [
            {
              name: 'With And',
              tags: ['@integration'],
              steps: [
                { keyword: 'Given', text: 'setup' },
                { keyword: 'And', text: 'more setup' },
                { keyword: 'When', text: 'action' },
                { keyword: 'Then', text: 'result' },
                { keyword: 'And', text: 'another result' },
              ],
            },
            {
              name: 'Simple',
              tags: [],
              steps: [
                { keyword: 'Given', text: 'a' },
                { keyword: 'When', text: 'b' },
                { keyword: 'Then', text: 'c' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult, { minScenarios: 1, requireTags: ['@integration'] });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('Render-only scenario with only Given and Then passes validation', () => {
    const parseResult = {
      features: [
        {
          name: 'Render-only feature',
          scenarios: [
            {
              name: 'render-only scenario',
              tags: ['@integration'],
              steps: [
                { keyword: 'Given', text: 'a precondition' },
                { keyword: 'Then', text: 'an outcome is observed' },
              ],
            },
            {
              name: 'second render-only scenario',
              tags: ['@e2e'],
              steps: [
                { keyword: 'Given', text: 'another precondition' },
                { keyword: 'Then', text: 'another outcome is observed' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('Given/When/Then scenarios continue to validate', () => {
    const parseResult = {
      features: [
        {
          name: 'Classic feature',
          scenarios: [
            {
              name: 'classic Given-When-Then',
              tags: ['@integration'],
              steps: [
                { keyword: 'Given', text: 'a precondition' },
                { keyword: 'When', text: 'an action occurs' },
                { keyword: 'Then', text: 'an outcome is observed' },
              ],
            },
            {
              name: 'second classic scenario',
              tags: ['@e2e'],
              steps: [
                { keyword: 'Given', text: 'another precondition' },
                { keyword: 'When', text: 'another action occurs' },
                { keyword: 'Then', text: 'another outcome is observed' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('Missing Given fails with clear error', () => {
    const parseResult = {
      features: [
        {
          name: 'Missing Given feature',
          scenarios: [
            {
              name: 'no Given scenario',
              tags: ['@integration'],
              steps: [
                { keyword: 'When', text: 'an action occurs' },
                { keyword: 'Then', text: 'an outcome is observed' },
              ],
            },
            {
              name: 'filler scenario',
              tags: ['@e2e'],
              steps: [
                { keyword: 'Given', text: 'a precondition' },
                { keyword: 'Then', text: 'an outcome is observed' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => /Given/.test(e)),
      `expected an error mentioning Given, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('Missing Then fails with clear error', () => {
    const parseResult = {
      features: [
        {
          name: 'Missing Then feature',
          scenarios: [
            {
              name: 'no Then scenario',
              tags: ['@integration'],
              steps: [
                { keyword: 'Given', text: 'a precondition' },
                { keyword: 'When', text: 'an action occurs' },
              ],
            },
            {
              name: 'filler scenario',
              tags: ['@e2e'],
              steps: [
                { keyword: 'Given', text: 'a precondition' },
                { keyword: 'Then', text: 'an outcome is observed' },
              ],
            },
          ],
        },
      ],
      errors: [],
    };
    const result = validate(parseResult);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => /Then/.test(e)),
      `expected an error mentioning Then, got: ${JSON.stringify(result.errors)}`
    );
  });
});

// ─── hasSkipOverride() ──────────────────────────────────────────────────────

describe('parse-gherkin: hasSkipOverride', () => {
  it('detects valid gherkin-skip comment with reason', () => {
    const result = hasSkipOverride(FIXTURE_WITH_SKIP);
    assert.equal(result.skip, true);
    assert.equal(result.reason, 'config-only change');
  });

  it('rejects bare gherkin-skip comment (no reason)', () => {
    const result = hasSkipOverride(FIXTURE_WITH_BARE_SKIP);
    assert.equal(result.skip, false);
    assert.equal(result.reason, undefined);
  });

  it('returns skip: false when no comment found', () => {
    const result = hasSkipOverride(FIXTURE_WELL_FORMED);
    assert.equal(result.skip, false);
    assert.equal(result.reason, undefined);
  });

  it('uses first skip comment when multiple exist', () => {
    const result = hasSkipOverride(FIXTURE_WITH_MULTIPLE_SKIPS);
    assert.equal(result.skip, true);
    assert.equal(result.reason, 'first reason');
  });

  it('handles null/undefined/empty input without throwing', () => {
    assert.deepEqual(hasSkipOverride(null), { skip: false });
    assert.deepEqual(hasSkipOverride(undefined), { skip: false });
    assert.deepEqual(hasSkipOverride(''), { skip: false });
  });

  it('rejects skip comment with whitespace-only reason', () => {
    const result = hasSkipOverride('<!-- gherkin-skip:   -->');
    assert.equal(result.skip, false);
  });
});

// ─── parseRaw() ─────────────────────────────────────────────────────────────

const FIXTURE_STANDALONE = `Feature: User login
  @integration
  Scenario: Successful login with valid credentials
    Given a registered user with email "test@example.com"
    When the user submits valid credentials
    Then the user is redirected to the dashboard

  @unit
  Scenario: Failed login with invalid password
    Given a registered user with email "test@example.com"
    When the user submits an invalid password
    Then an error message is displayed

Feature: Password reset
  @e2e
  Scenario: Request password reset email
    Given a registered user
    When the user requests a password reset
    Then a reset email is sent
`;

describe('parse-gherkin: parseRaw', () => {
  it('parses well-formed standalone gherkin content (no markdown headings)', () => {
    const result = parseRaw(FIXTURE_STANDALONE);
    assert.deepEqual(result.errors, []);
    assert.equal(result.features.length, 2);

    const [login, reset] = result.features;
    assert.equal(login.name, 'User login');
    assert.equal(login.scenarios.length, 2);
    assert.equal(login.scenarios[0].name, 'Successful login with valid credentials');
    assert.deepEqual(login.scenarios[0].tags, ['@integration']);
    assert.equal(login.scenarios[1].name, 'Failed login with invalid password');
    assert.deepEqual(login.scenarios[1].tags, ['@unit']);

    assert.equal(reset.name, 'Password reset');
    assert.equal(reset.scenarios.length, 1);
    assert.equal(reset.scenarios[0].name, 'Request password reset email');
    assert.deepEqual(reset.scenarios[0].tags, ['@e2e']);
  });

  it('returns errors for empty or malformed input', () => {
    const emptyResult = parseRaw('');
    assert.equal(emptyResult.features.length, 0);
    assert.ok(emptyResult.errors.length > 0);

    const nullResult = parseRaw(null);
    assert.equal(nullResult.features.length, 0);
    assert.ok(nullResult.errors.length > 0);

    const undefinedResult = parseRaw(undefined);
    assert.equal(undefinedResult.features.length, 0);
    assert.ok(undefinedResult.errors.length > 0);
  });

  it('hasSkipOverride works on standalone gherkin content', () => {
    const withSkip = `<!-- gherkin-skip: config-only change -->\n\nFeature: Something\n  Scenario: A test\n    Given x\n    When y\n    Then z\n`;
    const result = hasSkipOverride(withSkip);
    assert.equal(result.skip, true);
    assert.equal(result.reason, 'config-only change');

    // Also works on raw gherkin without skip comment
    const noSkip = hasSkipOverride(FIXTURE_STANDALONE);
    assert.equal(noSkip.skip, false);
  });
});
