'use strict';

// TODO: Implement the migrations profile.
// Future direction: parse the repository migration conventions doc
// (e.g. `docs/migrations.md` or `db/README.md`) into atomic items per
// rule (naming convention, reversibility requirement, transactional
// wrapping, data-backfill ordering) and emit one synapsys memory per
// rule that fires on PreToolUse for Write/Edit of files under
// `migrations/**` or matching `*.sql`/`schema.prisma`/Knex migration
// patterns. Content matchers should key off the operation about to be
// authored (e.g. `ALTER TABLE`, `DROP COLUMN`, `addColumn`).

module.exports = {
  name: 'migrations',
  description: 'Stub profile for repository database migration conventions (not yet implemented).',
  sources: [],
  parse(_text, _sourcePath) {
    return [];
  },
  toMemory(_item, _ctx) {
    return null;
  },
};
