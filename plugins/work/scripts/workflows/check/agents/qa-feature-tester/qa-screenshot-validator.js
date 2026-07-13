#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', '..', 'lib', 'hook-error-log'));

/**
 * PostToolUse hook to validate QA screenshots
 *
 * After browser_snapshot is taken:
 * 1. Checks for error patterns in page content
 * 2. Classifies errors as transient vs non-transient
 * 3. Tracks retry attempts for transient errors (max 3)
 * 4. Warns the agent with appropriate guidance
 *
 * EXCEPTION: Skips warning if QA is intentionally testing error scenarios
 */

// function logExecution(data) {
//   const logFile = '/tmp/qa-screenshot-validator.txt';
//   const timestamp = new Date().toISOString();
//   const logEntry = `[${timestamp}] ${JSON.stringify(data)}\n`;
//   fs.appendFileSync(logFile, logEntry);
// }

// Patterns that indicate QA is intentionally testing errors
const TESTING_ERRORS_PATTERNS = [
  /test.*error/i,
  /error.*test/i,
  /verify.*error/i,
  /check.*error.*handling/i,
  /error.*scenario/i,
  /error.*state/i,
  /error.*boundary/i,
  /404.*page/i,
  /500.*page/i,
  /invalid.*input/i,
  /negative.*test/i,
  /edge.*case/i,
  /failure.*case/i,
];

// Transient errors: worth retrying (build/HMR issues, blank pages, connection refused)
const TRANSIENT_ERROR_PATTERNS = [
  /Module not found/i,
  /Cannot find module/i,
  /Compilation error/i,
  /HMR/i,
  /ECONNREFUSED/i,
  /Connection refused/i,
  /Unhandled Runtime Error/i,
  /Something went wrong/i,
  /Application Error/i,
  /TypeError:/,
  /ReferenceError:/,
  /SyntaxError:/,
  /Cannot read propert/i,
  /undefined is not/i,
  /null is not/i,
  /at\s+\w+\s+\(http/, // Stack trace pattern
  /Network Error/i,
];

// Non-transient errors: do NOT retry, mark FAIL immediately
const NON_TRANSIENT_ERROR_PATTERNS = [
  /404 Not Found/i,
  /401 Unauthorized/i,
  /403 Forbidden/i,
  /500 Internal Server Error/i,
  /Database.*error/i,
  /ECONNRESET/i,
];

// Combined for backward compat
const ERROR_PATTERNS = [...TRANSIENT_ERROR_PATTERNS, ...NON_TRANSIENT_ERROR_PATTERNS];

const RETRY_STATE_FILE = '/tmp/qa-snapshot-retry-state.json';
const LAST_URL_FILE = '/tmp/qa-last-navigated-url';

const LOADING_PATTERNS = [/Loading\.\.\./i, /Please wait/i, /Fetching/i];

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    // logExecution({ event: 'parse_error', input: input.substring(0, 200) });
    // Can't parse, just continue
    console.log(JSON.stringify({}));
    return;
  }

  const toolName = hookData.tool_name;
  const rawResponse = hookData.tool_response;
  const toolOutput =
    typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse || '');

  // Log disabled - uncomment logExecution function and this to debug
  // logExecution({
  //   event: 'hook_called',
  //   tool: toolName,
  //   responseType: typeof rawResponse,
  //   outputLength: toolOutput.length,
  //   preview: toolOutput.substring(0, 200)
  // });

  // Only check snapshot/page-read results
  const VALIDATED_TOOLS = [
    'mcp__playwright__browser_snapshot',
    'mcp__chrome-devtools__take_snapshot',
    'mcp__claude-in-chrome__read_page',
    'mcp__claude-in-chrome__get_page_text',
  ];
  if (!VALIDATED_TOOLS.includes(toolName)) {
    console.log(JSON.stringify({}));
    return;
  }

  const errors = [];
  const warnings = [];

  // Check if this looks like intentional error testing
  // (based on context clues in the snapshot content or tool input)
  const toolInput = hookData.tool_input || {};
  const inputStr = JSON.stringify(toolInput).toLowerCase();

  let isTestingErrors = false;
  for (const pattern of TESTING_ERRORS_PATTERNS) {
    if (pattern.test(toolOutput) || pattern.test(inputStr)) {
      isTestingErrors = true;
      break;
    }
  }

  // Check for error patterns
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(toolOutput)) {
      errors.push(`Error detected: ${pattern.toString()}`);
    }
  }

  // Check for loading patterns (might indicate content didn't load)
  for (const pattern of LOADING_PATTERNS) {
    if (pattern.test(toolOutput)) {
      warnings.push(`Loading indicator found - content may not have fully loaded`);
    }
  }

  // Skip warning if QA is intentionally testing error scenarios
  if (isTestingErrors && errors.length > 0) {
    console.log(
      JSON.stringify({
        message: '\n✓ Error state detected (expected - testing error scenario)\n',
      })
    );
    return;
  }

  if (errors.length > 0 || warnings.length > 0) {
    // Classify: is this a transient or non-transient error?
    const isTransient =
      errors.some((e) => TRANSIENT_ERROR_PATTERNS.some((p) => e.includes(p.toString()))) &&
      !errors.some((e) => NON_TRANSIENT_ERROR_PATTERNS.some((p) => e.includes(p.toString())));
    const isWarningOnly = errors.length === 0 && warnings.length > 0;
    // Track retry state for transient errors (only for actual errors, not warnings)
    let retryCount = 0;
    let currentUrl = 'unknown';
    try {
      currentUrl = fs.readFileSync(LAST_URL_FILE, 'utf8').trim();
    } catch {
      // No URL tracked yet — fall back to 'unknown'
    }
    if (isTransient) {
      try {
        const state = fs.existsSync(RETRY_STATE_FILE)
          ? JSON.parse(fs.readFileSync(RETRY_STATE_FILE, 'utf8'))
          : {};
        retryCount = (state[currentUrl] || 0) + 1;
        state[currentUrl] = retryCount;
        fs.writeFileSync(RETRY_STATE_FILE, JSON.stringify(state));
      } catch {
        retryCount = 1;
      }
    }

    let actionLines;
    if (isWarningOnly) {
      // Warning-only (e.g., loading indicators): suggest waiting, not failing
      actionLines = [
        'LOADING/WARNING detected — content may not have fully loaded:',
        '  • Wait a few seconds for the page to finish loading',
        '  • Take a new snapshot to verify content rendered',
        '  • Only mark FAIL if content never loads after retrying',
      ];
    } else if (!isTransient) {
      // Non-transient: fail immediately, no retry
      actionLines = [
        'NON-TRANSIENT ERROR — mark FAIL immediately, do NOT retry:',
        '  • Document this error in your QA report',
        '  • Mark the test as FAIL',
        '  • Check console messages for details',
      ];
    } else if (retryCount < 3) {
      // Transient: suggest retry
      actionLines = [
        `TRANSIENT ERROR — retry attempt ${retryCount}/3:`,
        '  • Wait 30 seconds, then refresh the page',
        '  • Take a new snapshot to check if error persists',
        '  • Dev servers often fail on first render',
      ];
    } else {
      // Transient but exhausted retries
      actionLines = [
        'TRANSIENT ERROR — all 3 retries exhausted:',
        '  • Mark this test as FAIL',
        '  • Document error in QA report with retry history',
        '  • Check console messages for root cause',
      ];
      // Reset retry state for this URL
      try {
        const state = JSON.parse(fs.readFileSync(RETRY_STATE_FILE, 'utf8'));
        delete state[currentUrl];
        fs.writeFileSync(RETRY_STATE_FILE, JSON.stringify(state));
      } catch {
        /* ignore */
      }
    }

    const message = [
      '',
      'QA SNAPSHOT VALIDATION',
      '─'.repeat(50),
      ...errors.map((e) => `  ${e}`),
      ...warnings.map((w) => `  ${w}`),
      '',
      ...actionLines,
      '─'.repeat(50),
    ].join('\n');

    console.log(JSON.stringify({ message }));
    return;
  }

  // No errors — clear retry state for the current URL only (preserve other URLs' retry history)
  try {
    if (fs.existsSync(RETRY_STATE_FILE)) {
      let currentUrl = 'unknown';
      try {
        currentUrl = fs.readFileSync(LAST_URL_FILE, 'utf8').trim();
      } catch {
        /* no URL tracked */
      }
      const retryState = JSON.parse(fs.readFileSync(RETRY_STATE_FILE, 'utf8'));
      delete retryState[currentUrl];
      if (Object.keys(retryState).length === 0) {
        fs.unlinkSync(RETRY_STATE_FILE);
      } else {
        fs.writeFileSync(RETRY_STATE_FILE, JSON.stringify(retryState));
      }
    }
  } catch {
    /* ignore */
  }

  console.log(JSON.stringify({}));
}

main().catch((err) => {
  logHookError(__filename, err);
  console.error('QA validator error:', err.message);
  console.log(JSON.stringify({}));
});
