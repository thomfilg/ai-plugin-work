/**
 * skill-registry.js — single seam for per-skill behavior in maestro-conduct (GH-514).
 *
 * Exposes:
 *   - get(name)                 → row { stateFile, snapshot, isHealthyIdle, silenceLimitSec } | undefined
 *   - isKnownSkill(name)        → boolean (whitelist membership)
 *   - readTicketSkill(ticket)   → 'work' | 'follow-up' (falls open to 'work')
 *   - writeTicketSkill(ticket, name) → persists tasks/<ticket>/.maestro-skill; throws on invalid name
 *
 * Security (spec §Security):
 *   - Whitelist via `SKILL_NAME_REGEX`; unknown skill falls open to 'work'.
 *   - `writeTicketSkill` rejects names that don't match the regex.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rows = require('./shared/skill-registry-rows.js');

// spec §Security: name regex.
const SKILL_NAME_REGEX = /^[a-z][a-z0-9-]{0,31}$/;
const TICKET_SKILL_BASENAME = '.maestro-skill';
const DEFAULT_SKILL = 'work';

// Build the registry table.
const REGISTRY = Object.freeze({
  work: rows.workRow(),
  'follow-up': rows.followUpRow(),
});

function tasksBase() {
  const worktrees = process.env.WORKTREES_BASE || path.join(os.homedir(), 'worktrees');
  return process.env.TASKS_BASE || path.join(worktrees, 'tasks');
}

function isValidSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_REGEX.test(name);
}

function isKnownSkill(name) {
  if (!isValidSkillName(name)) return false;
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

/**
 * A name is *allowed* as a launch command when it is either whitelisted, or
 * regex-valid AND backed by a stop-condition oracle (the generic-row path).
 * The oracle existence is injected by the caller (`opts.hasOracle`) so this
 * module stays decoupled from the manifest. Defaults to whitelist-only.
 */
function isAllowedSkill(name, opts = {}) {
  if (isKnownSkill(name)) return true;
  return !!opts.hasOracle && isValidSkillName(name);
}

function get(name, opts = {}) {
  void opts; // back-compat parameter; row choice no longer depends on it
  if (isKnownSkill(name)) return REGISTRY[name];
  // Any regex-valid non-whitelisted command → generic row. The generic row
  // reads NO skill-specific state (snapshot() → null), so it can never apply
  // /work phase coaching to a foreign workflow — which is exactly what
  // happened when this fell through to the work row: a /qc-work agent got
  // "phase=spec stuck 90m … Re-run task-next.js" nudges built from a stale
  // .work-state.json left by an earlier /work run. A generic command without
  // an oracle still deserves generic (not /work) treatment.
  if (isValidSkillName(name)) return rows.genericRow();
  return undefined;
}

function ticketSkillFile(ticket) {
  return path.join(tasksBase(), ticket, TICKET_SKILL_BASENAME);
}

function readTicketSkill(ticket, opts = {}) {
  const f = ticketSkillFile(ticket);
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch {
    return DEFAULT_SKILL;
  }
  const trimmed = (raw || '').trim();
  // Honor any regex-valid persisted skill. The write path (writeTicketSkill /
  // maestro-bootstrap.sh) already gates what lands in `.maestro-skill`, so the
  // read side trusting a well-formed value is safe — while the old
  // whitelist-or-oracle read gate was actively harmful: a `qc-work` fleet
  // whose manifest lookup failed (or whose caller forgot opts.hasOracle) got
  // silently relaunched as `/work` on delivered tickets, re-entering a
  // foreign workflow ("AUTO-RESTART .maestro-skill value \"qc-work\" rejected
  // by whitelist — falling open to /work", observed live). Malformed values
  // still fall open to /work.
  if (!isValidSkillName(trimmed)) return DEFAULT_SKILL;
  return trimmed;
}

function writeTicketSkill(ticket, name, opts = {}) {
  if (!isValidSkillName(name)) {
    throw new Error(
      `skill-registry: refusing to write invalid skill name ${JSON.stringify(name)} ` +
        `(must match ${SKILL_NAME_REGEX})`
    );
  }
  // PR #561 review: regex validity is not enough for a WHITELISTED launch.
  // Without the registry check we'd persist `.maestro-skill = 'followup'`
  // (typo), then fall open to `'work'`, recreating the split-state bug.
  // The generic-row path (GH-514 whitelist decision) intentionally relaxes
  // this when the ticket is oracle-backed: any regex-valid command is allowed
  // because the oracle, not a bespoke registry row, defines "done".
  if (!isAllowedSkill(name, opts)) {
    throw new Error(
      `skill-registry: refusing to write registry-unknown skill ${JSON.stringify(name)} ` +
        `without a stop-condition oracle (known: ${Object.keys(REGISTRY).join(', ')}; ` +
        `pass {hasOracle:true} for an oracle-backed command)`
    );
  }
  const dir = path.join(tasksBase(), ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, TICKET_SKILL_BASENAME), `${name}\n`);
}

module.exports = {
  get,
  isKnownSkill,
  isAllowedSkill,
  readTicketSkill,
  writeTicketSkill,
  ticketSkillFile,
  SKILL_NAME_REGEX,
  DEFAULT_SKILL,
  TICKET_SKILL_BASENAME,
};
