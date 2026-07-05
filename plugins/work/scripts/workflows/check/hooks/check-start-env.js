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
const DB_START_TIMEOUT_MS = parseInt(process.env.CHECK_ENV_DB_TIMEOUT_MS, 10) || 30000;
const APP_START_TIMEOUT_MS = parseInt(process.env.CHECK_ENV_APP_TIMEOUT_MS, 10) || 60000;
const READY_WAIT_MS = parseInt(process.env.CHECK_ENV_READY_WAIT_MS, 10) || 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `predicate` every `intervalMs` until truthy or `timeoutMs` elapses.
 * @returns {Promise<boolean>} last predicate result
 */
async function waitFor(predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Spawn a long-running server command DETACHED with its output redirected to
 * a log file instead of parent pipes.
 *
 * Zombie-leak fix (check-start-env-zombies-001): stdio 'pipe' streams keep
 * the parent hook's event loop alive for as long as the child runs — even
 * after child.unref() — so every /check run left this hook resident. Log-file
 * fds give the child a valid output target that survives parent exit, letting
 * the hook terminate while the started server keeps running.
 *
 * @returns {{ proc: import('child_process').ChildProcess, logPath: string }}
 */
function spawnDetachedToLog(command, label, extraEnv = {}) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-start-env-'));
  const logPath = path.join(logDir, `${label}.log`);
  const fd = fs.openSync(logPath, 'a', 0o600);
  const proc = spawn(command, {
    cwd: process.cwd(),
    shell: true,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  fs.closeSync(fd); // child holds its own copy of the fd
  proc.unref();
  return { proc, logPath };
}

/** Read a child's log file (best-effort). */
function readLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

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

// Database environment variables for integration tests (port will be detected dynamically)
const DB_ENV = {
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432', // Will be updated by detectDatabasePort()
  DATABASE_NAME: 'status-site',
  DATABASE_MASTER_USER_NAME: 'postgres',
  DATABASE_MASTER_PASSWORD: 'mypassword',
};

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
 * Check if database is already running
 */
function isDatabaseRunning() {
  const result = exec('docker ps --filter "name=postgres" --format "{{.Names}}"');
  return result && result.includes('postgres');
}

/**
 * Detect the actual database port from running Docker containers
 * @param {string} containerName - Name of the container to check (e.g., 'status-site', 'as-dashboard')
 * @returns {string|null} - The host port mapped to 5432, or null if not found
 */
function detectDatabasePort(containerName) {
  // Try to get the port mapping from Docker
  const portMapping = exec(`docker port ${containerName} 5432 2>/dev/null`);
  if (portMapping) {
    // Format is "0.0.0.0:5433" or "[::]:5433" - extract the port
    const match = portMapping.match(/:(\d+)/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Detect database configuration for impacted apps
 * Returns an object with database env vars, preferring status-site container
 * @param {string[]} impactedApps - List of impacted app names
 * @returns {object} - Database environment configuration
 */
function detectDatabaseConfig(impactedApps) {
  const config = { ...DB_ENV };

  // Determine which container to use based on impacted apps
  // Priority: status-site > as-dashboard (since status-site is the main app)
  const containersToCheck = ['status-site', 'as-dashboard'];

  for (const containerName of containersToCheck) {
    const port = detectDatabasePort(containerName);
    if (port) {
      config.DATABASE_PORT = port;
      // Set database name based on container
      if (containerName === 'as-dashboard') {
        config.DATABASE_NAME = 'as-dashboard';
      }
      console.error(`Detected database on port ${port} (container: ${containerName})`);
      break;
    }
  }

  // If no container found, check if any postgres container is running
  if (config.DATABASE_PORT === '5432') {
    const postgresPort = exec(
      'docker ps --filter "expose=5432" --format "{{.Ports}}" | grep -oE "[0-9]+->5432" | head -1 | cut -d"-" -f1'
    );
    if (postgresPort) {
      config.DATABASE_PORT = postgresPort;
      console.error(`Detected generic postgres on port ${postgresPort}`);
    }
  }

  return config;
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
 * Start database if not running
 */
async function startDatabase() {
  if (isDatabaseRunning()) {
    console.error('Database already running');
    return { started: false, alreadyRunning: true };
  }

  // Support custom dev commands per repo via config
  // e.g. DEV_COMMAND="~/g2i/scripts/dev-squire.sh" in .env
  const devCommand = config.DEV_COMMAND || 'make dev-local';
  console.error(`Starting database with ${devCommand}...`);

  const { proc, logPath } = spawnDetachedToLog(devCommand, 'database');

  const ready = await waitFor(() => {
    const log = readLog(logPath);
    if (log.includes('database system is ready') || log.includes('PostgreSQL init')) return true;
    return isDatabaseRunning();
  }, DB_START_TIMEOUT_MS);

  if (ready) {
    console.error('Database started');
    return { started: true, pid: proc.pid, logPath };
  }
  return { started: false, error: 'Timeout waiting for database', logPath };
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

  // Start web apps — if none directly impacted, start all for mandatory QA coverage
  // (e.g., when only shared packages changed, all consumers must be QA'd)
  let webAppsToStart = IMPACTED_APPS.filter((app) => appsMap[app]);

  if (webAppsToStart.length === 0 && IMPACTED_APPS.length > 0) {
    // Non-web apps or packages changed — start all web apps for mandatory QA
    const allWebApps = Object.keys(appsMap);
    if (allWebApps.length > 0) {
      console.error(
        // cli apps are already filtered out of appsMap
        `Package/non-web changes detected (${IMPACTED_APPS.join(', ')}) — starting all ${allWebApps.length} web apps for mandatory QA`
      );
      webAppsToStart = allWebApps;
    } else {
      console.error(
        `Impacted changes detected (${IMPACTED_APPS.join(', ')}) but no WEB_APPS configured in .env — cannot start apps for QA`
      );
    }
  } else if (webAppsToStart.length === 0) {
    // No impacted apps at all — start all web apps to avoid enforce-env-start-failure
    // treating empty runningApps as a failure
    const allWebApps = Object.keys(appsMap);
    if (allWebApps.length === 0) {
      console.error('No impacted apps and no WEB_APPS configured in .env — nothing to start');
    } else {
      console.error(
        `No impacted apps detected — starting all ${allWebApps.length} web apps as default`
      );
      webAppsToStart = allWebApps;
    }
  }

  for (const appName of webAppsToStart) {
    const appConfig = appsMap[appName];
    const appResult = await startApp(appName, appConfig);
    result.apps[appName] = appResult;

    if (appResult.started || appResult.alreadyRunning) {
      // Health-check gate
      const healthResult = await checkHealth(
        { ...appConfig, defaultPort: appResult.port },
        { host: 'localhost', retries: 3, retryInterval: 2000, timeout: 5000 }
      );

      if (healthResult.status === ACCESS_FAILED) {
        console.error(`Health check failed for ${appName}: ${healthResult.error || 'unknown'}`);
        result.apps[appName].healthCheckFailed = true;
        result.apps[appName].diagnostics = healthResult.diagnostics;
      } else {
        result.runningApps[appName] = {
          port: appResult.port,
          url: appResult.url,
          appType: appConfig.appType,
        };
      }
    }
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
