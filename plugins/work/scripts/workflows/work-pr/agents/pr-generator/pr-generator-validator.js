#!/usr/bin/env node

/**
 * SubagentStop hook to validate pr-generator output.
 *
 * Checks that the PR description:
 * 1. Has required sections (Existing Behavior, Intended New Behavior, Dev Checks, Testing Plan)
 * 2. Uses correct checkbox format ([Y] or [ ], not [x] or [X])
 * 3. Has no placeholder text like "[TO BE ADDED AFTER PR CREATION]"
 * 4. Has actual content in Testing Plan section
 * 5. Has no emojis (professional requirement)
 */

'use strict';

const path = require('path');
const { readHookDataStrict, resolveAgentName, resolveAgentOutput } = require(
  path.join(__dirname, '..', 'lib', 'hook-io')
);

// More lenient patterns that handle potential wrapping or variations
const REQUIRED_SECTIONS = [
  { name: 'Existing Behavior', pattern: /(?:^|\n)##?\s*Existing\s*Behavior/i },
  { name: 'Intended New Behavior', pattern: /(?:^|\n)##?\s*Intended\s*New\s*Behavior/i },
  { name: 'Dev Checks', pattern: /(?:^|\n)##?\s*Dev\s*Checks/i },
  { name: 'Testing Plan', pattern: /(?:^|\n)##?\s*Testing\s*Plan/i },
];

const FORBIDDEN_PATTERNS = [
  { name: 'Placeholder text', pattern: /\[TO BE ADDED|TBD\]|\[PLACEHOLDER\]|\[INSERT\s|TODO:/i },
  { name: 'Wrong checkbox format', pattern: /\[x\]|\[X\]/g },
  { name: 'Empty section markers', pattern: /\[Your analysis here\]/i },
];

// Emoji detection using Unicode property escapes (Node 12+)
// More comprehensive than manual ranges and auto-updates with Unicode versions
const EMOJI_PATTERN = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u;

const SHORT_OUTPUT_BOX = `
╔══════════════════════════════════════════════════════════════════════╗
║  🛑 PR-GENERATOR: OUTPUT TOO SHORT                                   ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  ❌ PR description is missing or too short                           ║
║                                                                      ║
║  Expected: Complete PR template with all required sections           ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`;

function buildFailureBox(issues) {
  return `
╔══════════════════════════════════════════════════════════════════════╗
║  🛑 PR-GENERATOR: VALIDATION FAILED                                  ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
${issues.map((i) => `║  ❌ ${i.padEnd(64)}║`).join('\n')}
║                                                                      ║
║  Fix these issues and regenerate the PR description.                 ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`;
}

function checkRequiredSections(output) {
  return REQUIRED_SECTIONS.filter((s) => !s.pattern.test(output)).map(
    (s) => `Missing section: "${s.name}"`
  );
}

function checkForbiddenPatterns(output) {
  return FORBIDDEN_PATTERNS.filter((f) => f.pattern.test(output)).map((f) => `Found ${f.name}`);
}

// Testing Plan must carry ≥30 chars of substantive content (markers stripped).
function checkTestingPlan(output) {
  const match = output.match(/##\s*Testing\s*Plan[^\n]*\n([\s\S]*?)(?=##|$)/i);
  if (!match) return [];
  const stripped = match[1].trim().replace(/[-*\s\n]/g, '');
  return stripped.length < 30 ? ['Testing Plan section lacks substantive content'] : [];
}

// Dev Checks checkboxes must all be [Y] or [ ] (no [x]/[X]).
function checkDevChecks(output) {
  const match = output.match(/##\s*Dev\s*Checks[^\n]*\n([\s\S]*?)(?=##|$)/i);
  if (!match) return [];
  const checkboxes = match[1].match(/\[.\]/g) || [];
  const valid = checkboxes.filter((cb) => cb === '[Y]' || cb === '[ ]');
  return checkboxes.length > 0 && valid.length !== checkboxes.length
    ? ['Dev Checks has invalid checkbox format (use [Y] or [ ] only)']
    : [];
}

function collectIssues(output) {
  const issues = [...checkRequiredSections(output), ...checkForbiddenPatterns(output)];
  if (EMOJI_PATTERN.test(output)) {
    issues.push('Contains emojis (not allowed in PR descriptions)');
  }
  return [...issues, ...checkTestingPlan(output), ...checkDevChecks(output)];
}

async function main() {
  const hookData = await readHookDataStrict('PR-GENERATOR VALIDATOR');

  // Only validate pr-generator subagent
  const agentName = resolveAgentName(hookData);
  if (!agentName.includes('pr-generator') || agentName.includes('post')) {
    process.exit(0);
  }

  // Get the agent's output/response
  const agentOutput = resolveAgentOutput(hookData);

  if (!agentOutput || agentOutput.length < 100) {
    process.stderr.write(SHORT_OUTPUT_BOX);
    process.exit(2);
  }

  const issues = collectIssues(agentOutput);
  if (issues.length > 0) {
    process.stderr.write(buildFailureBox(issues));
    process.exit(2);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`PR-GENERATOR VALIDATOR ERROR: ${err.message}\n`);
  process.exit(2);
});
