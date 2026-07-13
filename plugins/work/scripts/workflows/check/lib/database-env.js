'use strict';

/**
 * check/lib/database-env.js — database container detection + startup for the
 * /check environment starter (extracted from hooks/check-start-env.js).
 */

const { execSync } = require('child_process');
const path = require('path');
const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
const { waitFor, spawnDetachedToLog, readLog } = require(path.join(__dirname, 'detached-spawn'));

const DB_START_TIMEOUT_MS = parseInt(process.env.CHECK_ENV_DB_TIMEOUT_MS, 10) || 30000;

// Database environment variables for integration tests (port will be detected dynamically)
const DB_ENV = {
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432', // Will be updated by detectDatabasePort()
  DATABASE_NAME: 'status-site',
  DATABASE_MASTER_USER_NAME: 'postgres',
  DATABASE_MASTER_PASSWORD: 'mypassword',
};

/** Execute a command synchronously (null on failure). */
function exec(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', ...options }).trim();
  } catch {
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
  const dbConfig = { ...DB_ENV };

  // Determine which container to use based on impacted apps
  // Priority: status-site > as-dashboard (since status-site is the main app)
  const containersToCheck = ['status-site', 'as-dashboard'];

  for (const containerName of containersToCheck) {
    const port = detectDatabasePort(containerName);
    if (port) {
      dbConfig.DATABASE_PORT = port;
      // Set database name based on container
      if (containerName === 'as-dashboard') {
        dbConfig.DATABASE_NAME = 'as-dashboard';
      }
      console.error(`Detected database on port ${port} (container: ${containerName})`);
      break;
    }
  }

  // If no container found, check if any postgres container is running
  if (dbConfig.DATABASE_PORT === '5432') {
    const postgresPort = exec(
      'docker ps --filter "expose=5432" --format "{{.Ports}}" | grep -oE "[0-9]+->5432" | head -1 | cut -d"-" -f1'
    );
    if (postgresPort) {
      dbConfig.DATABASE_PORT = postgresPort;
      console.error(`Detected generic postgres on port ${postgresPort}`);
    }
  }

  return dbConfig;
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

module.exports = { detectDatabaseConfig, startDatabase, isDatabaseRunning };
