/**
 * alerts.js — write maestro-facing alerts to two sinks:
 *   1. /tmp/maestro-alerts.jsonl    (structured, one JSON per line)
 *   2. tmux session "maestro-alerts" (human-tailable)
 *
 * Detectors should never call alert() directly; they return findings
 * and the main loop decides when to escalate.
 */
const fs = require('fs');
const tmux = require('./tmux');

const ALERT_FILE = process.env.ALERT_FILE || '/tmp/maestro-alerts.jsonl';
const ALERT_SESSION = process.env.ALERT_SESSION || 'maestro-alerts';

function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}\n`;
  process.stderr.write(out);
  try { fs.appendFileSync(process.env.LOG_FILE || '/tmp/maestro-conduct.log', out); }
  catch {}
}

function alert(obj) {
  const payload = { ts: new Date().toISOString(), ...obj };
  try { fs.appendFileSync(ALERT_FILE, JSON.stringify(payload) + '\n'); } catch {}
  tmux.ensureSession(ALERT_SESSION);
  const summary = `MAESTRO-ALERT ${obj.session || obj.ticket || '?'} ${obj.kind}` +
    (obj.phase ? ` phase=${obj.phase}` : '') +
    (typeof obj.elapsedMin === 'number' ? ` elapsed=${obj.elapsedMin}m` : '');
  tmux.sendLine(ALERT_SESSION, summary);
  log(`ALERT ${JSON.stringify(payload)}`);
}

module.exports = { alert, log, ALERT_FILE, ALERT_SESSION };
