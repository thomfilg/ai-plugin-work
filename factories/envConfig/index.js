'use strict';

/**
 * factories/envConfig — declarative env-var configuration for plugins.
 *
 * A plugin declares its user-facing environment variables once, in a
 * `config-schema.json` at its root; this factory provides everything the
 * table enables: startup validation with typo suggestions, new-variable
 * detection against a persistent hash cache, .envrc/.env generation, a
 * shared SessionStart hook runner, and a non-blocking update banner.
 */

module.exports = {
  ...require('./schema'),
  ...require('./envFiles'),
  ...require('./validate'),
  ...require('./detect'),
  ...require('./render'),
  sessionHook: require('./sessionHook'),
  updateCheck: require('./updateCheck'),
};
