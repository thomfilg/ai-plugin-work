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
  } else if (typeof entry.defaultPort !== 'number' || entry.defaultPort < 1024 || entry.defaultPort > 65535) {
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
  if (!config.WEB_APPS || !Array.isArray(config.WEB_APPS) || config.WEB_APPS.length === 0) return [];
  const map = config.webAppsMap();
  const entries = Object.entries(map).map(([name, fields]) => ({ name, ...fields }));
  return entries.filter(app => {
    const validation = validateManifestEntry(app);
    if (!validation.valid) {
      console.error(`[app-access] Skipping invalid app "${app.name}": ${validation.errors.join(', ')}`);
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
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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
    lsofOutput = execSync(`lsof -i :${port} -P -n 2>/dev/null | head -5`, { encoding: 'utf8', timeout: 3000 });
  } catch { /* ignore */ }

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
 * Perform a health check against an app with retries.
 * @param {object} app - App configuration from discoverApps
 * @param {object} options - Options for the health check
 * @returns {Promise<object>} Health check result
 */
async function checkHealth(app, options = {}) {
  const { timeout = 5000, retries = 3, retryInterval = 2000, host = 'host.docker.internal' } = options;
  const port = app.defaultPort;
  const healthEndpoint = app.healthEndpoint || '/';
  const url = `http://${host}:${port}${healthEndpoint}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await httpGet(url, timeout);
      if (result.statusCode >= 200 && result.statusCode < 400) {
        return {
          status: AppAccessStatus.READY,
          url: `http://${host}:${port}`,
          healthEndpoint,
          responseCode: result.statusCode,
        };
      }
      // Non-success status code
      if (attempt === retries) {
        return buildFailureResult(url, healthEndpoint, port, result.statusCode, `HTTP ${result.statusCode}`);
      }
    } catch (err) {
      if (attempt === retries) {
        return buildFailureResult(url, healthEndpoint, port, null, err.message);
      }
    }
    // Wait before retry (only if not last attempt)
    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
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

module.exports = { discoverApps, validateManifestEntry, checkHealth, classifyResult, buildAccessPayload, AppAccessStatus };
