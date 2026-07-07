#!/usr/bin/env node
'use strict';

/**
 * runtime-doctor — codex hook-trust + matcher-lane report for this repo's
 * plugins (design C9/C5, WP-11).
 *
 * Codex 0.142.5 SILENTLY skips untrusted hooks (ground truth §2.8.2): after an
 * install or any hooks.json change the whole enforcement layer can be off with
 * zero signal. This CLI wraps the runtime doctor lib (canonical
 * factories/runtime/doctor.js, vendored per plugin) to report, per plugin:
 *
 *   - trust status per hook entry: trusted / modified / untrusted / disabled
 *   - matcher lane coverage per runtime (which PreToolUse/PostToolUse lanes
 *     can ever fire on claude vs codex — GT §2.4.2/§2.4.4)
 *   - remediation lines (TUI /hooks review, --dangerously-bypass-hook-trust)
 *
 * BEST-EFFORT caveat: the trusted_hash formula is derived from codex `main`
 * source, NOT bit-exact-verified on 0.142.5 (GT §2.8.4). A 'modified' verdict
 * means "review this hook in /hooks", never proof of tampering. This tool
 * only READS trust state — scripting trusted_hash writes is forbidden.
 *
 * Usage:
 *   node scripts/runtime-doctor.js [--codex-home DIR] [--marketplace NAME] [--json]
 *
 * Exit codes: 0 all hooks trusted, 1 some gates off, 2 config error.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

// Canonical lib first; vendored copies (byte-identical, sync-vendored.js) as
// fallback so the CLI still works from a partial checkout/snapshot.
const DOCTOR_CANDIDATES = [
  '../factories/runtime/doctor',
  '../plugins/work/scripts/workflows/lib/runtime/doctor',
];

function requireDoctor() {
  for (const candidate of DOCTOR_CANDIDATES) {
    try {
      return require(candidate);
    } catch {
      /* try the next copy */
    }
  }
  process.stderr.write('runtime-doctor: no runtime doctor lib found — broken checkout?\n');
  process.exit(2);
}

// Tool names each runtime can ever emit in a PreToolUse/PostToolUse payload.
// claude: built-in tool vocabulary. codex: flat names (GT §2.5.3) where
// Write/Edit alias-fire for apply_patch and Agent for spawn_agent (§2.4.2).
const CLAUDE_LIVE = new Set([
  'Task',
  'Skill',
  'Bash',
  'BashOutput',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
  'KillShell',
  'SlashCommand',
  'Monitor',
]);
const CODEX_LIVE = new Set([
  'Bash',
  'Write',
  'Edit',
  'Agent',
  'spawn_agent',
  'request_user_input',
  'update_plan',
  'view_image',
  'read_mcp_resource',
  'read_file',
  'web_search',
]);

const TOOL_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
// Only [A-Za-z0-9_|] is an exact-alternation matcher; anything else is a
// regex we conservatively report as live on both runtimes (GT §2.4.1).
const EXACT_MATCHER_RE = /^[A-Za-z0-9_|]+$/;

function laneVerdict(matcher, liveSet) {
  if (matcher === undefined || matcher === '' || matcher === '*') return { live: true, dead: [] };
  if (!EXACT_MATCHER_RE.test(matcher)) return { live: true, dead: [], regex: true };
  const tokens = matcher.split('|').filter(Boolean);
  const dead = tokens.filter((t) => !liveSet.has(t) && !t.startsWith('mcp__'));
  return { live: dead.length < tokens.length, dead };
}

/** Lane-coverage rows for one plugin's hooks.json (tool-matcher events only). */
function laneRows(plugin, hooksJsonPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  } catch {
    return [];
  }
  const rows = [];
  for (const [event, groups] of Object.entries((parsed && parsed.hooks) || {})) {
    if (!TOOL_MATCHER_EVENTS.has(event) || !Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = group && group.matcher;
      rows.push({
        plugin,
        event,
        matcher: matcher === undefined ? '(all tools)' : matcher,
        claude: laneVerdict(matcher, CLAUDE_LIVE),
        codex: laneVerdict(matcher, CODEX_LIVE),
      });
    }
  }
  return rows;
}

/** Plugin list from .claude-plugin/marketplace.json (name → hooks.json path). */
function pluginSpecs(marketplaceName) {
  const manifestPath = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`runtime-doctor: cannot read ${manifestPath}: ${err.message}\n`);
    process.exit(2);
  }
  const marketplace = marketplaceName || manifest.name;
  return (manifest.plugins || []).map((entry) => ({
    plugin: entry.name,
    marketplace,
    hooksJsonPath: path.join(REPO_ROOT, entry.source, 'hooks', 'hooks.json'),
  }));
}

function parseArgs(argv) {
  const opts = { codexHome: undefined, marketplace: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--codex-home') opts.codexHome = argv[(i += 1)];
    else if (arg === '--marketplace') opts.marketplace = argv[(i += 1)];
    else {
      process.stderr.write(`runtime-doctor: unknown argument "${arg}"\n`);
      process.exit(2);
    }
  }
  return opts;
}

function verdictCell(verdict) {
  if (verdict.regex) return 'live (regex — verify manually)';
  if (!verdict.live) return 'DEAD';
  return verdict.dead.length > 0 ? `live (dead tokens: ${verdict.dead.join(', ')})` : 'live';
}

function printTrust(out, pluginReport) {
  out.push(`## ${pluginReport.plugin}`);
  if (pluginReport.error) {
    out.push(`  ERROR: ${pluginReport.error}`);
    return;
  }
  out.push(`  ${pluginReport.summary}`);
  for (const entry of pluginReport.entries) {
    if (entry.status === 'trusted') continue;
    out.push(`  - [${entry.status.toUpperCase()}] ${entry.key}`);
  }
  if (pluginReport.modified > 0) {
    out.push(
      '  note: "modified" is a BEST-EFFORT verdict (hash formula source-derived, not ' +
        'bit-exact-verified on 0.142.5) — review the hook in /hooks rather than trusting the diff.'
    );
  }
}

function printLanes(out, rows) {
  out.push('', '## matcher lane coverage (PreToolUse/PostToolUse/PermissionRequest)');
  for (const row of rows) {
    out.push(
      `  ${row.plugin}  ${row.event}  "${row.matcher}"  claude=${verdictCell(row.claude)}  ` +
        `codex=${verdictCell(row.codex)}`
    );
  }
  out.push(
    '  note: UserPromptSubmit/Stop matchers are IGNORED by codex — those hooks fire on every',
    '  prompt/stop and self-filter in-script (design C8). Read/Grep/Glob loss on codex is',
    '  covered by the Bash lane (codex reads via shell).'
  );
}

function printRemediation(out, gatesOff) {
  out.push('', '## remediation');
  if (gatesOff) {
    out.push(
      '  - interactive: run the TUI `/hooks` review to trust the listed hooks',
      '  - automation: relaunch with `codex exec --dangerously-bypass-hook-trust` (per-invocation;',
      '    does NOT persist trust)',
      '  - NEVER script `trusted_hash` writes into config.toml — the formula is not bit-exact-',
      '    verified and pre-seeding trust is the exact gate-bypass pattern this repo forbids.'
    );
  } else {
    out.push('  - all hooks trusted; nothing to do.');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doctor = requireDoctor();
  const specs = pluginSpecs(opts.marketplace);
  const trust = doctor.report({ codexHome: opts.codexHome, plugins: specs });
  const lanes = specs.flatMap((spec) => laneRows(spec.plugin, spec.hooksJsonPath));
  const gatesOff =
    trust.configError !== null ||
    trust.plugins.some((p) => p.error || p.total === undefined || p.trusted < p.total);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...trust, lanes, gatesOff }, null, 2)}\n`);
    process.exit(gatesOff ? 1 : 0);
  }

  const out = [`# runtime-doctor — codex home: ${trust.codexHome}`];
  if (trust.configError) {
    out.push(`config.toml unreadable (${trust.configError}) — every hook counts as untrusted.`);
  }
  out.push('');
  for (const pluginReport of trust.plugins) printTrust(out, pluginReport);
  printLanes(out, lanes);
  printRemediation(out, gatesOff);
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(gatesOff ? 1 : 0);
}

main();
