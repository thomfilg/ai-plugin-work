#!/usr/bin/env node
// synapsys config CLI — shared implementation in factories/envConfig (dev
// tree). In a cache-isolated install (no factories/) the full configure flow
// is unavailable; degrade to the vendored detect-only pass instead of
// crashing with MODULE_NOT_FOUND.
try {
  require('../../../factories/envConfig/cli.js').mainFor(__dirname);
} catch (err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
  const path = require('node:path');
  const lite = require('../lib/runtime/envconfig-lite');
  const output = lite.run({
    pluginRoot: path.join(__dirname, '..'),
    configureCommand: '/synapsys:configure',
  });
  if (output) process.stdout.write(`${output}\n`);
  process.stderr.write(
    'synapsys config-cli: full configure flow requires the dev tree; ran the vendored detect-only pass\n'
  );
  process.exit(0);
}
