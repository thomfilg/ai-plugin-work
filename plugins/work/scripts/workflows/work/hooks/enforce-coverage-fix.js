#!/usr/bin/env node

/**
 * PostToolUse hook: Enforce /test-coordination for coverage failures
 *
 * Triggers on Bash commands that check CI status (gh run view, gh pr checks).
 * Reads the transcript to check if the output contains coverage failure patterns.
 * If detected, injects a mandatory reminder to run /test-coordination.
 *
 * This prevents the AI from rationalizing coverage failures as "pre-existing"
 * or "infrastructure issues" instead of following /follow-up-pr section 4.3.
 */

const fs = require('fs');
const path = require('path');
const { installProcessGuards, loadConfigOrNull } = require(
  path.join(__dirname, '..', '..', 'lib', 'hook-guards')
);
// Vendored dual-runtime adapter: emission channel (PostToolUse stdout is not
// injected on codex — context rides the additionalContext envelope) and the
// dual-format transcript reader for the CI-output scan.
const { getRuntime } = require(path.join(__dirname, '..', '..', 'lib', 'runtime'));
const { sniffFormat, readToolEvents } = require(
  path.join(__dirname, '..', '..', 'lib', 'runtime', 'transcript')
);

installProcessGuards(__filename);

const config = loadConfigOrNull();

const COVERAGE_FAILURE_PATTERNS = [
  /coverage\s+decrease/i,
  /please add tests to maintain/i,
  /check.?modified.?files.?coverage/i,
  /coverage.?summary\.json/i,
  /below\s+\d+%\s+(test\s+)?coverage/i,
  /vitest-coverage-report/i,
  /check-coverage-decrease/i,
  /coverage.*fail/i,
  /fail.*coverage/i,
];

// CI-checking command patterns
const CI_CHECK_COMMANDS = [
  /gh\s+run\s+view/,
  /gh\s+pr\s+checks/,
  /gh\s+run\s+list.*--status\s+failure/,
];

/**
 * Codex leg of the CI-output read: the transcript is a session rollout the
 * legacy scan cannot read — take the payload's tool_response (a plain string
 * on codex) plus recent tool outputs via the dual-format reader. Returns
 * null when nothing was captured (caller stops).
 */
function readCodexOutput(hookData, transcriptPath) {
  const parts = typeof hookData.tool_response === 'string' ? [hookData.tool_response] : [];
  try {
    for (const event of readToolEvents(transcriptPath).slice(-50)) {
      if (typeof event.output === 'string' && event.output) parts.push(event.output);
    }
  } catch {
    /* payload tool_response alone still feeds the scan */
  }
  const output = parts.join('\n');
  return output || null;
}

/** Fold one transcript line's tool output into the scan buffer. */
function extractEntryText(line) {
  try {
    const entry = JSON.parse(line);
    // tool_result entries contain the output
    if (entry.type === 'tool_result' || entry.content) {
      return typeof entry.content === 'string'
        ? entry.content
        : JSON.stringify(entry.content || '');
    }
  } catch {
    // Not JSON, skip
  }
  return null;
}

/**
 * Claude leg: legacy last-50-lines transcript scan, byte-for-byte unchanged.
 * Returns null when the transcript is missing/unreadable (caller stops).
 */
function readClaudeTranscriptTail(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }

  // Read last 50 lines of transcript (tool output should be recent)
  let output = '';
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    // Check last 50 entries for tool_result containing our output
    for (const line of lines.slice(-50)) {
      const text = extractEntryText(line);
      if (text !== null) output += text + '\n';
    }
  } catch {
    return null;
  }
  return output;
}

/** Determine ticket ID from the current branch (fallback literal otherwise). */
function detectTicketId() {
  let ticketId = 'TICKET_ID';
  try {
    const { execSync } = require('child_process');
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    const match = branch.match(new RegExp(config.TICKET_PROJECT_KEY + '-\\d+', 'i'));
    if (match) ticketId = match[0].toUpperCase();
  } catch {
    /* */
  }
  return ticketId;
}

function coverageFailureMessage(ticketId) {
  return `🛑 COVERAGE FAILURE DETECTED IN CI OUTPUT

╔══════════════════════════════════════════════════════════════════════╗
║  MANDATORY: Run /test-coordination NOW                               ║
║                                                                      ║
║  DO NOT investigate CI config.                                       ║
║  DO NOT argue it's "pre-existing" or "infrastructure".               ║
║  DO NOT rationalize that "real tests passed".                        ║
║                                                                      ║
║  Run: Skill(test-coordination): ${ticketId.padEnd(16)}               ║
║  Then: git push                                                      ║
║  Then: Continue CI check loop                                        ║
╚══════════════════════════════════════════════════════════════════════╝

Per /follow-up-pr section 4.3: ANY coverage-related CI failure → /test-coordination. No exceptions.`;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const rt = getRuntime(hookData);

  // Only check Bash commands
  if (hookData.tool_name !== 'Bash') {
    return;
  }

  const command = hookData.tool_input?.command || '';

  // Only trigger on CI-checking commands
  const isCICheck = CI_CHECK_COMMANDS.some((p) => p.test(command));
  if (!isCICheck) {
    return;
  }

  // Read the tool output via the runtime-appropriate leg.
  const transcriptPath = hookData.transcript_path;
  const output =
    transcriptPath && sniffFormat(transcriptPath) === 'codex'
      ? readCodexOutput(hookData, transcriptPath)
      : readClaudeTranscriptTail(transcriptPath);
  if (output === null) return;

  // Check if output contains coverage failure patterns
  const hasCoverageFailure = COVERAGE_FAILURE_PATTERNS.some((p) => p.test(output));

  if (hasCoverageFailure) {
    // Claude branch of rt.emit.context is byte-identical to the historical
    // console.log (stdout + trailing newline); on codex the same text rides
    // the PostToolUse additionalContext envelope (plain stdout is not
    // injected there — design C2).
    rt.emit.context('PostToolUse', coverageFailureMessage(detectTicketId()));
  }
}

main().catch((err) => {
  const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
  logHookError(__filename, err);
  process.exit(0);
});
