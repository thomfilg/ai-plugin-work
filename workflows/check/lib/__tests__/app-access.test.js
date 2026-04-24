'use strict';

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const config = require('../../../lib/config');
const AppAccessStatus = require('../app-access-status');

describe('discoverApps', () => {
  let discoverApps;
  let originalWebApps;

  beforeEach(() => {
    originalWebApps = config.WEB_APPS;
    // Clear require cache so module re-reads config each time
    delete require.cache[require.resolve('../app-access')];
    discoverApps = require('../app-access').discoverApps;
  });

  afterEach(() => {
    // restore config to prevent test pollution
    config.WEB_APPS = originalWebApps;
  });

  it('returns parsed entries with defaults from WEB_APPS config', () => {
    config.WEB_APPS = [{ name: 'my-app', defaultPort: 3000, type: 'vite' }];
    const apps = discoverApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, 'my-app');
    assert.equal(apps[0].defaultPort, 3000);
    assert.equal(apps[0].type, 'vite');
    assert.equal(apps[0].appType, 'web');
    assert.equal(apps[0].healthEndpoint, '/');
    assert.equal(apps[0].startCommand, 'pnpm dev --filter=my-app');
  });

  it('returns empty array when WEB_APPS is empty', () => {
    config.WEB_APPS = [];
    const apps = discoverApps();
    assert.deepStrictEqual(apps, []);
  });

  it('returns empty array when WEB_APPS is undefined', () => {
    config.WEB_APPS = undefined;
    const apps = discoverApps();
    assert.deepStrictEqual(apps, []); // empty when WEB_APPS undefined
  });

  it('returns entries for single-app repo', () => {
    config.WEB_APPS = [{ name: 'solo-app', defaultPort: 4000, type: 'remix', appType: 'api' }];
    const apps = discoverApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, 'solo-app');
    assert.equal(apps[0].appType, 'api');
    assert.equal(apps[0].healthEndpoint, '/health');
  });

  it('returns entries for multi-app repo', () => {
    config.WEB_APPS = [
      { name: 'app-a', defaultPort: 3000, type: 'vite' },
      { name: 'app-b', defaultPort: 3001, type: 'remix', appType: 'api' },
    ];
    const apps = discoverApps();
    assert.equal(apps.length, 2);
    assert.equal(apps[0].name, 'app-a');
    assert.equal(apps[1].name, 'app-b');
  });

  it('skips entries without name', () => {
    config.WEB_APPS = [
      { defaultPort: 3000, type: 'vite' },
      { name: 'valid-app', defaultPort: 3001, type: 'vite' },
      null,
      {},
    ];
    const apps = discoverApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, 'valid-app');
  });

  it('applies default healthEndpoint "/" for web appType', () => {
    config.WEB_APPS = [{ name: 'web-app', defaultPort: 3000, type: 'vite' }];
    const apps = discoverApps();
    assert.equal(apps[0].healthEndpoint, '/');
  });

  it('applies default healthEndpoint "/health" for api appType', () => {
    config.WEB_APPS = [{ name: 'api-app', defaultPort: 3000, type: 'vite', appType: 'api' }];
    const apps = discoverApps();
    assert.equal(apps[0].healthEndpoint, '/health');
  });

  it('preserves custom healthEndpoint when provided', () => {
    config.WEB_APPS = [
      { name: 'custom-app', defaultPort: 3000, type: 'vite', healthEndpoint: '/ready' },
    ];
    const apps = discoverApps();
    assert.equal(apps[0].healthEndpoint, '/ready');
  });

  it('preserves custom startCommand when provided', () => {
    config.WEB_APPS = [
      { name: 'custom-app', defaultPort: 3000, type: 'vite', startCommand: 'npm start' },
    ];
    const apps = discoverApps();
    assert.equal(apps[0].startCommand, 'npm start');
  });

  it('skips apps that fail manifest validation', () => {
    config.WEB_APPS = [
      { name: 'bad-app', defaultPort: 80, type: 'vite' },
      { name: 'good-app', defaultPort: 3000, type: 'vite' },
    ];
    const apps = discoverApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, 'good-app');
  });
});

describe('validateManifestEntry', () => {
  const { validateManifestEntry } = require('../app-access');

  it('valid entry passes validation', () => {
    const result = validateManifestEntry({
      name: 'my-app',
      defaultPort: 3000,
      healthEndpoint: '/health',
      startCommand: 'pnpm dev --filter=my-app',
    });
    assert.equal(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  // Shell injection tests
  it('rejects startCommand with semicolon', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev; rm -rf /',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with pipe', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev | cat /etc/passwd',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with &&', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev && rm -rf /',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with backticks', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev `whoami`',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with $()', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev $(whoami)',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with single & (background exec)', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev & malicious-cmd',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with newline', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev\nrm -rf /',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with carriage return', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev\rmalicious',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with > (output redirection)', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev > /tmp/out',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with < (input redirection)', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev < /tmp/in',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  it('rejects startCommand with ${VAR} (variable expansion)', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      startCommand: 'pnpm dev ${HOME}',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('dangerous shell characters')));
  });

  // Port range tests
  it('rejects port below 1024', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 80,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('outside valid range'));
  });

  it('rejects port above 65535', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 70000,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('outside valid range'));
  });

  it('accepts port in valid range', () => {
    const result = validateManifestEntry({
      name: 'good-app',
      defaultPort: 3000,
    });
    assert.equal(result.valid, true);
  });

  it('accepts port at lower boundary (1024)', () => {
    const result = validateManifestEntry({
      name: 'good-app',
      defaultPort: 1024,
    });
    assert.equal(result.valid, true);
  });

  it('accepts port at upper boundary (65535)', () => {
    const result = validateManifestEntry({
      name: 'good-app',
      defaultPort: 65535,
    });
    assert.equal(result.valid, true);
  });

  // healthEndpoint tests
  it('rejects healthEndpoint starting with "//"', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      healthEndpoint: '//evil.com',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('must not start with "//"')));
  });

  it('rejects healthEndpoint with query strings', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      healthEndpoint: '/health?token=abc',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('must not contain query strings')));
  });

  it('rejects healthEndpoint not starting with "/"', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 3000,
      healthEndpoint: 'health',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('must start with "/"')));
  });

  it('accepts valid healthEndpoint', () => {
    const result = validateManifestEntry({
      name: 'good-app',
      defaultPort: 3000,
      healthEndpoint: '/api/health',
    });
    assert.equal(result.valid, true);
  });

  it('requires defaultPort for web apps', () => {
    const result = validateManifestEntry({ name: 'web-app', appType: 'web' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('defaultPort is required')));
  });

  it('requires defaultPort for api apps', () => {
    const result = validateManifestEntry({ name: 'api-app', appType: 'api' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('defaultPort is required')));
  });

  it('allows missing defaultPort for cli apps', () => {
    const result = validateManifestEntry({ name: 'cli-tool', appType: 'cli' });
    assert.equal(result.valid, true);
  });

  it('requires defaultPort when appType is undefined (defaults to web)', () => {
    const result = validateManifestEntry({ name: 'no-type-app' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('defaultPort is required')));
  });

  it('returns multiple errors for multiple violations', () => {
    const result = validateManifestEntry({
      name: 'bad-app',
      defaultPort: 80,
      startCommand: 'pnpm dev; bad',
      healthEndpoint: 'no-slash',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 3);
  });
});

describe('classifyResult', () => {
  const { classifyResult } = require('../app-access');

  it('returns NOT_CONFIGURED when healthResult is null', () => {
    assert.equal(classifyResult(null, null), AppAccessStatus.NOT_CONFIGURED);
  });

  it('returns NOT_CONFIGURED when healthResult is undefined', () => {
    assert.equal(classifyResult(undefined, undefined), AppAccessStatus.NOT_CONFIGURED);
  });

  it('returns ACCESS_FAILED when healthResult status is ACCESS_FAILED', () => {
    const healthResult = { status: AppAccessStatus.ACCESS_FAILED };
    assert.equal(classifyResult(healthResult, null), AppAccessStatus.ACCESS_FAILED);
  });

  it('returns READY when health is READY and no testResult', () => {
    const healthResult = { status: AppAccessStatus.READY };
    assert.equal(classifyResult(healthResult, null), AppAccessStatus.READY);
  });

  it('returns READY when health is READY and testResult is undefined', () => {
    const healthResult = { status: AppAccessStatus.READY };
    assert.equal(classifyResult(healthResult, undefined), AppAccessStatus.READY);
  });

  it('returns PASSED when health is READY and testResult.passed is true', () => {
    const healthResult = { status: AppAccessStatus.READY };
    assert.equal(classifyResult(healthResult, { passed: true }), AppAccessStatus.PASSED);
  });

  it('returns TEST_FAILED when health is READY and testResult.passed is false', () => {
    const healthResult = { status: AppAccessStatus.READY };
    assert.equal(classifyResult(healthResult, { passed: false }), AppAccessStatus.TEST_FAILED);
  });

  it('passes through non-READY, non-ACCESS_FAILED status from healthResult', () => {
    const healthResult = { status: AppAccessStatus.NOT_CONFIGURED };
    assert.equal(classifyResult(healthResult, null), AppAccessStatus.NOT_CONFIGURED);
  });
});

describe('buildAccessPayload', () => {
  const { buildAccessPayload } = require('../app-access');

  it('returns structured payload with all fields from app and healthResult', () => {
    const app = { name: 'my-app', defaultPort: 3000, healthEndpoint: '/health', appType: 'api' };
    const healthResult = {
      status: AppAccessStatus.READY,
      url: 'http://host.docker.internal:3000',
      diagnostics: null,
    };
    const payload = buildAccessPayload(app, healthResult);
    assert.deepStrictEqual(payload, {
      url: 'http://host.docker.internal:3000',
      port: 3000,
      healthEndpoint: '/health',
      appName: 'my-app',
      appType: 'api',
      status: AppAccessStatus.READY,
      diagnostics: null,
    });
  });

  it('returns defaults when healthResult is null', () => {
    const app = { name: 'my-app', defaultPort: 3000 };
    const payload = buildAccessPayload(app, null);
    assert.equal(payload.url, 'http://host.docker.internal:3000');
    assert.equal(payload.port, 3000);
    assert.equal(payload.healthEndpoint, '/');
    assert.equal(payload.appName, 'my-app');
    assert.equal(payload.appType, 'web');
    assert.equal(payload.status, AppAccessStatus.NOT_CONFIGURED);
    assert.equal(payload.diagnostics, null);
  });

  it('includes diagnostics from healthResult when present', () => {
    const app = { name: 'my-app', defaultPort: 3000, appType: 'web' };
    const healthResult = {
      status: AppAccessStatus.ACCESS_FAILED,
      url: 'http://host.docker.internal:3000',
      diagnostics: { lsofOutput: 'node 1234 TCP *:3000' },
    };
    const payload = buildAccessPayload(app, healthResult);
    assert.deepStrictEqual(payload.diagnostics, { lsofOutput: 'node 1234 TCP *:3000' });
  });
});

describe('checkHealth', () => {
  const { checkHealth } = require('../app-access');
  /** @type {http.Server|null} */
  let server = null;
  /** @type {number} */
  let serverPort = 0;

  /**
   * Start a test HTTP server that responds with the given status code.
   * @param {number} statusCode
   * @returns {Promise<number>} The port the server is listening on
   */
  function startServer(statusCode) {
    return new Promise((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(statusCode);
        res.end('ok');
      });
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve(serverPort);
      });
    });
  }

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it('returns READY on successful health check (200 response)', async () => {
    const port = await startServer(200);
    const app = { name: 'test-app', defaultPort: port, healthEndpoint: '/' };
    const result = await checkHealth(app, { host: '127.0.0.1', retries: 1, timeout: 2000 });
    assert.equal(result.status, AppAccessStatus.READY);
    assert.equal(result.url, `http://127.0.0.1:${port}`);
    assert.equal(result.healthEndpoint, '/');
    assert.equal(result.responseCode, 200);
    await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  it('returns READY on 301 redirect response', async () => {
    const port = await startServer(301);
    const app = { name: 'test-app', defaultPort: port, healthEndpoint: '/' };
    const result = await checkHealth(app, { host: '127.0.0.1', retries: 1, timeout: 2000 });
    assert.equal(result.status, AppAccessStatus.READY);
    assert.equal(result.responseCode, 301);
    await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  it('returns ACCESS_FAILED after retries on connection refused', async () => {
    // Bind and immediately close a server to get a guaranteed-unused port
    const net = require('net');
    const srv = net.createServer();
    srv.listen(0);
    const unusedPort = srv.address().port;
    srv.close();
    const app = { name: 'test-app', defaultPort: unusedPort, healthEndpoint: '/' };
    const result = await checkHealth(app, {
      host: '127.0.0.1',
      retries: 1,
      retryInterval: 50,
      timeout: 1000,
    });
    assert.equal(result.status, AppAccessStatus.ACCESS_FAILED);
    assert.equal(result.responseCode, null);
    assert.ok(result.error);
    assert.ok(result.diagnostics);
  });

  it('returns ACCESS_FAILED on 503 response after retries', async () => {
    const port = await startServer(503);
    const app = { name: 'test-app', defaultPort: port, healthEndpoint: '/' };
    const result = await checkHealth(app, {
      host: '127.0.0.1',
      retries: 1,
      retryInterval: 50,
      timeout: 2000,
    });
    assert.equal(result.status, AppAccessStatus.ACCESS_FAILED);
    assert.equal(result.responseCode, 503);
    assert.equal(result.error, 'HTTP 503');
    await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  it('includes diagnostics with lsofOutput in failure result', async () => {
    const net = require('net');
    const srv = net.createServer();
    srv.listen(0);
    const unusedPort = srv.address().port;
    srv.close();
    const app = { name: 'test-app', defaultPort: unusedPort, healthEndpoint: '/' };
    const result = await checkHealth(app, {
      host: '127.0.0.1',
      retries: 1,
      retryInterval: 50,
      timeout: 1000,
    });
    assert.equal(result.status, AppAccessStatus.ACCESS_FAILED);
    assert.ok('lsofOutput' in result.diagnostics);
    assert.equal(typeof result.diagnostics.lsofOutput, 'string');
  });

  it('uses default healthEndpoint "/" when app has none', async () => {
    const port = await startServer(200);
    const app = { name: 'test-app', defaultPort: port };
    const result = await checkHealth(app, { host: '127.0.0.1', retries: 1, timeout: 2000 });
    assert.equal(result.healthEndpoint, '/');
    await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  it('returns ACCESS_FAILED when retries is 0', async () => {
    const app = { name: 'test-app', defaultPort: 59997, healthEndpoint: '/' };
    const result = await checkHealth(app, { host: '127.0.0.1', retries: 0, timeout: 1000 });
    assert.equal(result.status, AppAccessStatus.ACCESS_FAILED);
    assert.equal(result.error, 'No retries configured');
  });

  it('retries before failing on non-success status', async () => {
    let requestCount = 0;
    server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(500);
      res.end('error');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const app = { name: 'test-app', defaultPort: port, healthEndpoint: '/' };
    const result = await checkHealth(app, {
      host: '127.0.0.1',
      retries: 3,
      retryInterval: 50,
      timeout: 2000,
    });
    assert.equal(result.status, AppAccessStatus.ACCESS_FAILED);
    assert.equal(requestCount, 3);
    await new Promise((resolve) => server.close(resolve));
    server = null;
  });
});
