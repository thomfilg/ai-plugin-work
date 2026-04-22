/**
 * Step: spec-gate (GH-244)
 *
 * Gates the `spec → tasks` transition on Gherkin validation of `spec.md`.
 * Mirrors the sibling step contract `(add, s, ctx) => void` from
 * `./brief-gate.js`, and reuses the pure parser in `../lib/parse-gherkin.js`.
 *
 * Decision matrix:
 *   1. `!s.hasSpec`                           → DEFER "No spec.md present"
 *   2. `spec.md` unreadable (fail-closed)      → RUN  "/spec" regenerate spec
 *   3. gherkin-skip override present           → DEFER with override reason
 *   4. parse() + validate() passes             → DEFER with scenario count
 *   5. Validation fails                        → RUN  "/spec" with error messages
 */

'use strict';

const fs = require('fs');
const parseGherkin = require('../lib/parse-gherkin');

/**
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
function specGateStep(add, s, ctx) {
  const { STEPS, tasksDir, path } = ctx;

  // Case 1: No spec.md
  if (!s || !s.hasSpec) {
    add(STEPS.spec_gate, 'DEFER', null, 'No spec.md present');
    return;
  }

  // Case 2: spec.md unreadable
  const specPath = path.join(tasksDir, 'spec.md');
  let markdown;
  try {
    markdown = fs.readFileSync(specPath, 'utf8');
  } catch (_e) {
    add(STEPS.spec_gate, 'RUN', '/spec', 'spec.md unreadable — regenerate spec', {
      agentType: 'skill',
      agentPrompt: '/spec',
    });
    return;
  }

  // Case 3: Skip override
  const skipResult = parseGherkin.hasSkipOverride(markdown);
  if (skipResult.skip) {
    add(STEPS.spec_gate, 'DEFER', null, `Gherkin skip override: ${skipResult.reason}`);
    return;
  }

  // Case 4+5: Parse and validate
  const parsed = parseGherkin.parse(markdown);
  // If parse found errors and no features, report parse errors in the RUN reason
  const validation = parseGherkin.validate(parsed);
  const allErrors = [...parsed.errors, ...validation.errors];
  if (validation.valid && parsed.errors.length === 0) {
    const totalScenarios = parsed.features.reduce((sum, f) => sum + f.scenarios.length, 0);
    const integrationCount = parsed.features.reduce((sum, f) =>
      sum + f.scenarios.filter((sc) => sc.tags.includes('@integration')).length, 0);
    const e2eCount = parsed.features.reduce((sum, f) =>
      sum + f.scenarios.filter((sc) => sc.tags.includes('@e2e')).length, 0);
    add(STEPS.spec_gate, 'DEFER', null,
      `Gherkin validation passed (${totalScenarios} scenarios, ${integrationCount} @integration, ${e2eCount} @e2e)`);
    return;
  }

  // Case 5: Validation or parse fails → RUN with retry to spec
  add(STEPS.spec_gate, 'RUN', '/spec', allErrors.join('; '), {
    agentType: 'skill',
    agentPrompt: '/spec',
  });
}

module.exports = specGateStep;
module.exports.specGateStep = specGateStep;
