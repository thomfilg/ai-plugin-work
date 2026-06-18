#!/usr/bin/env node
/**
 * heimdall-conceal — PreToolUse hook (plugin). Deny agent reads of protected secrets.
 *
 * Config-driven and SAFE-BY-DEFAULT-OFF: if the target project has no
 * `.claude/heimdall-conceal.json` (or `.heimdall-conceal.json`), this hook is a no-op, so
 * installing the plugin globally never breaks unrelated repos.
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
const path = require('path');

function loadConfig(root) {
  for (const f of [
    path.join(root, '.claude', 'heimdall-conceal.json'),
    path.join(root, '.heimdall-conceal.json'),
  ]) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // this candidate absent → try next
      // A config file IS present but unreadable: do NOT silently no-op (that
      // would allow reads despite a policy). Throw → fail closed via main()'s wrapper.
      throw new Error(`cannot read ${f}: ${err.message}`);
    }
    try {
      const cfg = JSON.parse(raw);
      cfg.__root = root;
      return cfg;
    } catch (err) {
      // Present but invalid JSON: fail closed rather than disable the guard.
      throw new Error(`${f} is not valid JSON: ${err.message}`);
    }
  }
  return null;
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
  const hasCustom = Array.isArray(cfg.denyCommandPatterns) && cfg.denyCommandPatterns.length;
  const extra = hasCustom ? cfg.denyCommandPatterns : ['/proc/[^/]+/environ', '\\bPGPASSWORD\\b'];
  const extraRe = toRegexes(extra);
  if (hasCustom && extraRe.length === 0)
    throw new Error('all denyCommandPatterns are invalid regex');
  return [...fileRe, ...extraRe];
}

const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit']);

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

function evaluate(cfg, toolName, input) {
  if (toolName === 'Bash') {
    const cmd = toPosix(String(input.command || ''));
    return cmdPatterns(cfg).find((re) => re.test(cmd)) || null;
  }
  if (FILE_TOOLS.has(toolName)) {
    // Glob carries the search in `pattern` (often with a separate `path` dir),
    // so include it and the path+pattern join. Test each candidate SEPARATELY:
    // joining with a separator would break the `(/|$)` right-boundary (a dir at
    // a field's end is followed by the separator, not `/` or end-of-string).
    const { file_path, path: p, notebook_path, pattern } = input;
    const candidates = [file_path, p, notebook_path, pattern];
    if (p && pattern) candidates.push(`${p}/${pattern}`);
    const targets = candidates.filter(Boolean).map(toPosix);
    const pats = filePatterns(cfg);
    for (const t of targets) {
      const hit = pats.find((re) => re.test(t));
      if (hit) return hit;
    }
    return null;
  }
  return null;
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
  const cfg = loadConfig(root);
  if (!cfg) process.exit(0); // no policy for this project → no-op

  const matched = evaluate(cfg, event.tool_name || '', event.tool_input || {});
  if (!matched) process.exit(0);

  log(cfg, {
    ts: new Date().toISOString(),
    tool: event.tool_name,
    input: event.tool_input,
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
