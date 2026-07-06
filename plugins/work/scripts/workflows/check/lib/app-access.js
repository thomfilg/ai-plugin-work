'use strict';

const http = require('http');
const { execSync } = require('child_process');
const config = require('../../lib/config');
const AppAccessStatus = require('./app-access-status');

/**
 * Validate a manifest entry for security and correctness.
 * @param {object} entry - App manifest entry
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateManifestEntry(entry) {
  const errors = [];

  // Port validation — required for web/api apps, optional for cli
  if (entry.defaultPort === undefined || entry.defaultPort === null) {
    if (entry.appType !== 'cli') {
      errors.push('defaultPort is required for web and api apps');
    }
  } else if (
    typeof entry.defaultPort !== 'number' ||
    entry.defaultPort < 1024 ||
    entry.defaultPort > 65535
  ) {
    errors.push(`Port ${entry.defaultPort} is outside valid range (1024-65535)`);
  }

  // Shell injection prevention for startCommand
  if (entry.startCommand) {
    const dangerousChars = /[;|<>`&\n\r]|\$[\({]/; // hardened regex — covers shell metacharacters
    if (dangerousChars.test(entry.startCommand)) {
      errors.push(`startCommand contains dangerous shell characters: ${entry.startCommand}`);
    }
  }

  // healthEndpoint path validation
  if (entry.healthEndpoint) {
    if (entry.healthEndpoint.startsWith('//')) {
      errors.push(`healthEndpoint must not start with "//": ${entry.healthEndpoint}`);
    }
    if (entry.healthEndpoint.includes('?')) {
      errors.push(`healthEndpoint must not contain query strings: ${entry.healthEndpoint}`);
    }
    if (!entry.healthEndpoint.startsWith('/')) {
      errors.push(`healthEndpoint must start with "/": ${entry.healthEndpoint}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Discover apps from WEB_APPS config with defaults applied.
 * Filters out invalid entries based on manifest validation.
 * @returns {Array<object>} Array of validated app configurations
 */
function discoverApps() {
  if (!config.WEB_APPS || !Array.isArray(config.WEB_APPS) || config.WEB_APPS.length === 0)
    return [];
  const map = config.webAppsMap();
  const entries = Object.entries(map).map(([name, fields]) => ({ name, ...fields }));
  return entries.filter((app) => {
    const validation = validateManifestEntry(app);
    if (!validation.valid) {
      console.error(
        `[app-access] Skipping invalid app "${app.name}": ${validation.errors.join(', ')}`
      );
      return false;
    }
    return true;
  });
}

/**
 * Perform an HTTP GET request with a timeout.
 * @param {string} url - URL to fetch
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{statusCode: number}>}
 */
function httpGet(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      resolve({ statusCode: res.statusCode });
      res.resume();
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

/**
 * Build a failure result with diagnostics.
 * @param {string} url
 * @param {string} healthEndpoint
 * @param {number} port
 * @param {number|null} responseCode
 * @param {string} error
 * @returns {object}
 */
function buildFailureResult(url, healthEndpoint, port, responseCode, error) {
  let lsofOutput = '';
  try {
    lsofOutput = execSync(`lsof -i :${port} -P -n 2>/dev/null | head -5`, {
      encoding: 'utf8',
      timeout: 3000,
    });
  } catch {
    /* ignore */
  }

  return {
    status: AppAccessStatus.ACCESS_FAILED,
    url,
    healthEndpoint,
    responseCode,
    error,
    diagnostics: { lsofOutput: lsofOutput.trim() },
  };
}

/**
 * One health-check attempt. Returns { ready, result } on 2xx/3xx, or
 * { ready: false, failure } describing the failed attempt.
 */
async function attemptHealthCheck({ url, timeout, host, port, healthEndpoint }) {
  try {
    const result = await httpGet(url, timeout);
    if (result.statusCode >= 200 && result.statusCode < 400) {
      return {
        ready: true,
        result: {
          status: AppAccessStatus.READY,
          url: `http://${host}:${port}`,
          healthEndpoint,
          responseCode: result.statusCode,
        },
      };
    }
    return {
      ready: false,
      failure: buildFailureResult(
        url,
        healthEndpoint,
        port,
        result.statusCode,
        `HTTP ${result.statusCode}`
      ),
    };
  } catch (err) {
    return {
      ready: false,
      failure: buildFailureResult(url, healthEndpoint, port, null, err.message),
    };
  }
}

/**
 * Perform a health check against an app with retries.
 * @param {object} app - App configuration from discoverApps
 * @param {object} options - Options for the health check
 * @returns {Promise<object>} Health check result
 */
async function checkHealth(app, options = {}) {
  const {
    timeout = 5000,
    retries = 3,
    retryInterval = 2000,
    host = 'host.docker.internal',
  } = options;
  const port = app.defaultPort;
  const healthEndpoint = app.healthEndpoint || '/';
  const url = `http://${host}:${port}${healthEndpoint}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const outcome = await attemptHealthCheck({ url, timeout, host, port, healthEndpoint });
    if (outcome.ready) return outcome.result;
    // Non-success status code / request error — fail only on the last attempt
    if (attempt === retries) return outcome.failure;
    // Wait before retry (only if not last attempt)
    await new Promise((resolve) => setTimeout(resolve, retryInterval));
  }

  // Guard: handle edge case where retries=0 (no iterations executed)
  return buildFailureResult(url, healthEndpoint, port, null, 'No retries configured');
}

/**
 * Classify the combined health/test result into the five-status taxonomy.
 * @param {object|null} healthResult - Result from checkHealth
 * @param {object|null} testResult - Result from test execution
 * @returns {string} One of AppAccessStatus values
 */
function classifyResult(healthResult, testResult) {
  if (!healthResult) return AppAccessStatus.NOT_CONFIGURED;
  if (healthResult.status === AppAccessStatus.ACCESS_FAILED) return AppAccessStatus.ACCESS_FAILED;
  if (healthResult.status !== AppAccessStatus.READY) return healthResult.status;

  // Health is READY — check test result
  if (!testResult) return AppAccessStatus.READY;
  if (testResult.passed) return AppAccessStatus.PASSED;
  return AppAccessStatus.TEST_FAILED;
}

/**
 * Build a structured access payload for the QA agent.
 * @param {object} app - App configuration from discoverApps
 * @param {object|null} healthResult - Result from checkHealth
 * @returns {object} Structured payload
 */
function buildAccessPayload(app, healthResult) {
  return {
    url: healthResult?.url || `http://host.docker.internal:${app.defaultPort}`,
    port: app.defaultPort,
    healthEndpoint: app.healthEndpoint || '/',
    appName: app.name,
    appType: app.appType || 'web',
    status: healthResult?.status || AppAccessStatus.NOT_CONFIGURED,
    diagnostics: healthResult?.diagnostics || null,
  };
}

/**
 * Ensure an app is running, self-starting it from the manifest when needed
 * (GH-213). This makes the QA path work standalone — /check's 2_start_env
 * becomes best-effort pre-warming instead of a hard prerequisite.
 *
 * Flow:
 *   1. No manifest entry for the app     → NOT_CONFIGURED (clean, no start attempt)
 *   2. Health check READY                → return payload (selfStarted: false)
 *   3. Otherwise start via manifest startCommand (check-start-env machinery),
 *      then re-run the health check     → READY (selfStarted: true) or ACCESS_FAILED
 *
 * @param {string} appName
 * @param {object} [options]
 * @param {object} [options.healthOptions] - passed to checkHealth (host/retries/timeout)
 * @param {Function} [options.discover]    - DI for tests (defaults to discoverApps)
 * @param {Function} [options.health]      - DI for tests (defaults to checkHealth)
 * @param {Function} [options.startApp]    - DI for tests (defaults to check-start-env's startApp)
 * @returns {Promise<object>} access payload + { selfStarted, startError? }
 */
async function ensureAppRunning(appName, options = {}) {
  const discover = options.discover || discoverApps;
  const health = options.health || checkHealth;

  const app = discover().find((a) => a.name === appName);
  if (!app) {
    return {
      appName,
      status: AppAccessStatus.NOT_CONFIGURED,
      selfStarted: false,
      reason: `No manifest entry for "${appName}" — add it to WEB_APPS in .env to enable QA`,
    };
  }

  const healthOptions = { host: 'localhost', ...options.healthOptions };

  // 1st pass — is it already running? (RUNNING_APPS is a hint, never a requirement)
  const initial = await health(app, healthOptions);
  if (initial.status === AppAccessStatus.READY) {
    return { ...buildAccessPayload(app, initial), selfStarted: false };
  }

  return selfStartAndRecheck({ appName, app, options, initial, health, healthOptions });
}

/**
 * Self-start via the same manifest-driven machinery /check's 2_start_env
 * uses, then re-run the health check against the port the server actually
 * took. Lazy require avoids a cycle (check-start-env requires this module).
 */
async function selfStartAndRecheck({ appName, app, options, initial, health, healthOptions }) {
  const startApp = options.startApp || require('../hooks/check-start-env').startApp;

  let startResult;
  try {
    startResult = await startApp(appName, app);
  } catch (err) {
    startResult = { started: false, error: err.message };
  }

  if (!startResult || (!startResult.started && !startResult.alreadyRunning)) {
    return {
      ...buildAccessPayload(app, initial),
      selfStarted: false,
      startError: startResult?.error || 'Failed to start app from manifest startCommand',
    };
  }

  // 2nd pass — health check against the port the server actually took
  const effectiveApp = { ...app, defaultPort: startResult.port || app.defaultPort };
  const after = await health(effectiveApp, healthOptions);
  return {
    ...buildAccessPayload(effectiveApp, after),
    selfStarted: true,
    ...(after.status !== AppAccessStatus.READY
      ? { startError: 'App started but health check still failing' }
      : {}),
  };
}

module.exports = {
  discoverApps,
  validateManifestEntry,
  checkHealth,
  classifyResult,
  buildAccessPayload,
  ensureAppRunning,
  AppAccessStatus,
};
