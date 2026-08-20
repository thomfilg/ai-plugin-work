'use strict';

/**
 * load — directory-backed migration discovery.
 *
 * One migration per file, in a folder, discovered by reading it. The
 * alternative — a hand-maintained array in one module — makes every new
 * migration edit the same lines, so two branches adding a migration always
 * conflict, and reviewing "what changed in the history" means diffing an
 * array instead of reading a new file.
 *
 * FILENAME IS THE VERSION. Files are named `<YYYYMMDDHHMMSS>_<slug>.js` and
 * the leading timestamp IS the migration version — one source of truth, so a
 * file cannot disagree with itself about when it runs. Timestamps (rather
 * than 0001, 0002, …) mean two branches authoring migrations on the same day
 * still get distinct, correctly-ordered versions instead of both claiming the
 * next integer. 14 digits is ~2.0e13, comfortably inside the safe-integer
 * range, so versions stay plain numbers.
 *
 * The slug is documentation: it shows up in `ls`, in the diff, and in the
 * default description.
 *
 * A module exports `{ migrate, description? }`. No `version` field — that
 * would be the same value written twice, free to drift.
 *
 * LOUD ON MALFORMED NAMES. A `.js` file whose name does not parse THROWS.
 * Silently skipping it is the worst available failure: the migration looks
 * committed, never runs, and the store is stamped as though it had. Non-`.js`
 * entries (a README, a subdirectory) are ignored, since those cannot be
 * mistaken for a migration that should have run.
 */

const fs = require('node:fs');
const path = require('node:path');

// <YYYYMMDDHHMMSS>_<kebab-slug>.js
const FILENAME_RE = /^(\d{14})_([a-z0-9][a-z0-9-]*)\.js$/;

function parseName(file) {
  const match = FILENAME_RE.exec(file);
  if (!match) {
    throw new Error(
      `storeMigration: "${file}" is not a valid migration filename — ` +
        'expected <YYYYMMDDHHMMSS>_<kebab-slug>.js'
    );
  }
  return { version: Number(match[1]), slug: match[2] };
}

/**
 * Read `dir` and return its migrations, ascending by version.
 * A missing directory yields [] — a plugin may adopt migrations before it
 * needs one. Every other problem throws: discovery must be all-or-nothing.
 */
function loadMigrations(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const migrations = entries
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const { version, slug } = parseName(file);
      const mod = require(path.join(dir, file));
      if (!mod || typeof mod.migrate !== 'function') {
        throw new Error(`storeMigration: "${file}" must export a "migrate" function`);
      }
      return {
        version,
        description: typeof mod.description === 'string' ? mod.description : slug,
        migrate: mod.migrate,
      };
    })
    .sort((a, b) => a.version - b.version);

  return migrations;
}

module.exports = { loadMigrations, FILENAME_RE };
