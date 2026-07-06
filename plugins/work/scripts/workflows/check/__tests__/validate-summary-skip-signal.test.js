/**
 * 10_validate_summary — playwrightSkipSignal() resolution (GH-280 review finding)
 *
 * The skip signal must resolve WEB_APPS through lib/config (which loads .env
 * files), NOT a raw process.env read — otherwise a worktree whose WEB_APPS
 * lives in .env is treated as "no web apps" and Playwright evidence is
 * wrongly relaxed (or, inverted, wrongly required).
 *
 * Each case runs in a child process because lib/config snapshots the
 * environment at first require.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STEP_MODULE = path.resolve(__dirname, '..', 'lib', 'steps', 'validate-summary.js');

let TEMP;

before(() => {
  TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-summary-skip-'));
});

after(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});

/**
 * Evaluate playwrightSkipSignal() in a child process.
 * @param {object} opts
 * @param {string} [opts.webAppsEnv] - WEB_APPS value for process.env
 * @param {string} [opts.cwd] - working directory (for .env discovery)
 */
function skipSignalInChild({ webAppsEnv, cwd } = {}) {
  const env = { ...process.env };
  delete env.WEB_APPS;
  if (webAppsEnv !== undefined) env.WEB_APPS = webAppsEnv;
  const out = execFileSync(
    process.execPath,
    ['-e', `console.log(require(${JSON.stringify(STEP_MODULE)}).playwrightSkipSignal())`],
    { encoding: 'utf-8', timeout: 15000, env, cwd: cwd || TEMP }
  );
  return out.trim();
}

describe('validate-summary playwrightSkipSignal (dotenv-aware WEB_APPS resolution)', () => {
  it('is false when WEB_APPS is set in process.env', () => {
    const result = skipSignalInChild({
      webAppsEnv: JSON.stringify([{ name: 'my-app', defaultPort: 3000 }]),
    });
    assert.equal(result, 'false');
  });

  it('is false when WEB_APPS comes ONLY from a .env file (dotenv resolution)', () => {
    const dir = path.join(TEMP, 'with-dotenv');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.env'),
      `WEB_APPS='${JSON.stringify([{ name: 'dotenv-app', defaultPort: 3000 }])}'\n`
    );
    const result = skipSignalInChild({ cwd: dir });
    assert.equal(result, 'false', 'WEB_APPS from .env must be seen by the skip signal');
  });

  it('is true when no WEB_APPS anywhere (no web apps configured)', () => {
    const dir = path.join(TEMP, 'no-dotenv');
    fs.mkdirSync(dir, { recursive: true });
    const result = skipSignalInChild({ cwd: dir });
    assert.equal(result, 'true');
  });

  it('is true when WEB_APPS is an empty list', () => {
    const result = skipSignalInChild({ webAppsEnv: '[]' });
    assert.equal(result, 'true');
  });
});
