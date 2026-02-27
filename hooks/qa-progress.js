#!/usr/bin/env node

/**
 * QA Progress Checkpointing Helper
 *
 * Tracks QA testing progress incrementally to enable resume on context loss.
 * Progress is stored in: $HOME/worktrees/tasks/{TICKET_ID}/.qa-progress-{APP}.json
 *
 * Usage:
 *   node qa-progress.js init PROJ-815 as-dashboard http://host.docker.internal:5173
 *   node qa-progress.js start-test PROJ-815 as-dashboard "navigation_test"
 *   node qa-progress.js complete-test PROJ-815 as-dashboard "navigation_test" pass "01-nav.png"
 *   node qa-progress.js fail-test PROJ-815 as-dashboard "navigation_test" "Element not found"
 *   node qa-progress.js infrastructure-failure PROJ-815 as-dashboard "Playwright unavailable"
 *   node qa-progress.js complete PROJ-815 as-dashboard pass
 *   node qa-progress.js get PROJ-815 as-dashboard
 */

const fs = require('fs');
const path = require('path');

const TASKS_BASE = `${process.env.HOME}/worktrees/tasks`;

/**
 * Get progress file path for a ticket/app
 */
function getProgressPath(ticketId, appName) {
  return path.join(TASKS_BASE, ticketId, `.qa-progress-${appName}.json`);
}

/**
 * Load progress for a ticket/app
 */
function loadProgress(ticketId, appName) {
  const progressPath = getProgressPath(ticketId, appName);
  if (fs.existsSync(progressPath)) {
    return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  }
  return null;
}

/**
 * Save progress for a ticket/app
 */
function saveProgress(ticketId, appName, progress) {
  const taskDir = path.join(TASKS_BASE, ticketId);
  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true });
  }

  progress.lastUpdate = new Date().toISOString();
  const progressPath = getProgressPath(ticketId, appName);
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
  return progress;
}

/**
 * Initialize QA progress for an app
 */
function initProgress(ticketId, appName, appUrl, testPlan = []) {
  const screenshotsDir = path.join(TASKS_BASE, ticketId, 'screenshots', appName);
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const progress = {
    ticketId,
    appName,
    appUrl,
    status: 'initializing',
    infrastructure: {
      playwrightChecked: false,
      playwrightOk: null,
      appReachable: null
    },
    testPlan,
    testsCompleted: [],
    testsInProgress: null,
    testsFailed: [],
    screenshots: [],
    errors: [],
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString()
  };

  return saveProgress(ticketId, appName, progress);
}

/**
 * Mark Playwright check result
 */
function setPlaywrightStatus(ticketId, appName, ok, error = null) {
  let progress = loadProgress(ticketId, appName);
  if (!progress) {
    progress = initProgress(ticketId, appName, '');
  }

  progress.infrastructure.playwrightChecked = true;
  progress.infrastructure.playwrightOk = ok;

  if (!ok) {
    progress.status = 'infrastructure_failure';
    progress.errors.push({
      type: 'playwright',
      error: error || 'Playwright unavailable',
      timestamp: new Date().toISOString()
    });
  } else {
    progress.status = 'playwright_ready';
  }

  return saveProgress(ticketId, appName, progress);
}

/**
 * Mark app reachability check result
 */
function setAppReachable(ticketId, appName, reachable, error = null) {
  let progress = loadProgress(ticketId, appName);
  if (!progress) {
    return { error: 'No progress found' };
  }

  progress.infrastructure.appReachable = reachable;

  if (!reachable) {
    progress.status = 'infrastructure_failure';
    progress.errors.push({
      type: 'app_unreachable',
      error: error || 'Application not reachable',
      timestamp: new Date().toISOString()
    });
  } else {
    progress.status = 'ready_to_test';
  }

  return saveProgress(ticketId, appName, progress);
}

/**
 * Start a test
 */
function startTest(ticketId, appName, testName) {
  let progress = loadProgress(ticketId, appName);
  if (!progress) {
    return { error: 'No progress found' };
  }

  progress.status = 'testing';
  progress.testsInProgress = {
    name: testName,
    startTime: new Date().toISOString()
  };

  return saveProgress(ticketId, appName, progress);
}

/**
 * Complete a test successfully
 */
function completeTest(ticketId, appName, testName, result, screenshot = null) {
  let progress = loadProgress(ticketId, appName);
  if (!progress) {
    return { error: 'No progress found' };
  }

  const completedTest = {
    name: testName,
    result,
    screenshot,
    completedAt: new Date().toISOString()
  };

  progress.testsCompleted.push(completedTest);
  progress.testsInProgress = null;

  if (screenshot) {
    progress.screenshots.push(screenshot);
  }

  // Remove from test plan if it was there
  progress.testPlan = progress.testPlan.filter(t => t !== testName);

  return saveProgress(ticketId, appName, progress);
}

/**
 * Mark a test as failed
 */
function failTest(ticketId, appName, testName, error, screenshot = null) {
  let progress = loadProgress(ticketId, appName);
  if (!progress) {
    return { error: 'No progress found' };
  }

  const failedTest = {
    name: testName,
    error,
    screenshot,
    failedAt: new Date().toISOString()
  };

  progress.testsFailed.push(failedTest);
  progress.testsInProgress = null;
  progress.errors.push({
    type: 'test_failure',
    test: testName,
    error,
    timestamp: new Date().toISOString()
  });

  if (screenshot) {
    progress.screenshots.push(screenshot);
  }

  return saveProgress(ticketId, appName, progress);
}

/**
 * Mark infrastructure failure
 */
function infrastructureFailure(ticketId, appName, error) {
  let progress = loadProgress(ticketId, appName);
  if (!progress) {
    progress = initProgress(ticketId, appName, '');
  }

  progress.status = 'infrastructure_failure';
  progress.errors.push({
    type: 'infrastructure',
    error,
    timestamp: new Date().toISOString()
  });

  return saveProgress(ticketId, appName, progress);
}

/**
 * Complete QA testing for an app
 */
function completeQA(ticketId, appName, overallResult) {
  let progress = loadProgress(ticketId, appName);
  if (!progress) {
    return { error: 'No progress found' };
  }

  progress.status = overallResult === 'pass' ? 'completed_pass' : 'completed_fail';
  progress.completedTime = new Date().toISOString();
  progress.testsInProgress = null;

  return saveProgress(ticketId, appName, progress);
}

/**
 * Get resume info for QA
 */
function getResumeInfo(ticketId, appName) {
  const progress = loadProgress(ticketId, appName);
  if (!progress) {
    return { exists: false };
  }

  return {
    exists: true,
    status: progress.status,
    canResume: ['testing', 'ready_to_test', 'playwright_ready'].includes(progress.status),
    completedTests: progress.testsCompleted.map(t => t.name),
    remainingTests: progress.testPlan,
    currentTest: progress.testsInProgress?.name || null,
    failedTests: progress.testsFailed.map(t => t.name),
    hasInfraFailure: progress.status === 'infrastructure_failure',
    lastError: progress.errors.length > 0 ? progress.errors[progress.errors.length - 1] : null,
    screenshots: progress.screenshots,
    lastUpdate: progress.lastUpdate
  };
}

/**
 * Format progress for display
 */
function formatProgress(progress) {
  if (!progress) {
    return 'No progress found';
  }

  const statusIcon = {
    'initializing': '🔄',
    'infrastructure_failure': '❌',
    'playwright_ready': '✅',
    'ready_to_test': '✅',
    'testing': '🔄',
    'completed_pass': '✅',
    'completed_fail': '❌'
  };

  let output = `
QA Progress: ${progress.appName}
════════════════════════════════════════════
Ticket: ${progress.ticketId}
Status: ${statusIcon[progress.status] || '❓'} ${progress.status}
URL: ${progress.appUrl}
Started: ${progress.startTime}
Last Update: ${progress.lastUpdate}

Infrastructure:
  Playwright: ${progress.infrastructure.playwrightOk === true ? '✅' : progress.infrastructure.playwrightOk === false ? '❌' : '⏳'}
  App Reachable: ${progress.infrastructure.appReachable === true ? '✅' : progress.infrastructure.appReachable === false ? '❌' : '⏳'}

Tests Completed (${progress.testsCompleted.length}):
`;

  progress.testsCompleted.forEach(t => {
    output += `  ✅ ${t.name}${t.screenshot ? ` [${t.screenshot}]` : ''}\n`;
  });

  if (progress.testsInProgress) {
    output += `\nIn Progress:\n  🔄 ${progress.testsInProgress.name}\n`;
  }

  if (progress.testsFailed.length > 0) {
    output += `\nFailed Tests (${progress.testsFailed.length}):\n`;
    progress.testsFailed.forEach(t => {
      output += `  ❌ ${t.name}: ${t.error}\n`;
    });
  }

  if (progress.testPlan.length > 0) {
    output += `\nRemaining Tests (${progress.testPlan.length}):\n`;
    progress.testPlan.forEach(t => {
      output += `  ⏳ ${t}\n`;
    });
  }

  if (progress.errors.length > 0) {
    output += `\nRecent Errors:\n`;
    progress.errors.slice(-3).forEach(e => {
      output += `  - [${e.type}] ${e.error}\n`;
    });
  }

  return output;
}

// CLI handler
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const ticketId = args[1];
  const appName = args[2];

  if (!command) {
    console.error('Usage: node qa-progress.js <command> <ticket-id> <app-name> [args...]');
    console.error('Commands: init, set-playwright, set-reachable, start-test, complete-test, fail-test, infrastructure-failure, complete, get, resume-info');
    process.exit(1);
  }

  let result;

  switch (command) {
    case 'init':
      const testPlan = args[4] ? JSON.parse(args[4]) : [];
      result = initProgress(ticketId, appName, args[3] || '', testPlan);
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'set-playwright':
      result = setPlaywrightStatus(ticketId, appName, args[3] === 'true', args[4]);
      console.log(JSON.stringify({ success: true, playwrightOk: args[3] === 'true' }));
      break;

    case 'set-reachable':
      result = setAppReachable(ticketId, appName, args[3] === 'true', args[4]);
      console.log(JSON.stringify({ success: true, appReachable: args[3] === 'true' }));
      break;

    case 'start-test':
      result = startTest(ticketId, appName, args[3]);
      console.log(JSON.stringify({ success: true, test: args[3], status: 'started' }));
      break;

    case 'complete-test':
      result = completeTest(ticketId, appName, args[3], args[4], args[5]);
      console.log(JSON.stringify({ success: true, test: args[3], result: args[4] }));
      break;

    case 'fail-test':
      result = failTest(ticketId, appName, args[3], args[4], args[5]);
      console.log(JSON.stringify({ success: true, test: args[3], status: 'failed' }));
      break;

    case 'infrastructure-failure':
      result = infrastructureFailure(ticketId, appName, args[3]);
      console.log(JSON.stringify({ success: true, status: 'infrastructure_failure' }));
      break;

    case 'complete':
      result = completeQA(ticketId, appName, args[3]);
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'get':
      result = loadProgress(ticketId, appName);
      if (args[3] === '--format') {
        console.log(formatProgress(result));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      break;

    case 'resume-info':
      result = getResumeInfo(ticketId, appName);
      console.log(JSON.stringify(result, null, 2));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

module.exports = {
  loadProgress,
  saveProgress,
  initProgress,
  setPlaywrightStatus,
  setAppReachable,
  startTest,
  completeTest,
  failTest,
  infrastructureFailure,
  completeQA,
  getResumeInfo
};
