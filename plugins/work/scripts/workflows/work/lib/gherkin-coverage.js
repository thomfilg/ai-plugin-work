/**
 * workflows/work/lib/gherkin-coverage.js
 *
 * Pure-logic coverage validation for Gherkin scenarios against tasks.md
 * content and test files. No I/O, no side effects, no external dependencies.
 * Consumes scenarios from parse-gherkin.js (parseRaw/parse output).
 * Re-exports parseRaw for caller convenience.
 *
 * Public API:
 *   - validateTaskCoverage(scenarios, tasksContent): TaskCoverageResult
 *   - validateTestCoverage(scenarios, testFiles): TestCoverageResult
 *
 * A Scenario is: { name: string, tags: string[] }
 * A TestFile is: { path: string, content: string }
 *
 * TaskCoverageResult:
 *   { covered: string[], uncovered: string[], valid: boolean }
 *
 * TestCoverageResult:
 *   {
 *     covered: Array<{ scenario: string, file: string, tagMatch: boolean }>,
 *     uncovered: string[],
 *     mismatched: Array<{ scenario: string, tag: string, file: string, actualType: string }>,
 *     valid: boolean
 *   }
 */

'use strict';

const { parseRaw } = require('./parse-gherkin');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Determine the test type of a file based on its path.
 * Returns 'e2e', 'integration', or 'unit'.
 *
 * @param {string} filePath
 * @returns {'e2e' | 'integration' | 'unit'}
 */
function classifyTestFile(filePath) {
  if (filePath.includes('.e2e.') || filePath.includes('/e2e/') || filePath.includes('\\e2e\\')) {
    return 'e2e';
  }
  if (
    filePath.includes('.integration.') ||
    filePath.includes('/integration/') ||
    filePath.includes('\\integration\\')
  ) {
    return 'integration';
  }
  return 'unit';
}

/**
 * Determine the expected test type from a scenario's tags.
 * Returns 'e2e', 'integration', or 'unit' (default when @unit or no tag).
 *
 * @param {string[]} tags
 * @returns {'e2e' | 'integration' | 'unit'}
 */
function expectedTestType(tags) {
  if (tags.includes('@e2e')) return 'e2e';
  if (tags.includes('@integration')) return 'integration';
  return 'unit';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate that each Gherkin scenario name appears in the tasks.md content.
 * Matching is case-insensitive.
 *
 * @param {Array<{name: string, tags: string[]}>} scenarios
 * @param {string} tasksContent - raw tasks.md string
 * @returns {{ covered: string[], uncovered: string[], valid: boolean }}
 */
function validateTaskCoverage(scenarios, tasksContent) {
  const covered = [];
  const uncovered = [];
  const lowerContent = (tasksContent || '').toLowerCase();

  for (const scenario of scenarios) {
    if (lowerContent.includes(scenario.name.toLowerCase())) {
      covered.push(scenario.name);
    } else {
      uncovered.push(scenario.name);
    }
  }

  return {
    covered,
    uncovered,
    valid: uncovered.length === 0,
  };
}

/**
 * Validate that each Gherkin scenario name appears in at least one test file,
 * and that the test file type matches the scenario's tag.
 *
 * @param {Array<{name: string, tags: string[]}>} scenarios
 * @param {Array<{path: string, content: string}>} testFiles
 * @returns {{
 *   covered: Array<{scenario: string, file: string, tagMatch: boolean}>,
 *   uncovered: string[],
 *   mismatched: Array<{scenario: string, tag: string, file: string, actualType: string}>,
 *   valid: boolean
 * }}
 */
function validateTestCoverage(scenarios, testFiles) {
  const covered = [];
  const uncovered = [];
  const mismatched = [];

  for (const scenario of scenarios) {
    const lowerName = scenario.name.toLowerCase();
    let found = false;
    let correctMatch = null;
    let wrongMatch = null;

    for (const file of testFiles) {
      if (file.content.toLowerCase().includes(lowerName)) {
        found = true;
        const expected = expectedTestType(scenario.tags || []);
        const actual = classifyTestFile(file.path);

        if (expected === actual) {
          correctMatch = { scenario: scenario.name, file: file.path, tagMatch: true };
          break; // correct type found — stop searching
        } else if (!wrongMatch) {
          const tag =
            (scenario.tags || []).find((t) => t === '@e2e' || t === '@integration') || '@unit';
          wrongMatch = { scenario: scenario.name, tag, file: file.path, actualType: actual };
        }
      }
    }

    if (correctMatch) {
      covered.push(correctMatch);
    } else if (wrongMatch) {
      mismatched.push(wrongMatch);
    } else if (!found) {
      uncovered.push(scenario.name);
    }
  }

  return {
    covered,
    uncovered,
    mismatched,
    valid: uncovered.length === 0 && mismatched.length === 0,
  };
}

module.exports = {
  validateTaskCoverage,
  validateTestCoverage,
  parseRaw,
};
