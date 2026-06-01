'use strict';

/**
 * migrations profile (stub — GH-442 P0 #5).
 *
 * TODO: implement once a reference `docs/migrations.md` doc is
 * identified. Future direction: parse per-DB migration conventions
 * (Prisma, Knex, raw SQL) into PreToolUse memories that fire when the
 * agent is about to write a migration file under the project's
 * conventional migrations directory.
 */

function parse(/* text, sourcePath */) {
  return [];
}

function toMemory(/* item, ctx */) {
  return null;
}

module.exports = {
  name: 'migrations',
  description: 'Stub — future profile for docs/migrations.md. Currently emits zero memories.',
  sources: ['docs/migrations.md'],
  parse,
  toMemory,
};
