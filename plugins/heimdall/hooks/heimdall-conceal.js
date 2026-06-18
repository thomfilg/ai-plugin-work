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
    try {
      const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      cfg.__root = root;
      return cfg;
    } catch {
      /* try next */
    }
  }
  return null;
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Patterns matched against TARGET PATHS of file tools.
function filePatterns(cfg) {
  if (Array.isArray(cfg.denyFilePatterns) && cfg.denyFilePatterns.length) {
    return cfg.denyFilePatterns.map((p) => new RegExp(p, 'i'));
  }
  return (cfg.secretsFiles || []).map((f) => new RegExp(esc(path.basename(f)), 'i'));
}

// Patterns matched against Bash COMMANDS (file names + environ + password var).
function cmdPatterns(cfg) {
  const base = filePatterns(cfg).map((re) => re.source);
  const extra =
    Array.isArray(cfg.denyCommandPatterns) && cfg.denyCommandPatterns.length
      ? cfg.denyCommandPatterns
      : ['/proc/[^/]+/environ', '\\bPGPASSWORD\\b'];
  return [...base, ...extra].map((s) => new RegExp(s, 'i'));
}

const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit']);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function evaluate(cfg, toolName, input) {
  if (toolName === 'Bash') {
    const cmd = String(input.command || '');
    return cmdPatterns(cfg).find((re) => re.test(cmd)) || null;
  }
  if (FILE_TOOLS.has(toolName)) {
    const target = [input.file_path, input.path, input.notebook_path].filter(Boolean).join('\n');
    return filePatterns(cfg).find((re) => re.test(target)) || null;
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

main();
