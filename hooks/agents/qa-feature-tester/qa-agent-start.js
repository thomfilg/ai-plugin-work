#!/usr/bin/env node
/**
 * PreToolUse hook: Runs once at start of QA agent to clean up screenshot folder
 * Uses marker file with timestamp to ensure it only runs once per session
 */
const fs = require('fs');
const path = require('path');

const MARKER_FILE = '/tmp/qa-agent-active';
const MARKER_FRESHNESS_MS = 30 * 60 * 1000; // 30 minutes

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const cwd = hookData.cwd || process.cwd();

  // Check if marker is fresh (already ran recently)
  if (fs.existsSync(MARKER_FILE)) {
    const stat = fs.statSync(MARKER_FILE);
    const age = Date.now() - stat.mtimeMs;
    if (age < MARKER_FRESHNESS_MS) {
      // Already ran recently, skip
      process.exit(0);
    }
  }

  // First tool call in this session - do cleanup
  // Update marker file
  fs.writeFileSync(MARKER_FILE, new Date().toISOString());

  // Extract ticket ID from cwd (e.g., /home/node/worktrees/my-project-PROJ-854)
  const ticketMatch = cwd.match(/([A-Z]+-\d+)(?:$|\/)/);
  const ticketId = ticketMatch ? ticketMatch[1] : null;

  if (ticketId) {
    let _config;
    try { _config = require(path.join(__dirname, '..', '..', '..', 'lib', 'config')); } catch { _config = null; }
    const tasksBase = _config?.TASKS_BASE || `${process.env.HOME}/worktrees/tasks`;
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

main().catch(err => {
  console.error('Hook error:', err.message);
  process.exit(0);
});
