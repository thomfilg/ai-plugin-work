// GENERATED — edit factories/statusline-host/statusline-host.js and run scripts/sync-vendored.js

'use strict';
/**
 * statusline-host.js — shared "single host, many fragments" statusline model.
 *
 * THE FIX for statusline clobbering: Claude Code exposes exactly ONE statusLine
 * slot. Historically every plugin (maestro 🎼, work ⚙, follow-up 🔄, qc 🔬)
 * overwrote that slot with itself and chained at most one prior bar — so install
 * order decided who showed, and re-installing was needed every session.
 *
 * Instead, ONE host script owns the slot permanently at a FIXED, checkout-
 * independent path (~/.claude/statusline-host.sh). It renders every fragment in
 * ~/.claude/statuslines/<NN>-<name>.cmd (first line = absolute renderer path,
 * NN prefix = stacking order). Plugins add/remove ONLY their own fragment:
 *   - installing/removing one bar never disturbs the others
 *   - the registered slot never changes → new tabs/sessions just work (no reinstall)
 *
 * Zero runtime deps, CommonJS, Node built-ins only (matches plugin conventions).
 *
 * VENDORED MASTER: this is the canonical copy. Each plugin that ships a bar
 * carries a byte-identical vendored copy under its own lib/ (plugins can't
 * require across install snapshots — see scripts/sync-vendored.js). Edit HERE,
 * then run `node scripts/sync-vendored.js` to refresh the vendored copies.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const HOST_PATH = path.join(HOME, '.claude', 'statusline-host.sh');
const REGISTRY_DIR = path.join(HOME, '.claude', 'statuslines');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

// Bump when HOST_SCRIPT changes so installers re-write the host in place.
const HOST_VERSION = 1;

const HOST_SCRIPT = `#!/usr/bin/env bash
# statusline-host.sh — HOST_VERSION=${HOST_VERSION}
# Single, stable Claude Code statusLine host. Renders every fragment registered
# under the registry dir. Managed by the plugins' statusline-host.js — do not
# edit by hand; installers overwrite this file when HOST_VERSION changes.
set -uo pipefail

REG="\${CLAUDE_STATUSLINE_REGISTRY:-\$HOME/.claude/statuslines}"

# Claude passes session JSON on stdin; forward the SAME bytes to every renderer.
STDIN_JSON="\$(cat 2>/dev/null || true)"

shopt -s nullglob
lines=()
for frag in "\$REG"/*.cmd; do
  cmd="\$(head -n1 "\$frag" 2>/dev/null || true)"
  [ -n "\$cmd" ] || continue
  # Never recurse into ourselves.
  case "\$cmd" in *statusline-host.sh) continue ;; esac
  # Invoke the renderer directly (NO eval) so a tampered fragment can't run
  # arbitrary shell. Bare executable paths only — the common case.
  [ -x "\$cmd" ] || continue
  out="\$(printf '%s' "\$STDIN_JSON" | "\$cmd" 2>/dev/null || true)"
  [ -n "\$out" ] && lines+=("\$out")
done

[ \${#lines[@]} -gt 0 ] && printf '%s\\n' "\${lines[@]}"
exit 0
`;

// Known managed renderers → their canonical fragment name, so a one-time
// migration from the OLD single-slot registration keeps each bar's stacking.
const KNOWN = [
  ['maestro-statusline.sh', '10-maestro.cmd'],
  ['work-statusline.sh', '20-work.cmd'],
  ['followup-statusline.sh', '30-followup.cmd'],
  ['qc-statusline.sh', '40-qc.cmd'],
];

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, `${JSON.stringify(obj, null, 2)}\n`);
}

function fragmentPath(fragName) {
  return path.join(REGISTRY_DIR, fragName);
}

function listFragments() {
  try {
    return fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.cmd'));
  } catch {
    return [];
  }
}

function isHost(cmd) {
  return typeof cmd === 'string' && cmd.includes('statusline-host.sh');
}

// Preserve a previously-registered single bar as a fragment so migrating to the
// host loses nothing. Known managed renderers keep their slot; anything else is
// pinned to the bottom.
function migrateExisting(cmd) {
  if (!cmd || typeof cmd !== 'string' || isHost(cmd)) return;
  const known = KNOWN.find(([basename]) => cmd.includes(basename));
  writeFragment(known ? known[1] : '50-preexisting.cmd', cmd);
}

function writeFragment(fragName, rendererPath) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(fragmentPath(fragName), `${String(rendererPath).trim()}\n`);
}

// Ensure the host script exists (correct version) and owns the statusLine slot.
function ensureHost() {
  let current = '';
  try {
    current = fs.readFileSync(HOST_PATH, 'utf8');
  } catch {
    /* absent */
  }
  if (!current.includes(`HOST_VERSION=${HOST_VERSION}`)) {
    fs.mkdirSync(path.dirname(HOST_PATH), { recursive: true });
    fs.writeFileSync(HOST_PATH, HOST_SCRIPT);
  }
  fs.chmodSync(HOST_PATH, 0o755);
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });

  const s = readSettings();
  const cur = s.statusLine && s.statusLine.command;
  if (cur !== HOST_PATH) {
    if (cur) migrateExisting(cur);
    s.statusLine = { type: 'command', command: HOST_PATH, padding: 0, refreshInterval: 3 };
    writeSettings(s);
  }
}

// Register (or refresh) this plugin's bar: install the host, then drop the
// plugin's own fragment pointing at its renderer.
function register(fragName, rendererPath) {
  ensureHost();
  writeFragment(fragName, rendererPath);
}

// Remove this plugin's bar only. If it was the last fragment, unregister the
// host from settings (leaving the host script on disk is harmless).
function remove(fragName) {
  try {
    fs.unlinkSync(fragmentPath(fragName));
  } catch {
    /* already gone */
  }
  if (listFragments().length === 0) {
    const s = readSettings();
    if (isHost(s.statusLine && s.statusLine.command)) {
      delete s.statusLine;
      writeSettings(s);
    }
  }
}

function state(fragName) {
  const s = readSettings();
  const cur = (s.statusLine && s.statusLine.command) || '(none)';
  const mine = fragmentPath(fragName);
  let mineTarget = '(not registered)';
  try {
    mineTarget = fs.readFileSync(mine, 'utf8').trim();
  } catch {
    /* absent */
  }
  return {
    hostPath: HOST_PATH,
    hostExists: fs.existsSync(HOST_PATH),
    registered: isHost(cur),
    currentSlot: cur,
    myFragment: fragName,
    myTarget: mineTarget,
    allFragments: listFragments().sort(),
    registryDir: REGISTRY_DIR,
  };
}

module.exports = {
  HOST_PATH,
  REGISTRY_DIR,
  HOST_VERSION,
  ensureHost,
  register,
  remove,
  state,
};
