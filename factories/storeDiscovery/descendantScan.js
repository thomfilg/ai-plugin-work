'use strict';

/**
 * descendantScan — the depth-1 fallback for a cwd that sits ABOVE the project.
 *
 * Split out of `storeDiscovery.js` so that file stays under the quality gate's
 * max-lines budget. One exported function, no state, no knowledge of the tier
 * geometry: the caller passes the roots to check, which keeps ROOT_DIR and
 * LEGACY_ROOT_DIR defined in exactly one place.
 *
 * @module factories/storeDiscovery/descendantScan
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * The ONE child of cwd, one level down, carrying `<child>/<root>/<folder>/
 * <marker>` for any of `roots` — '' when none does, or when several do.
 *
 * storeDiscovery's four tiers all resolve at or above cwd, which assumes cwd
 * sits at or below the project root. An agent CLI attaching several
 * repositories breaks that: it clones them side by side and parks cwd on their
 * shared parent, so a store one level down is invisible and the plugin reports
 * itself uninstalled with its memories sitting right there. The ancestor walk
 * looks the wrong way and the parent is no git repo, so neither existing tier
 * reaches it.
 *
 * AMBIGUITY IS A MISS, because guessing hurts both ways. Writers take the FIRST
 * store of a kind (`synapsys-memorize`, `crystallize-write --store=local`), so
 * a memory would land in whichever sibling sorts first. Readers flatten every
 * store into one list, so a sibling's memories — `enforce` rules that DENY tool
 * calls among them — would apply to this session. Two marked children give no
 * basis to choose between those outcomes, and nothing in the session breaks the
 * tie, so the honest answer is to resolve neither.
 *
 * ONE function serves both discovery and migration, for the reason the worktree
 * row states: two copies of a walk drift apart. Callers differ only in what
 * they build from the base, exactly as `ancestorStore` and
 * `ancestorMigrationBase` differ over the shared ancestor walk.
 *
 * Passing BOTH roots is what makes migration reach a child still at the legacy
 * root — the only case where the migration row does real work rather than
 * re-stamping a store that is already current. It also keeps the ambiguity
 * verdict a statement about how many projects sit under cwd, rather than how
 * many of them happen to have been migrated already, so discovery and migration
 * can never disagree about whether this cwd is ambiguous.
 *
 * Depth 1 only: one readdir plus a couple of existsSync per child, which is the
 * exact geometry those CLIs produce, and a deeper walk would charge real IO to
 * guess at a layout nobody asked for. Dot-directories are skipped, symlinked
 * children are skipped (isDirectory() is false for them) so no cycle is
 * followed, and an unreadable cwd is a miss rather than a throw.
 */
function descendantBase(spec, cwd, roots) {
  if (!spec.descendantScan) return '';
  let entries;
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return '';
  }
  const hits = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const base = path.join(cwd, entry.name);
    const marked = (root) => fs.existsSync(path.join(base, root, spec.folder, spec.marker));
    if (roots.some(marked)) hits.push(base);
  }
  return hits.length === 1 ? hits[0] : '';
}

module.exports = { descendantBase };
