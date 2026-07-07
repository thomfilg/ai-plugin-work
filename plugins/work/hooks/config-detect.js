#!/usr/bin/env node
// Fail-open SessionStart hook for work: stamps the session runtime, injects
// the plugin-root context line on codex (skills can't trust CLAUDE_PLUGIN_ROOT
// there), then runs the config nudge. Two-leg require for the nudge: vendored
// runtime lib first (works in cache-isolated installs where ../../../factories
// does not exist), factories/envConfig as the dev-tree fallback.
const fs = require('fs');
const path = require('path');

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function main() {
  const payload = readPayload();
  const pluginRoot = path.join(__dirname, '..');

  const runtime = require(path.join(pluginRoot, 'scripts', 'workflows', 'lib', 'runtime'));
  runtime.stampRuntime(payload);
  const rt = runtime.getRuntime(payload);
  if (rt.name === 'codex') {
    // PLUGIN_ROOT is the codex-injected install root (never set by Claude);
    // the __dirname-derived root is the fallback and points at the same
    // install because this hook file runs from it.
    rt.emit.context(
      'SessionStart',
      `plugin-root(work-workflow)=${path.resolve(process.env.PLUGIN_ROOT || pluginRoot)}`
    );
  }

  const cwd =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === 'string' && payload.cwd) ||
    process.cwd();
  let envconfig;
  try {
    envconfig = require(
      path.join(pluginRoot, 'scripts', 'workflows', 'lib', 'runtime', 'envconfig-lite')
    );
  } catch {
    envconfig = require('../../../factories/envConfig/sessionHook');
  }
  envconfig.main({ pluginRoot, configureCommand: '/work-workflow:configure', cwd });
}

try {
  main();
} catch {
  process.exit(0);
}
