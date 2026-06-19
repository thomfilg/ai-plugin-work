/**
 * state.js — persistent per-ticket markers under STATE_DIR.
 *
 * Each marker is a JSON file so we can grow the schema without breaking
 * the bash-era pipe-separated format.
 */
const fs = require('fs');
const path = require('path');
const namespace = require('./namespace');

// Default state location lives under the user's home dir (XDG-ish) instead of
// /tmp. Predictable filenames inside a shared world-writable tmp directory
// are flagged by CodeQL (js/file-system-race) because another local user can
// pre-create or symlink the path before us. Using $HOME and 0o700 perms makes
// symlink-substitution impractical. Override via STATE_DIR env when callers
// need a custom location (e.g. tests using mkdtempSync-derived paths).
//
// When MAESTRO_NS is set, namespace.stateDir() nests under a per-namespace
// subdir so two conductors on one machine never share marker files (GH-622).
const STATE_DIR = namespace.stateDir();
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

function file(ticket, kind) {
  // Marker keys may be full tmux session names, which under MAESTRO_NS carry a
  // "<ns>/" segment (e.g. "proj-a/GH-42-work"). STATE_DIR is already per-namespace
  // so flatten the key to a single filename segment — otherwise path.join would
  // target a non-existent nested dir (ENOENT on write) and cleanup's bare-id
  // marker matcher would miss it (GH-622).
  return path.join(STATE_DIR, `${namespace.flattenKey(ticket)}.${kind}.json`);
}

function read(ticket, kind) {
  const f = file(ticket, kind);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function write(ticket, kind, obj) {
  fs.writeFileSync(file(ticket, kind), JSON.stringify(obj));
}

function clear(ticket, kind) {
  try {
    fs.unlinkSync(file(ticket, kind));
  } catch {}
}

function now() {
  return Math.floor(Date.now() / 1000);
}
function minutesSince(secs) {
  return Math.floor((now() - secs) / 60);
}

module.exports = { STATE_DIR, read, write, clear, now, minutesSince };
