/**
 * Step: spec-gate (GH-244, GH-350)
 *
 * Gates the `spec → tasks` transition on Gherkin validation of `gherkin.feature`.
 * Mirrors the sibling step contract `(add, s, ctx) => void` from
 * `./brief-gate.js`, and reuses the pure parser in `../lib/parse-gherkin.js`.
 *
 * Decision matrix:
 *   1. `!s.hasSpec`                           → DEFER "No spec.md present"
 *   2. `gherkin.feature` missing/unreadable   → RUN  "/spec" regenerate spec
 *   3. gherkin-skip override in gherkin.feature → DEFER with override reason
 *   4. parseRaw() + validate() passes         → DEFER with scenario count
 *   5. Validation fails                       → RUN  "/spec" with error messages
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

  // Case 2: gherkin.feature missing/unreadable
  const gherkinPath = path.join(tasksDir, 'gherkin.feature');
  let gherkinContent;
  try {
    gherkinContent = fs.readFileSync(gherkinPath, 'utf8');
  } catch (_e) {
    add(STEPS.spec_gate, 'RUN', '/spec', 'gherkin.feature missing — regenerate spec', {
      agentType: 'skill',
      agentPrompt: '/spec',
    });
    return;
  }

  // Case 3: Skip override in gherkin.feature
  const skipResult = parseGherkin.hasSkipOverride(gherkinContent);
  if (skipResult.skip) {
    add(STEPS.spec_gate, 'DEFER', null, `Gherkin skip override: ${skipResult.reason}`);
    return;
  }

  // Case 4+5: Parse and validate using parseRaw (standalone content, no section heading)
  const parsed = parseGherkin.parseRaw(gherkinContent);
  const validation = parseGherkin.validate(parsed);
  const allErrors = [...parsed.errors, ...validation.errors];
  if (validation.valid && parsed.errors.length === 0) {
    const totalScenarios = parsed.features.reduce((sum, f) => sum + f.scenarios.length, 0);
    const integrationCount = parsed.features.reduce(
      (sum, f) => sum + f.scenarios.filter((sc) => sc.tags.includes('@integration')).length,
      0
    );
    const e2eCount = parsed.features.reduce(
      (sum, f) => sum + f.scenarios.filter((sc) => sc.tags.includes('@e2e')).length,
      0
    );
    add(
      STEPS.spec_gate,
      'DEFER',
      null,
      `Gherkin validation passed (${totalScenarios} scenarios, ${integrationCount} @integration, ${e2eCount} @e2e)`
    );
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
