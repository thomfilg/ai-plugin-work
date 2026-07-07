#!/usr/bin/env node
// heimdall config CLI — shared implementation in factories/envConfig on the
// dev tree. Cache installs (either runtime) have no factories/, which used to
// crash this script; they fall back to the vendored detect+nudge subset.
const path = require('node:path');

function fallbackMain() {
  const lite = require('../lib/runtime/envconfig-lite');
  const output = lite.run({
    pluginRoot: path.join(__dirname, '..'),
    configureCommand: '/heimdall:configure',
  });
  process.stdout.write(output ? `${output}\n` : 'config OK — nothing to configure\n');
}

try {
  require('../../../factories/envConfig/cli.js').mainFor(__dirname);
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  fallbackMain();
}
