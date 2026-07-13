/**
 * workflows/work/lib/apply-gate-resolutions.js (GH-543)
 *
 * Kind-routing persistence for brief_gate answers. One envelope carries the
 * user's answers for every question kind the gate can emit, and each kind is
 * persisted into brief.md in the exact format its parser reads back:
 *
 *   - `openQuestions`  — { questionText → answer } map, routed through
 *     `open-questions.applyResolutions` (Resolution lines, `resolved: true`).
 *   - `siblingGaps`    — [{ surface, decision }], appended as
 *     '- `<surface>` — decision: <decision>; timestamp: <ISO>' bullets under
 *     `## Sibling-gap decisions` (the format `_decomposeDecisionEntry` in
 *     brief-sibling-gaps.js parses).
 *   - `discrepancies`  — [{ claim, decision }], appended as
 *     '- `<claim>` — <decision>' bullets under `## Discrepancy decisions`
 *     (the format `extractRecordedDecisions` in discrepancy.js parses).
 *
 * A flat string-map payload (the legacy applyBriefResolutions shape) coerces
 * to `{ openQuestions: map }` for back-compat.
 *
 * All user answers pass through `escapeResolution` so a quote, backtick,
 * newline, or leading `#` can never break the markdown structure (the
 * argv-injection regression class this module replaces). Already-recorded
 * keys are skipped, so double-apply is byte-identical.
 *
 * Step guard (fail-open, refuse only on positive mismatch): if
 * `.work-state.json` exists next to brief.md and a step OTHER than
 * brief_gate is positively `in_progress`, the write is refused with a
 * pointer at the work-next.js repair route. The check is allow-first on
 * `stepStatus.brief_gate === 'in_progress'`, so corrupt states that show
 * several steps in_progress still fail toward the sanctioned path. No state
 * file (unit tests, ad-hoc use) → allow.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const openQuestions = require('./open-questions');
const { findUnresolvedSiblingGaps } = require('../../lib/brief-sibling-gaps');
const { extractRecordedDecisions } = require('../../lib/discrepancy');

/** Consume-once transport buffer written by the driver, read by the CLI. */
const DEFAULT_ANSWERS_BASENAME = '.brief-gate-answers.json';

const ENVELOPE_KEYS = ['openQuestions', 'siblingGaps', 'discrepancies'];

const SECTION_HEADERS = {
  siblingGaps: 'Sibling-gap decisions',
  discrepancies: 'Discrepancy decisions',
};

/**
 * Mirror of discrepancy.js `_normalize` (not exported there): the claim-token
 * normalization `extractRecordedDecisions` applies to recorded bullets, so
 * idempotency matching sees exactly what the parser sees.
 */
function normalizeClaimToken(token) {
  return String(token || '')
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?]+$/, '');
}

/** Coerce a Map/object of string→string into a plain Map (drop non-strings). */
function toStringMap(value) {
  const out = new Map();
  if (!value || typeof value !== 'object') return out;
  const entries = value instanceof Map ? value.entries() : Object.entries(value);
  for (const [k, v] of entries) {
    if (typeof k === 'string' && typeof v === 'string') out.set(k, v);
  }
  return out;
}

/**
 * Normalize any accepted payload into
 * `{ openQuestions: Map, siblingGaps: [], discrepancies: [] }`.
 * A Map, or a plain object carrying NONE of the envelope keys, is treated as
 * the legacy flat questionText→answer map.
 */
function normalizeEnvelope(payload) {
  const empty = { openQuestions: new Map(), siblingGaps: [], discrepancies: [] };
  if (!payload || typeof payload !== 'object') return empty;
  const isFlatMap = payload instanceof Map || !ENVELOPE_KEYS.some((k) => Object.hasOwn(payload, k));
  if (isFlatMap) return { ...empty, openQuestions: toStringMap(payload) };
  return {
    openQuestions: toStringMap(payload.openQuestions),
    siblingGaps: Array.isArray(payload.siblingGaps) ? payload.siblingGaps : [],
    discrepancies: Array.isArray(payload.discrepancies) ? payload.discrepancies : [],
  };
}

function countEntries(envelope) {
  return envelope.openQuestions.size + envelope.siblingGaps.length + envelope.discrepancies.length;
}

/**
 * Library-level step guard. Returns a refusal message string, or null to
 * allow. See the module doc for the allow-first contract.
 */
function checkStepGuard(briefPath) {
  const statePath = path.join(path.dirname(briefPath), '.work-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null; // no state file / unreadable / unparseable → no positive evidence → allow
  }
  const stepStatus = state && typeof state === 'object' ? state.stepStatus : null;
  if (!stepStatus || typeof stepStatus !== 'object') return null;
  // Allow-first: brief_gate positively in_progress wins even when a corrupt
  // state shows other steps in_progress alongside it.
  if (stepStatus.brief_gate === 'in_progress') return null;
  const other = Object.keys(stepStatus).find((s) => stepStatus[s] === 'in_progress');
  if (!other) return null; // transition window — nothing positively in_progress
  return (
    `apply-gate-resolutions: refusing to modify brief.md — brief_gate is not in progress ` +
    `(current step: ${other}). This is not a hard block: brief_gate already re-derives ` +
    `pending questions from brief.md, so if these answers are stale simply delete the ` +
    `answers file and re-run work-next.js.`
  );
}

/** Sanitize a key destined for a backtick-wrapped bullet token. */
function sanitizeBulletKey(key) {
  if (typeof key !== 'string') return '';
  return openQuestions.escapeResolution(key).replace(/`/g, '').trim();
}

/**
 * Append bullets to a `## <headerText>` section, creating the section at the
 * end of the document when absent. Insertion goes after the section's last
 * non-blank line so existing bullets keep their order.
 */
function appendBulletsToSection(markdown, headerText, bullets) {
  if (bullets.length === 0) return markdown;
  const lines = markdown.split('\n');
  const headerRe = new RegExp(
    `^##\\s+${headerText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'i'
  );
  const headerIdx = lines.findIndex((l) => headerRe.test(l));

  if (headerIdx === -1) {
    const insertAt = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    const block = [];
    if (insertAt > 0 && lines[insertAt - 1].trim() !== '') block.push('');
    block.push(`## ${headerText}`, '', ...bullets);
    lines.splice(insertAt, 0, ...block);
    return lines.join('\n');
  }

  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  let insertAt = sectionEnd;
  while (insertAt > headerIdx + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, ...bullets);
  return lines.join('\n');
}

/** Route the openQuestions map. Mutates `applied`/`skipped`; returns markdown. */
function applyOpenQuestions(markdown, resolutionsMap, applied, skipped) {
  if (resolutionsMap.size === 0) return markdown;
  const parsed = openQuestions.parse(markdown);
  const applicable = new Map();
  for (const [key, answer] of resolutionsMap) {
    const q = parsed.find((p) => p.questionText === key);
    if (!q) {
      skipped.push({ kind: 'open-question', key, reason: 'unknown-question' });
    } else if (q.resolved === true) {
      skipped.push({ kind: 'open-question', key, reason: 'already-recorded' });
    } else if (openQuestions.escapeResolution(answer) === '') {
      skipped.push({ kind: 'open-question', key, reason: 'empty-answer' });
    } else {
      applicable.set(key, answer);
      applied.push({ kind: 'open-question', key });
    }
  }
  if (applicable.size === 0) return markdown;
  // applyResolutions owns escaping + idempotency for the block rewrite.
  return openQuestions.applyResolutions(markdown, applicable);
}

/** Route the siblingGaps list. Mutates `applied`/`skipped`; returns markdown. */
function applySiblingGaps(markdown, gaps, applied, skipped) {
  if (gaps.length === 0) return markdown;
  const decided = new Set(
    findUnresolvedSiblingGaps(markdown).decisions.map((d) => d.surface.toLowerCase())
  );
  const bullets = [];
  const timestamp = new Date().toISOString();
  for (const gap of gaps) {
    const surface = sanitizeBulletKey(gap && gap.surface);
    const decision = openQuestions.escapeResolution(gap && gap.decision);
    if (!surface || !decision) {
      skipped.push({
        kind: 'sibling-gap',
        key: (gap && gap.surface) || '',
        reason: 'invalid-entry',
      });
      continue;
    }
    if (decided.has(surface.toLowerCase())) {
      skipped.push({ kind: 'sibling-gap', key: surface, reason: 'already-recorded' });
      continue;
    }
    decided.add(surface.toLowerCase());
    // Exact format _decomposeDecisionEntry parses (surface token in backticks).
    bullets.push(`- \`${surface}\` — decision: ${decision}; timestamp: ${timestamp}`);
    applied.push({ kind: 'sibling-gap', key: surface });
  }
  return appendBulletsToSection(markdown, SECTION_HEADERS.siblingGaps, bullets);
}

/** Route the discrepancies list. Mutates `applied`/`skipped`; returns markdown. */
function applyDiscrepancies(markdown, discrepancies, applied, skipped) {
  if (discrepancies.length === 0) return markdown;
  const recorded = extractRecordedDecisions(markdown);
  const bullets = [];
  for (const item of discrepancies) {
    const claim = sanitizeBulletKey(item && item.claim);
    const decision = openQuestions.escapeResolution(item && item.decision);
    if (!claim || !decision) {
      skipped.push({
        kind: 'discrepancy',
        key: (item && item.claim) || '',
        reason: 'invalid-entry',
      });
      continue;
    }
    const normalized = normalizeClaimToken(claim);
    if (recorded.has(normalized)) {
      skipped.push({ kind: 'discrepancy', key: claim, reason: 'already-recorded' });
      continue;
    }
    recorded.add(normalized);
    // Exact format extractRecordedDecisions parses (claim token in backticks).
    bullets.push(`- \`${claim}\` — ${decision}`);
    applied.push({ kind: 'discrepancy', key: claim });
  }
  return appendBulletsToSection(markdown, SECTION_HEADERS.discrepancies, bullets);
}

/** Mark every envelope entry as skipped with one shared reason. */
function skipAllEntries(envelope, reason) {
  const skipped = [];
  for (const [key] of envelope.openQuestions) {
    skipped.push({ kind: 'open-question', key, reason });
  }
  for (const gap of envelope.siblingGaps) {
    skipped.push({ kind: 'sibling-gap', key: (gap && gap.surface) || '', reason });
  }
  for (const item of envelope.discrepancies) {
    skipped.push({ kind: 'discrepancy', key: (item && item.claim) || '', reason });
  }
  return skipped;
}

/**
 * Apply a resolutions envelope to brief.md, routing each kind to its section.
 *
 * @param {string} briefPath
 * @param {object|Map|null|undefined} payload — envelope
 *   `{ openQuestions?, siblingGaps?, discrepancies? }` or a legacy flat
 *   questionText→answer map.
 * @returns {{ changed: boolean,
 *             applied: Array<{kind: string, key: string}>,
 *             skipped: Array<{kind: string, key: string, reason: string}>,
 *             refused: 'step'|null,
 *             message?: string }}
 */
function applyGateResolutions(briefPath, payload) {
  const result = { changed: false, applied: [], skipped: [], refused: null };
  const envelope = normalizeEnvelope(payload);
  // Cancellation / empty payload — no I/O at all (not even the guard probe).
  if (countEntries(envelope) === 0) return result;

  const guardMessage = checkStepGuard(briefPath);
  if (guardMessage) {
    return { ...result, refused: 'step', message: guardMessage };
  }

  let markdown;
  try {
    markdown = fs.readFileSync(briefPath, 'utf8');
  } catch {
    return { ...result, skipped: skipAllEntries(envelope, 'brief-unreadable') };
  }

  let updated = markdown;
  updated = applyOpenQuestions(updated, envelope.openQuestions, result.applied, result.skipped);
  updated = applySiblingGaps(updated, envelope.siblingGaps, result.applied, result.skipped);
  updated = applyDiscrepancies(updated, envelope.discrepancies, result.applied, result.skipped);

  if (updated === markdown) return result;

  try {
    fs.writeFileSync(briefPath, updated, 'utf8');
  } catch {
    // Fail-closed no-throw contract: nothing persisted, report every
    // would-be-applied entry as skipped so the caller retains the answers.
    result.skipped.push(
      ...result.applied.map((a) => ({ kind: a.kind, key: a.key, reason: 'write-failed' }))
    );
    result.applied = [];
    return result;
  }
  result.changed = true;
  return result;
}

/**
 * True when every envelope entry was applied or was already recorded — the
 * condition under which the answers file may be consumed (deleted).
 */
function isFullyApplied(result) {
  if (!result || result.refused) return false;
  return (result.skipped || []).every((s) => s && s.reason === 'already-recorded');
}

module.exports = {
  applyGateResolutions,
  isFullyApplied,
  DEFAULT_ANSWERS_BASENAME,
};
