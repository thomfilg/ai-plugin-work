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

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

let config;
try {
  config = require('../../lib/config');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\.\/\.\.\/lib\/config['"]/.test(err.message)) {
    config = null;
  } else {
    throw err;
  }
}

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

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);

  // Only check Bash commands
  if (hookData.tool_name !== 'Bash') {
    return;
  }

  const command = hookData.tool_input?.command || '';

  // Only trigger on CI-checking commands
  const isCICheck = CI_CHECK_COMMANDS.some(p => p.test(command));
  if (!isCICheck) {
    return;
  }

  // Read transcript to find the tool output
  const transcriptPath = hookData.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return;
  }

  // Read last 50 lines of transcript (tool output should be recent)
  let output = '';
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    // Check last 50 entries for tool_result containing our output
    const recentLines = lines.slice(-50);
    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        // tool_result entries contain the output
        if (entry.type === 'tool_result' || entry.content) {
          const text = typeof entry.content === 'string'
            ? entry.content
            : JSON.stringify(entry.content || '');
          output += text + '\n';
        }
      } catch {
        // Not JSON, skip
      }
    }
  } catch {
    return;
  }

  // Check if output contains coverage failure patterns
  const hasCoverageFailure = COVERAGE_FAILURE_PATTERNS.some(p => p.test(output));

  if (hasCoverageFailure) {
    // Determine ticket ID from branch
    let ticketId = 'TICKET_ID';
    try {
      const { execSync } = require('child_process');
      const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
      const match = branch.match(new RegExp(config.TICKET_PROJECT_KEY + '-\\d+', 'i'));
      if (match) ticketId = match[0].toUpperCase();
    } catch { /* */ }

    console.log(`🛑 COVERAGE FAILURE DETECTED IN CI OUTPUT

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

Per /follow-up-pr section 4.3: ANY coverage-related CI failure → /test-coordination. No exceptions.`);
  }
}

main().catch(() => process.exit(0));
