#!/usr/bin/env node
/**
 * heimdall-conceal — PreToolUse hook (plugin). Deny agent reads of protected secrets.
 *
 * Config-driven and SAFE-BY-DEFAULT-OFF: if the target project has no
 * `.claude/heimdall-conceal.json`, this hook is a no-op, so installing the
 * plugin globally never breaks unrelated repos.
 *
 * Scoping (avoids false positives):
 *   - File tools (Read/Grep/Glob/Edit/Write/MultiEdit): scan ONLY the target
 *     path — block reading/writing the secrets *file*, not files whose content
 *     merely mentions a secret's name.
 *   - Bash: scan the whole command (file name, /proc environ, password var).
 *
 * Layer 2 (defense-in-depth + audit). The hard wall is the OS uid boundary
 * installed by setup-secrets-heimdall.sh; reads that slip past pattern-matching
 * still hit EACCES there. Blocks are logged to <project>/.claude/heimdall-conceal.log.
 *
 * Block protocol: exit 2 + stderr → Claude Code denies the tool call.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizedVariants,
  commandGlobReferencesMarker,
  commandGlobReferencesPath,
} = require('../lib/guard/shell-normalize');

// Try to load the conceal config at <dir>/.claude/heimdall-conceal.json.
// Returns the parsed config (stamped with __root = dir) when present, null when
// genuinely absent (ENOENT), and THROWS when present-but-unreadable/invalid so
// the caller fails closed rather than silently allowing reads.
function tryLoadAt(dir) {
  const f = path.join(dir, '.claude', 'heimdall-conceal.json');
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw Object.assign(new Error(`cannot read ${f}: ${err.message}`), { cfgPath: f });
  }
  try {
    const cfg = JSON.parse(raw);
    cfg.__root = dir;
    return cfg;
  } catch (err) {
    throw Object.assign(new Error(`${f} is not valid JSON: ${err.message}`), { cfgPath: f });
  }
}

// Union policy from EVERY ancestor config so a nested config cannot SHADOW a
// parent's secretsFiles / deny patterns (a guard-only config in a subdir must
// not drop a root policy that protects credentials). Deny patterns are
// position-independent regexes and secretsFiles are basenames, so unioning
// across directories is sound. The nearest config's dir is the log root and its
// denyMessage (if any) wins.
function mergeConfigs(list) {
  const merged = {
    __root: list[0].__root,
    denyFilePatterns: [],
    denyCommandPatterns: [],
    secretsFiles: [],
  };
  for (const c of list) {
    for (const k of ['denyFilePatterns', 'denyCommandPatterns', 'secretsFiles']) {
      if (Array.isArray(c[k])) merged[k].push(...c[k]);
    }
    if (!merged.denyMessage && c.denyMessage) merged.denyMessage = c.denyMessage;
  }
  return merged;
}

// Walk up from startDir collecting EVERY conceal config (so a nested config can
// never shadow an ancestor), bounded at $HOME — exactly like the lock guard's
// findAncestorStore. $HOME ITSELF is checked, then the walk stops: this prevents
// a config at/above $HOME from governing every descendant session (and a broken
// one freezing them all), and keeps sandboxed e2e tests (tmp $HOME) from leaking
// the real user's config. Paths outside $HOME walk to the filesystem root.
function loadConfig(startDir) {
  const home = os.homedir();
  let dir = path.resolve(startDir);
  const found = [];
  for (;;) {
    const cfg = tryLoadAt(dir); // null on ENOENT; throws (fail-closed) on broken
    if (cfg) found.push(cfg);
    if (dir === home) break; // checked $HOME, stop — do not climb above it
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return found.length ? mergeConfigs(found) : null;
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Patterns matched against TARGET PATHS of file tools.
// Compile pattern strings to case-insensitive RegExps, skipping any malformed
// one instead of throwing. A single bad user-supplied pattern must not crash
// the guard (an uncaught throw would exit non-2 = fail OPEN); the remaining
// valid patterns still enforce, and a wholesale-broken config is caught by the
// fail-closed wrapper around main().
function toRegexes(patterns) {
  const out = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      /* skip malformed pattern */
    }
  }
  return out;
}

function filePatterns(cfg) {
  // ALWAYS derive from secretsFiles so the hook stays in sync with harden: a
  // secrets file added later must be protected even though it isn't (yet) in
  // denyFilePatterns. The explicit deny list is unioned on top, never instead.
  const fromSecrets = toRegexes((cfg.secretsFiles || []).map((f) => esc(path.basename(f))));
  if (Array.isArray(cfg.denyFilePatterns) && cfg.denyFilePatterns.length) {
    const explicit = toRegexes(cfg.denyFilePatterns);
    // A configured deny list that compiles to NOTHING (every pattern invalid)
    // must not silently allow — fail closed (the wrapper turns this into a block).
    if (explicit.length === 0) throw new Error('all denyFilePatterns are invalid regex');
    return [...fromSecrets, ...explicit];
  }
  return fromSecrets;
}

// Patterns matched against Bash COMMANDS (file names + environ + password var).
function cmdPatterns(cfg) {
  const fileRe = filePatterns(cfg); // throws if an explicit file deny list is all-invalid
  const custom = Array.isArray(cfg.denyCommandPatterns) ? cfg.denyCommandPatterns : [];
  const customRe = toRegexes(custom);
  if (custom.length && customRe.length === 0) {
    throw new Error('all denyCommandPatterns are invalid regex');
  }
  // The /proc-environ + PGPASSWORD guards are the baseline secrets defense and
  // must persist whenever this is a secrets config — even after
  // denyCommandPatterns is populated (e.g. by /heimdall:conceal before harden).
  // Also applied when there are no custom command patterns at all.
  const hasSecrets = Array.isArray(cfg.secretsFiles) && cfg.secretsFiles.length;
  const defaults =
    hasSecrets || customRe.length === 0
      ? toRegexes(['/proc/[^/]+/environ', '\\bPGPASSWORD\\b'])
      : [];
  return [...fileRe, ...customRe, ...defaults];
}

const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Deny patterns are anchored on forward slashes (see heimdall-conceal.js
// buildPatterns); normalize Windows backslash separators in the target so the
// match holds cross-platform. (Match-only — the command is never executed from
// this normalized copy.)
const toPosix = (s) => s.replace(/\\/g, '/');

// Resolve symlinks (tolerating a non-existent leaf, e.g. Write to a new file),
// mirroring the lock guard's resolvePathSafe. A symlink whose own path doesn't
// match the deny pattern must not reach a concealed target.
function resolveSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

// Path candidates for a file tool. Path-bearing fields are matched both raw AND
// symlink-resolved (a symlink into a concealed dir must be caught). `pattern` is
// a PATH glob ONLY for Glob — for Grep it is a content-search regex, so treating
// it as a path would wrongly block e.g. Grep(pattern: "logs") when a folder
// "logs" is concealed.
// All path-bearing fields a tool may carry, in BOTH snake_case and camelCase —
// the lock guard accepts `filePath` too, so the conceal guard must as well or a
// camelCase payload would skip the check.
function pathFieldsOf(input) {
  return [
    input.file_path,
    input.filePath,
    input.path,
    input.notebook_path,
    input.notebookPath,
  ].filter(Boolean);
}

function fileToolCandidates(toolName, input) {
  const candidates = [];
  for (const f of pathFieldsOf(input)) {
    candidates.push(f);
    const real = resolveSafe(f);
    if (real !== f) candidates.push(real);
  }
  if (toolName === 'Glob') {
    const { path: p, pattern } = input;
    if (pattern) candidates.push(pattern);
    if (p && pattern) candidates.push(`${p}/${pattern}`);
  }
  return candidates.filter(Boolean).map(toPosix);
}

// Literal path strings a wildcard token could resolve onto: secretsFiles
// basenames plus the literal core of each deny pattern (leading/trailing anchor
// groups stripped, regex unescaped). Anything that isn't a plain literal path is
// skipped — those are matched by the regex-over-variants pass instead.
function literalCore(pattern) {
  let s = String(pattern)
    .replace(/^\([^)]*\)/, '') // drop a leading (^|/) / (^|[^\w.-]) anchor group
    .replace(/^\^/, '')
    .replace(/\([^)]*\)$/, '') // drop a trailing (/|$) anchor group
    .replace(/\\b$/, '')
    .replace(/\$$/, '');
  s = s.replace(/\\(.)/g, '$1'); // unescape \x -> x
  return /^[\w./-]+$/.test(s) ? s : '';
}

function concealLiterals(cfg) {
  const out = new Set();
  for (const f of cfg.secretsFiles || []) {
    const b = path.basename(String(f));
    if (b) out.add(b);
  }
  for (const key of ['denyFilePatterns', 'denyCommandPatterns']) {
    for (const p of cfg[key] || []) {
      const core = literalCore(p);
      if (core) out.add(core);
    }
  }
  return [...out];
}

// A wildcard token (`*`, `?`) can't be reduced to a literal, so glob-match
// command tokens against the known concealed literals. Returns a descriptive
// match token (truthy) or null. See GH-655.
function globMatchesConcealed(cfg, variants) {
  const literals = concealLiterals(cfg);
  if (!literals.length) return null;
  for (const variant of variants) {
    for (const lit of literals) {
      const ref = lit.includes('/')
        ? commandGlobReferencesPath(variant, lit)
        : commandGlobReferencesMarker(variant, lit);
      if (ref) return `glob:${lit}`;
    }
  }
  return null;
}

function evaluate(cfg, toolName, input) {
  if (toolName === 'Bash') {
    const raw = String(input.command || '');
    // Deobfuscate the RAW command first (a shell backslash escape must be
    // resolved before toPosix would rewrite `\`→`/`), then also carry a toPosix
    // form of each variant for Windows-separator configs. Quote/backslash/brace/
    // [x] evasions (cat ~/.se[c]rets, .se""crets, {.sec,x}rets) collapse to the
    // literal path before matching. See GH-655.
    const variantSet = new Set();
    for (const v of normalizedVariants(raw)) {
      variantSet.add(v);
      variantSet.add(toPosix(v));
    }
    const variants = [...variantSet];
    const pats = cmdPatterns(cfg);
    for (const variant of variants) {
      const hit = pats.find((re) => re.test(variant));
      if (hit) return hit;
    }
    return globMatchesConcealed(cfg, variants);
  }
  if (FILE_TOOLS.has(toolName)) {
    // Test each candidate SEPARATELY: joining with a separator would break the
    // `(/|$)` right-boundary (a dir at a field's end is followed by the
    // separator, not `/` or end-of-string).
    const pats = filePatterns(cfg);
    for (const t of fileToolCandidates(toolName, input)) {
      const hit = pats.find((re) => re.test(t));
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

// True when a file tool targets the given config path (raw or symlink-resolved).
// Used to let the user edit a broken config to recover from a fail-closed state.
function targetsConfigFile(toolName, input, cfgPath) {
  if (!cfgPath || !FILE_TOOLS.has(toolName)) return false;
  const real = resolveSafe(cfgPath);
  for (const t of pathFieldsOf(input)) {
    if (t === cfgPath || resolveSafe(t) === real) return true;
  }
  return false;
}

// Load the config, or handle a broken one with a recovery exit. Returns the
// parsed config, or null when no policy applies. On a present-but-invalid config
// it either ALLOWS (exit 0) a file tool editing the offending file (so the user
// can repair it) or fails closed (exit 2) with a recovery note.
function resolveConfig(root, toolName, input) {
  try {
    return loadConfig(root);
  } catch (err) {
    if (targetsConfigFile(toolName, input, err.cfgPath)) process.exit(0);
    process.stderr.write(
      `BLOCKED (heimdall conceal): ${err.message}\n` +
        'The conceal policy is unreadable/invalid, so the guard is failing closed. ' +
        'Fix or remove that file to restore normal operation — editing the file itself is allowed.\n'
    );
    return process.exit(2);
  }
}

function log(cfg, payload) {
  try {
    fs.appendFileSync(
      path.join(cfg.__root, '.claude', 'heimdall-conceal.log'),
      JSON.stringify(payload) + '\n'
    );
  } catch {
    /* best-effort */
  }
}

function main() {
  // Parse the payload FIRST so config resolution can honor its cwd — the lock
  // hook (heimdall.js) keys off hookData.cwd, and the conceal guard must agree
  // or it would no-op on a valid config when CLAUDE_PROJECT_DIR is unset and the
  // process cwd differs from the project root.
  let event;
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0);
  }

  const root = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const toolName = event.tool_name || '';
  const input = event.tool_input || {};

  const cfg = resolveConfig(root, toolName, input);
  if (!cfg) process.exit(0); // no policy for this project → no-op

  const matched = evaluate(cfg, toolName, input);
  if (!matched) process.exit(0);

  log(cfg, {
    ts: new Date().toISOString(),
    tool: toolName,
    input,
    matched: String(matched),
  });

  const msg =
    cfg.denyMessage ||
    'BLOCKED: protected secrets. Reading the credentials file, process environ, ' +
      'or the injected password is not permitted for agents. MCP servers access ' +
      'these out-of-band via the setuid broker — you do not need to read them directly.';
  process.stderr.write(msg + '\n');
  process.exit(2);
}

// Fail CLOSED: main() exits 0 before any policy is confirmed, so an exception
// escaping here means a config was active when something went wrong — block the
// tool call (exit 2) rather than letting it through on a non-2 crash exit.
try {
  main();
} catch (err) {
  process.stderr.write(`heimdall-conceal hook error: ${err.message}. Blocking for safety.\n`);
  process.exit(2);
}
