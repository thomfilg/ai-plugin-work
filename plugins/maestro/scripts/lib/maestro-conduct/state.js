/**
 * state.js — persistent per-ticket markers under STATE_DIR.
 *
 * Each marker is a JSON file so we can grow the schema without breaking
 * the bash-era pipe-separated format.
 */
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.STATE_DIR || '/tmp/maestro-conduct-state';
fs.mkdirSync(STATE_DIR, { recursive: true });

function file(ticket, kind) {
  return path.join(STATE_DIR, `${ticket}.${kind}.json`);
}

function read(ticket, kind) {
  const f = file(ticket, kind);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return null; }
}

function write(ticket, kind, obj) {
  fs.writeFileSync(file(ticket, kind), JSON.stringify(obj));
}

function clear(ticket, kind) {
  try { fs.unlinkSync(file(ticket, kind)); } catch {}
}

function now() { return Math.floor(Date.now() / 1000); }
function minutesSince(secs) { return Math.floor((now() - secs) / 60); }

module.exports = { STATE_DIR, read, write, clear, now, minutesSince };
