#!/usr/bin/env node
/**
 * PreToolUse hook: Runs once at start of QA agent to clean up screenshot folder
 * Uses marker file with timestamp to ensure it only runs once per session
 */
const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', '..', 'lib', 'hook-error-log'));

const MARKER_FILE = '/tmp/qa-agent-active';
const MARKER_FRESHNESS_MS = 30 * 60 * 1000; // 30 minutes

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const cwd = hookData.cwd || process.cwd();

  // Freshness check and re-stamp go through ONE descriptor: 'a+' creates the
  // marker if it is missing, and fstat/truncate/write all address that same
  // open file, so nothing can swap /tmp/qa-agent-active in between. 0o600
  // keeps a marker in the shared temp dir out of other users' reach.
  const markerFd = fs.openSync(MARKER_FILE, 'a+', 0o600);
  try {
    const stat = fs.fstatSync(markerFd);
    const age = Date.now() - stat.mtimeMs;
    if (stat.size > 0 && age < MARKER_FRESHNESS_MS) {
      // Already ran recently, skip
      fs.closeSync(markerFd);
      process.exit(0);
    }

    // First tool call in this session - do cleanup
    // Update marker file
    const stamp = Buffer.from(new Date().toISOString());
    fs.ftruncateSync(markerFd, 0);
    fs.writeSync(markerFd, stamp, 0, stamp.length, 0);
  } finally {
    try {
      fs.closeSync(markerFd);
    } catch {
      /* already closed on the skip path */
    }
  }

  // Extract ticket ID from cwd (e.g., /home/node/worktrees/my-project-PROJ-854)
  const ticketMatch = cwd.match(/([A-Z]+-\d+)(?:$|\/)/);
  const ticketId = ticketMatch ? ticketMatch[1] : null;

  if (ticketId) {
    const getConfig = require(path.join(__dirname, '..', '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig.orExit('TASKS_BASE');
    const screenshotDir = path.join(tasksBase, ticketId, 'screenshots');

    if (fs.existsSync(screenshotDir)) {
      // Recursively clean all files in screenshots folder
      const cleanDir = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanDir(fullPath);
          } else if (entry.isFile()) {
            fs.unlinkSync(fullPath);
          }
        }
      };
      cleanDir(screenshotDir);
    } else {
      // Create the directory if it doesn't exist
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
  }

  process.exit(0);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0);
});
