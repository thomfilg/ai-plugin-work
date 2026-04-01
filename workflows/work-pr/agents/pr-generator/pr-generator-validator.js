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

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    process.stderr.write(`PR-GENERATOR VALIDATOR: Failed to parse hook input: ${err.message}\n`);
    process.exit(2);
  }

  // Only validate pr-generator subagent
  const agentName = hookData.agent_name || hookData.subagent_type || '';
  if (!agentName.toLowerCase().includes('pr-generator') || agentName.toLowerCase().includes('post')) {
    process.exit(0);
  }

  // Get the agent's output/response
  const agentOutput = hookData.agent_output || hookData.response || hookData.result || '';

  if (!agentOutput || agentOutput.length < 100) {
    process.stderr.write(`
╔══════════════════════════════════════════════════════════════════════╗
║  🛑 PR-GENERATOR: OUTPUT TOO SHORT                                   ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  ❌ PR description is missing or too short                           ║
║                                                                      ║
║  Expected: Complete PR template with all required sections           ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`);
    process.exit(2);
  }

  const issues = [];

  // Check required sections
  for (const section of REQUIRED_SECTIONS) {
    if (!section.pattern.test(agentOutput)) {
      issues.push(`Missing section: "${section.name}"`);
    }
  }

  // Check forbidden patterns
  for (const forbidden of FORBIDDEN_PATTERNS) {
    if (forbidden.pattern.test(agentOutput)) {
      issues.push(`Found ${forbidden.name}`);
    }
  }

  // Check for emojis
  if (EMOJI_PATTERN.test(agentOutput)) {
    issues.push('Contains emojis (not allowed in PR descriptions)');
  }

  // Check Testing Plan has actual content
  const testingPlanMatch = agentOutput.match(/##\s*Testing\s*Plan[^\n]*\n([\s\S]*?)(?=##|$)/i);
  if (testingPlanMatch) {
    const testingPlanContent = testingPlanMatch[1].trim();
    // Strip markdown list markers, whitespace, and newlines to get substantive content
    const strippedContent = testingPlanContent.replace(/[-*\s\n]/g, '');
    // Must have at least 30 chars of actual content
    if (strippedContent.length < 30) {
      issues.push('Testing Plan section lacks substantive content');
    }
  }

  // Check Dev Checks has proper checkbox format
  const devChecksMatch = agentOutput.match(/##\s*Dev\s*Checks[^\n]*\n([\s\S]*?)(?=##|$)/i);
  if (devChecksMatch) {
    const devChecksContent = devChecksMatch[1];
    const checkboxes = devChecksContent.match(/\[.\]/g) || [];
    const validCheckboxes = checkboxes.filter(cb => cb === '[Y]' || cb === '[ ]');
    if (checkboxes.length > 0 && validCheckboxes.length !== checkboxes.length) {
      issues.push('Dev Checks has invalid checkbox format (use [Y] or [ ] only)');
    }
  }

  if (issues.length > 0) {
    process.stderr.write(`
╔══════════════════════════════════════════════════════════════════════╗
║  🛑 PR-GENERATOR: VALIDATION FAILED                                  ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
${issues.map(i => `║  ❌ ${i.padEnd(64)}║`).join('\n')}
║                                                                      ║
║  Fix these issues and regenerate the PR description.                 ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`PR-GENERATOR VALIDATOR ERROR: ${err.message}\n`);
  process.exit(2);
});
