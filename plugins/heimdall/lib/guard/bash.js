'use strict';

/**
 * Bash write-detection: does a command write to a protected target?
 *
 * Directory entries require the absolute dir to appear (avoids matching a
 * same-named dir elsewhere). File entries match on basename alone (fail-closed,
 * mirroring the original protect-package-json hook).
 */

const {
  expandHomePaths,
  allRefsUnderAllowedPaths,
  markerOnlyInTempPaths,
  markerOnlyInForeignPaths,
  markerOnPathBoundary,
} = require('./paths');
const {
  normalizedVariants,
  commandGlobReferencesMarker,
  commandGlobReferencesPath,
} = require('./shell-normalize');

// Generic write-op templates; `MARKER` is replaced per protected marker.
const BASH_WRITE_TEMPLATES = [
  />\s*["']?[^|&;]*MARKER/i,
  /cat\s+.*>\s*["']?[^|&;]*MARKER/i,
  /echo\s+.*>\s*["']?[^|&;]*MARKER/i,
  /printf\s+.*>\s*["']?[^|&;]*MARKER/i,
  /tee\s+.*MARKER/i,
  /cp\s+.*MARKER/i,
  /mv\s+.*MARKER/i,
  /ln\s+.*MARKER/i,
  /install\s+.*MARKER/i,
  /rsync\s+.*MARKER/i,
  /sed\s+-i.*MARKER/i,
  /awk\s+.*>\s*["']?[^|&;]*MARKER/i,
  /perl\s+-[a-z]*i.*MARKER/i,
  /ruby\s+-[a-z]*i.*MARKER/i,
  /rm\s+.*MARKER/i,
  /rmdir\s+.*MARKER/i,
  /unlink\s+.*MARKER/i,
  /touch\s+.*MARKER/i,
  /mkdir\s+.*MARKER/i,
  /chmod\s+.*MARKER/i,
  /chown\s+.*MARKER/i,
  /dd\s+.*of=["']?[^|&;]*MARKER/i,
  /truncate\s+.*MARKER/i,
  /curl\s+.*-o\s*["']?[^|&;]*MARKER/i,
  /curl\s+.*--output\s*["']?[^|&;]*MARKER/i,
  /wget\s+.*-O\s*["']?[^|&;]*MARKER/i,
  /wget\s+.*--output-document\s*["']?[^|&;]*MARKER/i,
  /tar\s+.*-C\s*["']?[^|&;]*MARKER/i,
  /tar\s+.*--directory\s*["']?[^|&;]*MARKER/i,
  /unzip\s+.*-d\s*["']?[^|&;]*MARKER/i,
  // Interpreter invocations (node -e, python -c, perl/ruby -e, sh/bash -c, eval)
  // that merely NAME the marker are NOT writes — `node -e "require('X/.claude/c')"`
  // and `python -c "print(open('X/.claude/c').read())"` are pure reads. Their
  // actual writes carry a redirect (`>`, caught by the generic template above) or
  // a write API (caught by BASH_WRITE_GLOBAL below), so no bare-interpreter marker
  // template is needed here. Dropping them removes the highest-volume false
  // positive (read-only introspection). See GH-656.
  /cd\s+.*MARKER.*(?:&&|;|\|\||&)/i,
  /git\s+clone\s+.*MARKER/i,
  /git\s+checkout\s+.*MARKER/i,
  /git\s+pull\s+.*MARKER/i,
  /git\s+(?:apply|am|cherry-pick)\s+.*MARKER/i,
  /find\s+.*-exec\s+.*MARKER/i,
  /xargs\s+.*MARKER/i,
  /MARKER.*xargs/i,
  /patch\s+.*MARKER/i,
  /sponge\s+.*MARKER/i,
  /<<.*>\s*["']?[^|&;]*MARKER/i,
];

// Interpreter WRITE detection: a `node -e`/`python -c` invocation is a write
// only when its inline code calls a write API (not merely `open(`/`require`,
// which are reads). `open(` is required to carry a write mode ('w'/'a'/'x') so a
// read-open is not flagged. See GH-656.
const BASH_WRITE_GLOBAL = [
  /node\s+-e\s+.*(?:writeFileSync|appendFileSync|writeFile\b|createWriteStream|\brmSync|\bunlinkSync|\brenameSync)/i,
  /python[23]?\s+-c\s+.*(?:open\([^)]*,\s*['"][^'"]*(?:[wax]|r[^'"]*\+)|write_text|write_bytes|\.write\(|\.unlink|\.rename|\.replace\(|\.mkdir|shutil\.\w*copy|shutil\.move|shutil\.rmtree)/i,
];

// Bare interpreter tokens (node -e, python -c, sh -c, eval, …) are deliberately
// NOT generic write signals: naming a protected path inside an interpreter read
// (`node -e "require('X/.claude/c')"`) must not count as an absolute-path write.
// Real interpreter writes carry a redirect (`>`) or a write API (BASH_WRITE_GLOBAL)
// and are still detected. See GH-656.
const GENERIC_WRITE_RE =
  /(?:>{1,2}|>\||\btee\b|\bcp\b|\bmv\b|\brm\b|\brmdir\b|\btouch\b|\bmkdir\b|\bchmod\b|\bchown\b|\bln\b|\binstall\b|\brsync\b|\bdd\b|\btruncate\b|\bsed\s+-i|\bpatch\b|\bsponge\b|\bunlink\b|\bcurl\s+-o|\bcurl\s+--output|\bwget\s+-O|\bwget\s+--output|\btar\s+-C|\btar\s+--directory|\bunzip\s+-d|\bfind\s+.*-exec|\bxargs\b)/i;

const _patternCache = new Map();
function getPatternsForMarker(marker) {
  if (_patternCache.has(marker)) return _patternCache.get(marker);
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = BASH_WRITE_TEMPLATES.map(
    (tmpl) => new RegExp(tmpl.source.replace(/MARKER/g, escaped), tmpl.flags)
  );
  _patternCache.set(marker, patterns);
  return patterns;
}

function stripFdRedirects(command) {
  return command
    .replace(/\d+>&\d+/g, '')
    .replace(/\d+>\s*\/dev\/null/g, '')
    .replace(/\d+>>\s*\/dev\/null/g, '')
    .replace(/(^|[^0-9])>>\s*\/dev\/null/g, '$1')
    .replace(/1>\s*\/dev\/null/g, '')
    .replace(/(^|[^0-9])>\s*\/dev\/null/g, '$1');
}

function hasGenericWriteIntent(command) {
  return GENERIC_WRITE_RE.test(stripFdRedirects(command.replace(/\s*\n+\s*/g, ' ')));
}

/**
 * For cp/rsync/ln/install: is the protected path only the SOURCE (a read)?
 *
 * `mv` is deliberately excluded: it REMOVES the source, so moving a protected
 * file out (`mv <protected> /tmp/dest`) is a destructive write to the protected
 * path, not a read. Letting `mv` qualify here was a bypass — a protected file
 * could be relocated away with no unlock. The remaining commands leave the
 * source intact, so source-only references stay genuine reads.
 */
function isDirectionSensitiveRead(command, expanded, marker) {
  command = command.replace(/\s*\n+\s*/g, ' ');
  expanded = expanded.replace(/\s*\n+\s*/g, ' ');
  if (!/\b(?:cp|rsync|ln|install)\b/i.test(command)) return false;
  if (/\b(?:find\s+.*-exec|xargs|sh\s+-c|bash\s+-c|eval)\b/i.test(command)) return false;
  // Any shell separator/operator (| || & && ;) means the "last arg is the
  // destination" heuristic is unreliable — fail closed (not a pure read) so the
  // write-detection patterns still get a chance to match the protected path.
  if (/[|&;]/.test(command) || /["']/.test(command)) return false;
  if (/\s-t\s|--target-directory/.test(command)) return false;
  const args = expanded.trim().split(/\s+/);
  const lastArg = args[args.length - 1];
  if (marker.includes('/')) {
    if (lastArg === marker || lastArg.startsWith(marker + '/')) return false;
  } else {
    const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|/)${esc}(?:/|$)`).test(lastArg)) return false;
  }
  return true;
}

const READ_ONLY_CMDS =
  /^\s*(?:diff|cmp|comm|cat|head|tail|less|more|wc|stat|file|ls|grep|egrep|fgrep|rg|ag|find|md5sum|sha256sum|shasum|readlink|realpath|du|df|sort|uniq|tr|cut|jq|yq|strings|xxd|hexdump|od)\b/;
const WRITE_TOKENS =
  />{1,2}|>\||\btee\b|\bcp\b|\bmv\b|\brsync\b|\binstall\b|\bln\b|\brm\b|\brmdir\b|\bunlink\b|\btouch\b|\bmkdir\b|\bchmod\b|\bchown\b|\bdd\b|\btruncate\b|\bpatch\b|\bsponge\b|\bsed\s+-i|\bcurl\s+.*-o|\bwget\s+.*-O|\bnode\s+-e|\bpython[23]?\s+-c|\bperl\s+-e|\bruby\s+-e|\bsh\s+-c|\bbash\s+-c|\beval\b|\btar\s+.*-C|\bunzip\s+.*-d|\bxargs\b|\bfind\s+.*-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/i;

function isReadOnlyBashCommand(command) {
  const cleaned = stripFdRedirects(command.replace(/\s*\n+\s*/g, ' '));
  if (WRITE_TOKENS.test(cleaned)) return false;
  if (/\$\(|`|<\(|>\(|<<<|<</.test(cleaned)) return false;
  if (/;|&&|\|\|/.test(cleaned)) return false;
  for (const stage of cleaned.split('|')) {
    const trimmed = stage.trim();
    if (!trimmed || !READ_ONLY_CMDS.test(trimmed)) return false;
  }
  return true;
}

/**
 * All command variants for matching. `command`/`collapsed`/`expanded`/
 * `expandedCollapsed` are the named forms other heuristics key off; `all` is the
 * de-duplicated set of those PLUS shell-deobfuscated forms (dequoted,
 * single-char-class reduced, brace-expanded) so quote/backslash/brace/`[x]`
 * evasions collapse back to the literal path before matching. See GH-655.
 */
function commandVariants(command) {
  const collapsed = command.replace(/\s*\n+\s*/g, ' ');
  const expanded = expandHomePaths(command);
  const expandedCollapsed = expandHomePaths(collapsed);
  const all = new Set();
  for (const base of [command, collapsed, expanded, expandedCollapsed]) {
    for (const variant of normalizedVariants(base)) all.add(variant);
  }
  return { command, collapsed, expanded, expandedCollapsed, all: [...all] };
}

function anyMatches(patterns, v) {
  for (const p of patterns) {
    for (const s of v.all) {
      if (p.test(s)) return true;
    }
  }
  return false;
}

function markerWriteMatch(marker, v) {
  for (const pattern of getPatternsForMarker(marker)) {
    if (anyMatches([pattern], v) && !isDirectionSensitiveRead(v.command, v.expanded, marker))
      return true;
  }
  if (anyMatches(BASH_WRITE_GLOBAL, v) && !isDirectionSensitiveRead(v.command, v.expanded, marker))
    return true;
  return false;
}

// GH-642 boundary anchoring (getBoundaryPattern/markerOnPathBoundary) moved to
// ./paths so the Task-prompt and script-content lanes share it (GH-689).

function markerPresent(marker, v) {
  // Markers containing `/` are already path-qualified — a raw substring match is
  // safe and intentional (relative-path writes like `sed -i .claude/x`). Tested
  // over `v.all` so a dequoted/brace-expanded form is also caught, plus a
  // wildcard token that could expand onto the path (GH-655).
  if (marker.includes('/')) {
    for (const s of v.all) {
      if (s.includes(marker) || commandGlobReferencesPath(s, marker)) return true;
    }
    return false;
  }
  // Bare basenames anchor to a path boundary so short names (ui, db, api, lib,
  // src) no longer match a mid-word substring (build → "ui", require → "ui",
  // glibc → "lib") and wrongly flag unrelated commands (GH-642). Wildcard tokens
  // are matched only when anchored by a substantial literal prefix/suffix, so
  // `ls src/*` still does not flag `ui` (GH-655).
  for (const s of v.all) {
    if (markerOnPathBoundary(marker, s) || commandGlobReferencesMarker(s, marker)) return true;
  }
  return false;
}

/**
 * Is this marker eligible to be write-matched for the entry?
 *
 * Both files and directories match on marker presence (basename / relative
 * token), NOT on the absolute path appearing in the command. Requiring the
 * absolute path would let relative-path writes (e.g. `sed -i .claude/x`, which
 * is how commands usually reference repo paths) bypass directory guards.
 * Fail-closed: an unrelated same-named dir may occasionally match, but the user
 * can unlock — that is safer than silently missing a write.
 */
/**
 * GH-689 all-variant foreign exemption: the marker hit is exonerated only when
 * at least one variant of `v.all` contains the literal marker AND every
 * variant containing it classifies as foreign-only. Zero literal occurrences
 * (glob/quote-obfuscated presence) fail closed. Subsumes the GH-658 temp-path
 * exemption (classifier clause 2) and eliminates the cd-template trailing-
 * separator asymmetry.
 */
function markerForeignAcrossVariants(entry, marker, v) {
  let sawLiteral = false;
  for (const s of v.all) {
    if (!s.includes(marker)) continue;
    sawLiteral = true;
    if (!markerOnlyInForeignPaths(s, marker, entry)) return false;
  }
  return sawLiteral;
}

function markerEligible(entry, marker, v) {
  if (!markerPresent(marker, v)) return false;
  if (markerForeignAcrossVariants(entry, marker, v)) return false; // GH-689
  if (!entry.isFile && allRefsUnderAllowedPaths(v.expandedCollapsed, entry)) return false;
  return true;
}

function absolutePathWrite(entry, v, dirPresent) {
  return (
    dirPresent &&
    hasGenericWriteIntent(v.collapsed) &&
    !isDirectionSensitiveRead(v.command, v.expanded, entry.dir) &&
    !markerOnlyInTempPaths(v.expandedCollapsed, entry.dir) && // GH-658 temp parity
    !allRefsUnderAllowedPaths(v.expandedCollapsed, entry)
  );
}

function entryWriteMatch(entry, v) {
  const dirPresent =
    v.all.some((s) => s.includes(entry.dir)) ||
    v.all.some((s) => commandGlobReferencesPath(s, entry.dir));
  if (absolutePathWrite(entry, v, dirPresent)) return 'absolute-path';
  for (const marker of entry.markers) {
    if (!markerEligible(entry, marker, v)) continue;
    if (markerWriteMatch(marker, v)) return 'marker';
  }
  return null;
}

/** Every protected target the command writes to: [{ entry, matchType }, ...]. */
function bashTargets(command, entries) {
  if (!command) return [];
  const v = commandVariants(command);
  const out = [];
  for (const entry of entries) {
    const matchType = entryWriteMatch(entry, v);
    if (matchType) out.push({ entry, matchType });
  }
  return out;
}

/** First protected target the command writes to, or null. */
function bashTargetsProtectedTarget(command, entries) {
  return bashTargets(command, entries)[0] || null;
}

module.exports = {
  hasGenericWriteIntent,
  isReadOnlyBashCommand,
  bashTargets,
  bashTargetsProtectedTarget,
};
