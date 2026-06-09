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

function get(name) {
  if (!isKnownSkill(name)) return undefined;
  return REGISTRY[name];
}

function ticketSkillFile(ticket) {
  return path.join(tasksBase(), ticket, TICKET_SKILL_BASENAME);
}

function readTicketSkill(ticket) {
  const f = ticketSkillFile(ticket);
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch {
    return DEFAULT_SKILL;
  }
  const trimmed = (raw || '').trim();
  if (!isValidSkillName(trimmed)) return DEFAULT_SKILL;
  if (!isKnownSkill(trimmed)) return DEFAULT_SKILL;
  return trimmed;
}

function writeTicketSkill(ticket, name) {
  if (!isValidSkillName(name)) {
    throw new Error(
      `skill-registry: refusing to write invalid skill name ${JSON.stringify(name)} ` +
        `(must match ${SKILL_NAME_REGEX})`
    );
  }
  // PR #561 review: regex validity is not enough. Without the registry check
  // we'd persist `.maestro-skill = 'followup'` (typo), then `readTicketSkill`
  // and `autoRestart` would fall open to `'work'`, recreating the split-state
  // bug the bootstrap typo guard fixed.
  if (!isKnownSkill(name)) {
    throw new Error(
      `skill-registry: refusing to write registry-unknown skill ${JSON.stringify(name)} ` +
        `(known: ${Object.keys(REGISTRY).join(', ')})`
    );
  }
  const dir = path.join(tasksBase(), ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, TICKET_SKILL_BASENAME), `${name}\n`);
}

module.exports = {
  get,
  isKnownSkill,
  readTicketSkill,
  writeTicketSkill,
  ticketSkillFile,
  SKILL_NAME_REGEX,
  DEFAULT_SKILL,
  TICKET_SKILL_BASENAME,
};
