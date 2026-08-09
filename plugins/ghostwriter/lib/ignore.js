'use strict';

/**
 * ignore.js — the files an operator has declared out of scope.
 *
 * The file rules read what a change WRITES, and some files legitimately carry
 * the strings those rules match: a document about attribution policy, a
 * changelog quoting a footer it removed, a fixture that has to contain the
 * thing under test. A repository that documents this rule set is the clearest
 * case, and it is also the repository most likely to want the guard on.
 *
 * Without a scoped opt-out the only answer to a false positive is
 * GHOSTWRITER_ALLOW_ATTRIBUTION=1, which turns off every rule everywhere. A
 * path list is the smaller instrument: the exemption is written down, reviewed
 * in the diff like anything else, and bounded to the files that need it.
 *
 * `.ghostwriterignore` sits at the repository root — one pattern per line,
 * `#` comments, blank lines ignored:
 *
 *   docs/attribution-policy.md     one file
 *   plugins/ghostwriter/**         a subtree
 *   *.snap                         a basename, anywhere
 *
 * Deliberately simpler than gitignore: no negation, no anchoring rules to
 * remember. A pattern containing `/` matches the repository-relative path; one
 * without matches the basename at any depth. It exempts files from the FILE
 * rules only — a commit message, a pull request body and a committing identity
 * are never covered by it, because no path can excuse those.
 */

const fs = require('node:fs');
const path = require('node:path');

const IGNORE_FILE = '.ghostwriterignore';
/** Bounded so a runaway symlink or a detached mount cannot walk forever. */
const MAX_WALK_UP = 25;

/** Compile one line into a full-match regex over a `/`-separated path. */
function patternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**` is parked on a sentinel first, so the single-`*` pass that follows
    // cannot eat half of it. The sentinel is a control character: a space would
    // not do, since a space is a legal character in a filename.
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '.*');
  // A trailing `/` or `/**` names a subtree; both forms cover its contents.
  const body = pattern.endsWith('/') ? `${escaped}.*` : escaped;
  return new RegExp(`^${body}$`);
}

function parse(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => ({
      basenameOnly: !line.includes('/'),
      re: patternToRegExp(line.replace(/^\.\//, '')),
    }));
}

/**
 * The one `.ghostwriterignore` that applies to work happening in `from`.
 *
 * Inside a repository that is the ROOT list and only the root list. A nested
 * one is not a scoping convenience here, it is a way to grant yourself an
 * exemption: writing `sub/.ghostwriterignore` is not itself attribution, so
 * nothing stops it, and every later write under `sub/` would be excused by a
 * line nobody reviewed. Same shape as an override set inside the command it is
 * meant to override, and refused for the same reason. One list, at the root,
 * in the diff with the files it covers.
 *
 * The repository boundary matters in the other direction too: a checkout below
 * a directory that happens to hold an ignore file must not adopt rules written
 * for something else. Outside a repository altogether — a bare directory, a
 * test fixture — the nearest list is the only sensible answer, and is used.
 */
function findIgnoreFile(from) {
  let dir = path.resolve(from || process.cwd());
  let nearest = null;
  for (let depth = 0; depth < MAX_WALK_UP; depth++) {
    const candidate = path.join(dir, IGNORE_FILE);
    const found = fs.existsSync(candidate) ? { root: dir, file: candidate } : null;
    if (found && !nearest) nearest = found;
    // A repository root ends the search and answers it: whatever list lives
    // here is the list, and one found lower down does not count.
    if (fs.existsSync(path.join(dir, '.git'))) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return nearest;
}

/**
 * Load the rules that apply to work happening in `cwd`.
 *
 * A hook process handles one payload, so the read is memoized per directory
 * for the life of the process and never has to be invalidated.
 */
const cache = new Map();

function loadIgnore(cwd) {
  const key = path.resolve(cwd || process.cwd());
  if (cache.has(key)) return cache.get(key);
  let rules = { root: key, patterns: [] };
  try {
    const found = findIgnoreFile(key);
    if (found) rules = { root: found.root, patterns: parse(fs.readFileSync(found.file, 'utf8')) };
  } catch {
    // An unreadable ignore file exempts nothing. Failing the other way would
    // let an unreadable file switch the rules off silently.
  }
  cache.set(key, rules);
  return rules;
}

/** Test seam: a hook process is one-shot, but a test suite is not. */
function resetIgnoreCache() {
  cache.clear();
}

/**
 * Is this path exempt from the FILE rules? Never throws.
 *
 * `ignoreFrom` takes the LIST from another tree while still judging paths in
 * this one. A checker run against a known-good tree uses it so that a change
 * cannot add an attribution-bearing file and the line exempting it in the same
 * breath — an exemption that clears itself is not an exemption anyone
 * reviewed. Left unset, the list is the working tree's own, which is what
 * makes it editable at all.
 */
function isIgnored(filePath, cwd, ignoreFrom) {
  if (!filePath || typeof filePath !== 'string') return false;
  const rules = loadIgnore(ignoreFrom || cwd);
  if (!rules.patterns.length) return false;
  // A relative path is relative to where the work is happening, not to where
  // the ignore file was found — the patterns are repository-rooted, the path
  // is not, and resolving both against the same directory silently mismatches
  // every path given from a subdirectory.
  const absolute = path.resolve(cwd || process.cwd(), filePath);
  // Patterns are repository-relative. When the list came from another tree the
  // paths being judged still belong to THIS one, so they are made relative to
  // its root rather than to wherever the list was found.
  const matchRoot = ignoreFrom ? path.resolve(cwd || process.cwd()) : rules.root;
  const relative = path.relative(matchRoot, absolute).split(path.sep).join('/');
  // Outside the repository the patterns describe: nothing to match against.
  if (relative.startsWith('../')) return false;
  const base = path.posix.basename(relative);
  return rules.patterns.some((rule) => rule.re.test(rule.basenameOnly ? base : relative));
}

module.exports = { isIgnored, loadIgnore, resetIgnoreCache, patternToRegExp, IGNORE_FILE };
