#!/usr/bin/env node
/**
 * /check-qa Standalone Env Bootstrap (GH-213, ECHO-5325 issue 3)
 *
 * Ensures a single app is running before QA, self-starting it from the
 * WEB_APPS manifest when /check's 2_start_env hasn't run (standalone
 * /check-qa, dead tmux session, retries, work-pr screenshot gate, ...).
 *
 * Usage: node check-ensure-app.js <APP_NAME>
 *
 * Output: JSON access payload { status, url, port, selfStarted, ... }
 * Exit codes:
 *   0 — READY (app reachable, QA may proceed)
 *   2 — NOT_CONFIGURED (no manifest entry — skip QA cleanly, not a failure)
 *   1 — ACCESS_FAILED (start attempted but app still unreachable)
 */

const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { ensureAppRunning, AppAccessStatus } = require(
  path.join(__dirname, '..', 'lib', 'app-access')
);

async function main() {
  const appName = process.argv[2];
  if (!appName) {
    console.error('Usage: node check-ensure-app.js <APP_NAME>');
    process.exit(1);
  }

  const result = await ensureAppRunning(appName);
  console.log(JSON.stringify(result, null, 2));

  if (result.status === AppAccessStatus.READY) process.exit(0);
  if (result.status === AppAccessStatus.NOT_CONFIGURED) process.exit(2);
  process.exit(1);
}

main().catch((err) => {
  logHookError(__filename, err);
  console.log(
    JSON.stringify({ status: 'ACCESS_FAILED', error: err.message, selfStarted: false }, null, 2)
  );
  process.exit(1);
});
