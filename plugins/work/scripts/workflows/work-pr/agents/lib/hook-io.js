/**
 * Shared stdin/hook-payload helpers for the work-pr SubagentStop validators
 * (pr-generator-validator.js, pr-post-generator-validator.js). Both read the
 * entire hook payload from stdin and parse it the same way; keeping that here
 * once avoids a cross-file duplicate-block.
 */

'use strict';

const path = require('path');
const { payloadAgentName } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'agent-identity')
);

// Read all of stdin to a string.
async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

// Read + parse the SubagentStop hook payload. On malformed JSON, write a
// labelled error to stderr and exit 2 (block the agent).
async function readHookDataStrict(label) {
  const input = await readStdin();
  try {
    return JSON.parse(input);
  } catch (err) {
    process.stderr.write(`${label}: Failed to parse hook input: ${err.message}\n`);
    process.exit(2);
  }
}

// Resolve the subagent name from the hook payload (normalized for matching)
// via the canonical agent-identity accessor (GH-767).
function resolveAgentName(hookData) {
  return payloadAgentName(hookData);
}

// Resolve the agent's textual output across the payload field variants.
function resolveAgentOutput(hookData) {
  return hookData.agent_output || hookData.response || hookData.result || '';
}

module.exports = {
  readStdin,
  readHookDataStrict,
  resolveAgentName,
  resolveAgentOutput,
};
