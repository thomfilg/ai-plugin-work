#!/usr/bin/env node
/**
 * /check Environment Starter
 *
 * Starts the dev environment for /check:
 * - Starts database with make dev-local
 * - Starts impacted apps and captures their ports
 * - Returns RUNNING_APPS configuration
 *
 * Usage: node check-start-env.js <IMPACTED_APPS_JSON>
 *
 * Output: JSON object with running apps and their URLs
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));

process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  console.log(JSON.stringify({ error: 'uncaught exception', apps: {} }));
  process.exit(0);
});
process.on('unhandledRejection', (err) => {
  logHookError(__filename, err);
  console.log(JSON.stringify({ error: 'unhandled rejection', apps: {} }));
  process.exit(0);
});

// Get impacted apps from args
let IMPACTED_APPS;
try {
  IMPACTED_APPS = JSON.parse(process.argv[2] || '[]');
} catch {
  IMPACTED_APPS = [];
}

// Timeouts (env-overridable for tests/ops)
const APP_START_TIMEOUT_MS = parseInt(process.env.CHECK_ENV_APP_TIMEOUT_MS, 10) || 60000;
const READY_WAIT_MS = parseInt(process.env.CHECK_ENV_READY_WAIT_MS, 10) || 5000;

// Detached-process helpers live in ../lib/detached-spawn.js
const { sleep, waitFor, spawnDetachedToLog, readLog } = require(
  path.join(__dirname, '..', 'lib', 'detached-spawn')
);

/**
 * Derive ticket prefix (e.g., PROJ-964) from current worktree path or git branch.
 * Used to verify port ownership across concurrent worktrees.
 */
function getTicketPrefix() {
  const dirMatch = process.cwd().match(/([A-Z]+-\d+)/i);
  if (dirMatch) return dirMatch[1];
  const branch = exec('git rev-parse --abbrev-ref HEAD 2>/dev/null');
  const branchMatch = branch?.match(/([A-Z]+-\d+)/i);
  return branchMatch ? branchMatch[1] : null;
}
const TICKET_PREFIX = getTicketPrefix();

// App configurations - loaded from repo .env via app-access module
const { discoverApps, checkHealth } = require(path.join(__dirname, '..', 'lib', 'app-access'));
const { ACCESS_FAILED } = require(path.join(__dirname, '..', 'lib', 'app-access-status'));

// Database detection + startup live in ../lib/database-env.js
const { detectDatabaseConfig, startDatabase } = require(
  path.join(__dirname, '..', 'lib', 'database-env')
);

/**
 * Execute a command synchronously
 */
function exec(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', ...options }).trim();
  } catch (error) {
    return null;
  }
}

/**
 * Check if an app is already running on a port
 */
function isPortInUse(port) {
  const result = exec(`lsof -i :${port} -t 2>/dev/null`);
  return result && result.length > 0;
}

/**
 * Find the port used by OUR ticket's tmux dev session.
 * Searches for a tmux session named <TICKET_PREFIX>-*dev* and extracts the port
 * from its pane output (e.g., "localhost:5175").
 */
function findOurTmuxPort(appName) {
  if (!TICKET_PREFIX) return null;
  const sessions = exec('tmux list-sessions -F "#{session_name}" 2>/dev/null');
  if (!sessions) return null;
  const ourSession = sessions
    .split('\n')
    .find((s) => s.startsWith(TICKET_PREFIX) && s.includes('dev'));
  if (!ourSession) return null;
  const paneOutput = exec(`tmux capture-pane -t "${ourSession}" -p 2>/dev/null`);
  if (!paneOutput) return null;
  const portMatch = paneOutput.match(/localhost:(\d+)/);
  return portMatch ? parseInt(portMatch[1], 10) : null;
}

/**
 * Find an available port starting from default
 */
function findAvailablePort(startPort) {
  let port = startPort;
  while (isPortInUse(port) && port < startPort + 100) {
    port++;
  }
  return port;
}

/**
 * Start a web app and capture its port
 */
async function startApp(appName, appConfig) {
  if (isPortInUse(appConfig.defaultPort)) {
    // Verify whether OUR ticket's tmux session owns this port
    const ourPort = findOurTmuxPort(appName);
    if (ourPort === appConfig.defaultPort) {
      console.error(`Port ${appConfig.defaultPort} is our ${TICKET_PREFIX} server — reusing`);
      return {
        name: appName,
        port: appConfig.defaultPort,
        url: `http://host.docker.internal:${appConfig.defaultPort}`,
        alreadyRunning: true,
      };
    }
    // Another ticket's server occupies the default port — find an alternate
    console.error(`Port ${appConfig.defaultPort} owned by another ticket, finding alternate...`);
  }

  const port = findAvailablePort(appConfig.defaultPort);

  console.error(`Starting ${appName} on port ${port}...`);

  const startCmd = appConfig.startCommand || `pnpm dev --filter=${appName}`;
  const { proc, logPath } = spawnDetachedToLog(startCmd, `app-${appName}`, {
    PORT: port.toString(),
  });

  // Poll the child's log for the "Local:" URL (dev servers print their port)
  let actualPort = null;
  await waitFor(() => {
    const match = readLog(logPath).match(/Local:\s*http:\/\/localhost:(\d+)/);
    if (match) {
      actualPort = parseInt(match[1], 10);
      return true;
    }
    return false;
  }, APP_START_TIMEOUT_MS);

  if (actualPort !== null) {
    console.error(`${appName} started on port ${actualPort}`);
    return {
      name: appName,
      port: actualPort,
      url: `http://host.docker.internal:${actualPort}`,
      pid: proc.pid,
      started: true,
      logPath,
    };
  }

  if (isPortInUse(port)) {
    return {
      name: appName,
      port: port,
      url: `http://host.docker.internal:${port}`,
      pid: proc.pid,
      started: true,
      note: 'Started but did not detect URL output',
      logPath,
    };
  }

  return {
    name: appName,
    error: 'Timeout waiting for app to start',
    started: false,
    logPath,
  };
}

/**
 * Pick web apps to start — if none directly impacted, start all for mandatory
 * QA coverage (e.g., when only shared packages changed, all consumers must
 * be QA'd).
 */
function selectWebAppsToStart(appsMap) {
  const impacted = IMPACTED_APPS.filter((app) => appsMap[app]);
  if (impacted.length > 0) return impacted;

  const allWebApps = Object.keys(appsMap); // cli apps are already filtered out of appsMap
  if (IMPACTED_APPS.length > 0) {
    // Non-web apps or packages changed — start all web apps for mandatory QA
    if (allWebApps.length > 0) {
      console.error(
        `Package/non-web changes detected (${IMPACTED_APPS.join(', ')}) — starting all ${allWebApps.length} web apps for mandatory QA`
      );
      return allWebApps;
    }
    console.error(
      `Impacted changes detected (${IMPACTED_APPS.join(', ')}) but no WEB_APPS configured in .env — cannot start apps for QA`
    );
    return [];
  }
  // No impacted apps at all — start all web apps to avoid enforce-env-start-failure
  // treating empty runningApps as a failure
  if (allWebApps.length === 0) {
    console.error('No impacted apps and no WEB_APPS configured in .env — nothing to start');
    return [];
  }
  console.error(
    `No impacted apps detected — starting all ${allWebApps.length} web apps as default`
  );
  return allWebApps;
}

/** Start one app and gate it behind a health check before registering it. */
async function startAndHealthCheckApp(result, appName, appConfig) {
  const appResult = await startApp(appName, appConfig);
  result.apps[appName] = appResult;
  if (!appResult.started && !appResult.alreadyRunning) return;

  // Health-check gate
  const healthResult = await checkHealth(
    { ...appConfig, defaultPort: appResult.port },
    { host: 'localhost', retries: 3, retryInterval: 2000, timeout: 5000 }
  );

  if (healthResult.status === ACCESS_FAILED) {
    console.error(`Health check failed for ${appName}: ${healthResult.error || 'unknown'}`);
    result.apps[appName].healthCheckFailed = true;
    result.apps[appName].diagnostics = healthResult.diagnostics;
    return;
  }
  result.runningApps[appName] = {
    port: appResult.port,
    url: appResult.url,
    appType: appConfig.appType,
  };
}

/**
 * Main execution
 */
async function main() {
  // Detect database configuration based on running containers
  const detectedDbConfig = detectDatabaseConfig(IMPACTED_APPS);

  const result = {
    database: null,
    apps: {},
    env: detectedDbConfig,
    runningApps: {},
  };

  // Start database
  result.database = await startDatabase();

  // Re-detect after starting database (in case it wasn't running before)
  if (result.database.started) {
    await sleep(Math.min(3000, READY_WAIT_MS)); // Wait for container to be ready
    const updatedConfig = detectDatabaseConfig(IMPACTED_APPS);
    result.env = updatedConfig;
  }

  // Wait a bit for database to be fully ready
  await sleep(READY_WAIT_MS);

  // Discover apps from manifest via app-access module
  // Filter out CLI apps since they don't have dev servers to start
  const discoveredApps = discoverApps();
  const appsMap = Object.fromEntries(
    discoveredApps.filter((a) => a.appType !== 'cli').map((a) => [a.name, a])
  );

  const webAppsToStart = selectWebAppsToStart(appsMap);

  for (const appName of webAppsToStart) {
    await startAndHealthCheckApp(result, appName, appsMap[appName]);
  }

  // Output result
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main()
    .then(() => {
      // Explicit exit (check-start-env-zombies-001): started servers are
      // detached with their own log fds, so nothing here must keep running.
      // Without this the hook process lingered indefinitely (17 zombies/day).
      process.exit(0);
    })
    .catch((err) => {
      logHookError(__filename, err);
      process.exit(0);
    });
}

module.exports = {
  startApp,
  startDatabase,
  findAvailablePort,
  isPortInUse,
  detectDatabaseConfig,
};
