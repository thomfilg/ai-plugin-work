'use strict';

/**
 * Move the store out of the agent CLI config dir into `.workflow/`.
 *
 * v3.85.8 relocated every plugin store from `.claude/<folder>` to
 * `.workflow/<folder>`. Installs predating it keep their memories at the old
 * path, where discovery no longer looks — so without this they read as an
 * empty store.
 *
 * `relocateStore()` moves `legacyDir` → `dir` when the destination is absent,
 * and merges without clobbering (keeping the source) when it already exists.
 */

const path = require('node:path');
const { relocateStore } = require(path.join(__dirname, '..', 'storeMigration'));

module.exports = {
  description: 'move the store out of the agent CLI config dir into .workflow/',
  migrate: relocateStore(),
};
