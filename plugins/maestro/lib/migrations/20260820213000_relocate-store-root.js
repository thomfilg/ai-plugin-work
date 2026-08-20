'use strict';

/**
 * Move the schema store out of the agent CLI config dir into `.workflow/`.
 *
 * v3.85.8 relocated every plugin store from `.claude/<folder>` to
 * `.workflow/<folder>`. Installs predating it keep their saved orchestration
 * schemas at the old path, where discovery no longer looks — so
 * `/maestro:orchestrate schema=<name>` stops resolving.
 */

const path = require('node:path');
const { relocateStore } = require(path.join(__dirname, '..', 'storeMigration'));

module.exports = {
  description: 'move the schema store out of the agent CLI config dir into .workflow/',
  migrate: relocateStore(),
};
