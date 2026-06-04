'use strict';

/**
 * Bash write-detection: does a command write to a protected target?
 *
 * Directory entries require the absolute dir to appear (avoids matching a
 * same-named dir elsewhere). File entries match on basename alone (fail-closed,
 * mirroring the original protect-package-json hook).
 */

const { expandHomePaths, allRefsUnderAllowedPaths } = require('./paths');

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
  /python[23]?\s+-c\s+.*MARKER/i,
  /MARKER.*python[23]?\s+-c/i,
  /node\s+-e\s+.*MARKER/i,
  /MARKER.*node\s+-e/i,
  /perl\s+-e\s+.*MARKER/i,
  /MARKER.*perl\s+-e/i,
  /ruby\s+-e\s+.*MARKER/i,
  /MARKER.*ruby\s+-e/i,
  /cd\s+.*MARKER.*(?:&&|;|\|\||&)/i,
  /sh\s+-c\s+.*MARKER/i,
  /MARKER.*sh\s+-c/i,
  /bash\s+-c\s+.*MARKER/i,
  /MARKER.*bash\s+-c/i,
  /eval\s+.*MARKER/i,
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

const BASH_WRITE_GLOBAL = [
  /node\s+-e\s+.*(?:writeFileSync|appendFileSync|writeFile|createWriteStream)/i,
  /python[23]?\s+-c\s+.*(?:open\(|write\(|\.write|write_text|write_bytes|\.unlink|\.rename|\.replace\(|\.mkdir|shutil\.\w*copy|shutil\.move|shutil\.rmtree)/i,
];

const GENERIC_WRITE_RE =
  /(?:>{1,2}|>\||\btee\b|\bcp\b|\bmv\b|\brm\b|\brmdir\b|\btouch\b|\bmkdir\b|\bchmod\b|\bchown\b|\bln\b|\binstall\b|\brsync\b|\bdd\b|\btruncate\b|\bsed\s+-i|\bpatch\b|\bsponge\b|\bunlink\b|\bcurl\s+-o|\bcurl\s+--output|\bwget\s+-O|\bwget\s+--output|\btar\s+-C|\btar\s+--directory|\bunzip\s+-d|\bfind\s+.*-exec|\bxargs\b|\bnode\s+-e\b|\bpython[23]?\s+-c\b|\bperl\s+-e\b|\bruby\s+-e\b|\bsh\s+-c\b|\bbash\s+-c\b|\beval\b)/i;

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

/** For cp/mv/rsync/ln/install: is the protected path only the SOURCE (a read)? */
function isDirectionSensitiveRead(command, expanded, marker) {
  command = command.replace(/\s*\n+\s*/g, ' ');
  expanded = expanded.replace(/\s*\n+\s*/g, ' ');
  if (!/\b(?:cp|mv|rsync|ln|install)\b/i.test(command)) return false;
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

/** All command variants (raw / expanded / collapsed) for matching. */
function commandVariants(command) {
  const collapsed = command.replace(/\s*\n+\s*/g, ' ');
  return {
    command,
    collapsed,
    expanded: expandHomePaths(command),
    expandedCollapsed: expandHomePaths(collapsed),
  };
}

function anyMatches(patterns, v) {
  for (const p of patterns) {
    if (
      p.test(v.command) ||
      p.test(v.expanded) ||
      p.test(v.collapsed) ||
      p.test(v.expandedCollapsed)
    ) {
      return true;
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

function markerPresent(marker, v) {
  return (
    v.command.includes(marker) ||
    v.expanded.includes(marker) ||
    v.collapsed.includes(marker) ||
    v.expandedCollapsed.includes(marker)
  );
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
function markerEligible(entry, marker, v) {
  if (!markerPresent(marker, v)) return false;
  if (!entry.isFile && allRefsUnderAllowedPaths(v.expandedCollapsed, entry)) return false;
  return true;
}

function absolutePathWrite(entry, v, dirPresent) {
  return (
    dirPresent &&
    hasGenericWriteIntent(v.collapsed) &&
    !isDirectionSensitiveRead(v.command, v.expanded, entry.dir) &&
    !allRefsUnderAllowedPaths(v.expandedCollapsed, entry)
  );
}

function entryWriteMatch(entry, v) {
  const dirPresent = v.expanded.includes(entry.dir) || v.expandedCollapsed.includes(entry.dir);
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
