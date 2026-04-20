/**
 * workflows/work/lib/parse-gherkin.js
 *
 * Pure-logic parser for the `## Test Scenarios (Gherkin)` section of a
 * spec.md document. No I/O, no side effects, no external dependencies.
 *
 * Public API:
 *   - parse(markdown): { features: Feature[], errors: string[] }
 *   - validate(parseResult, options?): { valid: boolean, errors: string[] }
 *   - hasSkipOverride(markdown): { skip: boolean, reason?: string }
 *   - DEFAULT_MIN_SCENARIOS: number (2)
 *   - DEFAULT_REQUIRED_TAGS: string[] (['@integration', '@e2e'])
 *
 * A Feature is: { name: string, scenarios: Scenario[] }
 * A Scenario is: { name: string, tags: string[], steps: Step[] }
 * A Step is: { keyword: 'Given'|'When'|'Then'|'And'|'But', text: string }
 */

'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MIN_SCENARIOS = 2;
const DEFAULT_REQUIRED_TAGS = ['@integration', '@e2e'];

const GHERKIN_SECTION_HEADING = /^##\s+Test Scenarios(?:\s*\(Gherkin\))?\s*$/;
const ANY_HEADING = /^#{1,6}\s+/;
const FEATURE_LINE = /^Feature:\s*(.+)$/;
const SCENARIO_LINE = /^\s*Scenario:\s*(.+)$/;
const TAG_LINE = /^\s*(@\S+(?:\s+@\S+)*)$/;
const STEP_LINE = /^\s*(Given|When|Then|And|But)\s+(.+)$/;
const SKIP_COMMENT = /<!--\s*gherkin-skip:\s*(.+?)\s*-->/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Locate the line range of the Gherkin section.
 * Returns { start, end } (start inclusive of first content line, end exclusive)
 * or null if no matching heading found.
 */
function findSectionRange(lines) {
  const startIdx = lines.findIndex((line) => GHERKIN_SECTION_HEADING.test(line));
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { start: startIdx + 1, end: endIdx };
}

/**
 * Parse tags from a line like "  @integration @e2e".
 * Returns array of tag strings or null if not a tag line.
 */
function parseTags(line) {
  const match = line.match(TAG_LINE);
  if (!match) return null;
  return match[1].split(/\s+/).filter((t) => t.startsWith('@'));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse the `## Test Scenarios (Gherkin)` or `## Test Scenarios` section of a
 * spec markdown document into structured Feature/Scenario/Step data.
 *
 * Never throws. Returns { features: Feature[], errors: string[] }.
 *
 * @param {string|null|undefined} markdown
 * @returns {{ features: Array<{name: string, scenarios: Array<{name: string, tags: string[], steps: Array<{keyword: string, text: string}>}>}>, errors: string[] }}
 */
function parse(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return { features: [], errors: ['No Gherkin section found'] };
  }

  const lines = markdown.split('\n');
  const range = findSectionRange(lines);
  if (!range) {
    return { features: [], errors: ['No Gherkin section found'] };
  }

  const features = [];
  const errors = [];
  let currentFeature = null;
  let currentScenario = null;
  let pendingTags = [];

  for (let i = range.start; i < range.end; i++) {
    const line = lines[i];

    // Feature line
    const featureMatch = line.match(FEATURE_LINE);
    if (featureMatch) {
      // Finalize previous scenario
      if (currentScenario) {
        if (currentScenario.steps.length === 0) {
          errors.push(`Scenario "${currentScenario.name}" has no steps`);
        }
        if (currentFeature) currentFeature.scenarios.push(currentScenario);
        currentScenario = null;
      }
      // Finalize previous feature
      if (currentFeature) {
        features.push(currentFeature);
      }
      currentFeature = { name: featureMatch[1].trim(), scenarios: [] };
      pendingTags = [];
      continue;
    }

    // Tag line (must come before Scenario)
    const tags = parseTags(line);
    if (tags) {
      pendingTags = pendingTags.concat(tags);
      continue;
    }

    // Scenario line
    const scenarioMatch = line.match(SCENARIO_LINE);
    if (scenarioMatch) {
      // Finalize previous scenario
      if (currentScenario) {
        if (currentScenario.steps.length === 0) {
          errors.push(`Scenario "${currentScenario.name}" has no steps`);
        }
        if (currentFeature) currentFeature.scenarios.push(currentScenario);
      }
      currentScenario = {
        name: scenarioMatch[1].trim(),
        tags: pendingTags,
        steps: [],
      };
      pendingTags = [];
      continue;
    }

    // Step line
    const stepMatch = line.match(STEP_LINE);
    if (stepMatch && currentScenario) {
      currentScenario.steps.push({
        keyword: stepMatch[1],
        text: stepMatch[2].trim(),
      });
      continue;
    }
  }

  // Finalize last scenario and feature
  if (currentScenario) {
    if (currentScenario.steps.length === 0) {
      errors.push(`Scenario "${currentScenario.name}" has no steps`);
    }
    if (currentFeature) currentFeature.scenarios.push(currentScenario);
  }
  if (currentFeature) {
    features.push(currentFeature);
  }

  // If we found the section but no features, it's likely legacy free-text
  if (features.length === 0) {
    errors.push('No Feature/Scenario structure found in Gherkin section');
  }

  return { features, errors };
}

/**
 * Validate a parse result against threshold and tag requirements.
 *
 * Note: `parseResult.errors` (parse-level issues such as missing steps or
 * missing structure) are intentionally not checked here — callers are expected
 * to inspect both `parseResult.errors` and the validation result independently.
 *
 * Default options: { minScenarios: 2, requireTags: ['@integration', '@e2e'] }
 *
 * @param {{ features: Array, errors: string[] }} parseResult
 * @param {{ minScenarios?: number, requireTags?: string[] }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(parseResult, options) {
  const minScenarios = (options && options.minScenarios !== undefined)
    ? options.minScenarios
    : DEFAULT_MIN_SCENARIOS;
  const requireTags = (options && options.requireTags !== undefined)
    ? options.requireTags
    : DEFAULT_REQUIRED_TAGS;

  const validationErrors = [];

  // Count total scenarios across all features
  const totalScenarios = parseResult.features.reduce(
    (sum, f) => sum + f.scenarios.length,
    0
  );

  if (totalScenarios < minScenarios) {
    validationErrors.push(
      `Found ${totalScenarios} scenario${totalScenarios === 1 ? '' : 's'}, need at least ${minScenarios}`
    );
  }

  // Check required tags — at least one of the required tags must be present (OR semantics)
  if (requireTags.length > 0) {
    const allScenarios = parseResult.features.flatMap((f) => f.scenarios);
    const hasAnyRequiredTag = allScenarios.some((sc) =>
      sc.tags.some((tag) => requireTags.includes(tag))
    );
    if (!hasAnyRequiredTag) {
      validationErrors.push(`No ${requireTags.join(' or ')} tag found`);
    }
  }

  // Check each scenario has at least Given, When, Then steps
  for (const feature of parseResult.features) {
    for (const scenario of feature.scenarios) {
      const keywords = new Set(scenario.steps.map((s) => s.keyword));
      // And/But extend the previous keyword, so we only require the primary three
      const hasGiven = keywords.has('Given');
      const hasWhen = keywords.has('When');
      const hasThen = keywords.has('Then');
      if (!hasGiven || !hasWhen || !hasThen) {
        const missing = [];
        if (!hasGiven) missing.push('Given');
        if (!hasWhen) missing.push('When');
        if (!hasThen) missing.push('Then');
        validationErrors.push(
          `Scenario "${scenario.name}" is missing ${missing.join(', ')} step(s)`
        );
      }
    }
  }

  return {
    valid: validationErrors.length === 0,
    errors: validationErrors,
  };
}

/**
 * Detect a `<!-- gherkin-skip: reason -->` comment in the markdown.
 * Requires a non-empty reason after `gherkin-skip:`.
 * Bare `<!-- gherkin-skip -->` (no colon or empty reason) returns { skip: false }.
 *
 * @param {string|null|undefined} markdown
 * @returns {{ skip: boolean, reason?: string }}
 */
function hasSkipOverride(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return { skip: false };
  }

  const match = markdown.match(SKIP_COMMENT);
  if (match && match[1].trim().length > 0) {
    return { skip: true, reason: match[1].trim() };
  }

  return { skip: false };
}

module.exports = {
  parse,
  validate,
  hasSkipOverride,
  DEFAULT_MIN_SCENARIOS,
  DEFAULT_REQUIRED_TAGS,
};
