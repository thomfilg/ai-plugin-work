#!/usr/bin/env node
// work config CLI — shared implementation in factories/envConfig (dev tree).
// Cache-isolated installs (both runtimes) have no ../../../factories escape;
// fail with guidance instead of a MODULE_NOT_FOUND stack trace.
let cli;
try {
  cli = require('../../../factories/envConfig/cli.js');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /factories/.test(err.message)) {
    process.stderr.write(
      'work config CLI unavailable in this install (no factories/envConfig in the plugin cache).\n' +
        'Set the vars in your .envrc directly — they are declared in config-schema.json at the plugin root.\n'
    );
    process.exit(1);
  }
  throw err;
}
cli.mainFor(__dirname);
