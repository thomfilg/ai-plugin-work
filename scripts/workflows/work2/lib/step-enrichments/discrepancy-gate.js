/**
 * Discrepancy-gate enrichment (Gate B').
 *
 * Runs at brief_gate, spec_gate, and implement (no separate tasks_gate
 * exists in /work2). Compares claims pairwise across artifacts with the
 * precedence order:
 *
 *   user-prompt.md  >  tasks.md  >  spec.md  >  brief.md  >  ticket.json
 *
 * For each detected discrepancy not yet resolved (no entry in the lower
 * artifact's `## Discrepancy decisions` section), appends a user-scoped
 * question to `entry.askUserQuestionPayload` so the existing brief_gate /
 * spec_gate AskUserQuestion routing picks it up.
 *
 * The user-prompt.md artifact is OPTIONAL. When absent the gate skips the
 * user-prompt ↔ * comparisons but still runs lower-precedence pairs.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  extractClaims,
  compareClaims,
  buildDiscrepancyQuestions,
  extractRecordedDecisions,
  filterUnresolved,
} = require('../../../lib/discrepancy');

function _read(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function _ticketText(tasksDir) {
  const j = _read(path.join(tasksDir, 'ticket.json'));
  if (!j) return null;
  try {
    const parsed = JSON.parse(j);
    return [parsed.title, parsed.body || parsed.description || ''].filter(Boolean).join('\n');
  } catch {
    return null;
  }
}

function _loadArtifacts(tasksDir) {
  return {
    userPrompt: _read(path.join(tasksDir, 'user-prompt.md')),
    brief: _read(path.join(tasksDir, 'brief.md')),
    spec: _read(path.join(tasksDir, 'spec.md')),
    tasks: _read(path.join(tasksDir, 'tasks.md')),
    ticket: _ticketText(tasksDir),
  };
}

/**
 * Per-step comparison list. At each gate, the LOWER artifact (the one
 * being approved) is compared against every higher-precedence artifact.
 * Returns Array<[higherLabel, higherText, lowerLabel, lowerText]>.
 */
function _pairsForStep(step, art) {
  const lower = {
    brief_gate: ['brief', art.brief],
    spec_gate: ['spec', art.spec],
    implement: ['tasks', art.tasks],
  }[step];
  if (!lower || !lower[1]) return [];
  // Highest precedence first; lower-precedence label is the artifact being approved.
  const order = ['user prompt', 'ticket', 'brief', 'spec', 'tasks'];
  const sources = {
    'user prompt': art.userPrompt,
    tasks: art.tasks,
    spec: art.spec,
    brief: art.brief,
    ticket: art.ticket,
  };
  const lowerIdx = order.indexOf(lower[0]);
  const pairs = [];
  for (const label of order.slice(0, lowerIdx)) {
    if (sources[label]) pairs.push([label, sources[label], lower[0], lower[1]]);
  }
  return pairs;
}

function _gatherQuestions(step, art) {
  const pairs = _pairsForStep(step, art);
  let allQs = [];
  for (const [hLabel, hText, lLabel, lText] of pairs) {
    const cmp = compareClaims(extractClaims(hText), extractClaims(lText));
    const qs = buildDiscrepancyQuestions(cmp, hLabel, lLabel);
    allQs = allQs.concat(qs);
  }
  // Filter out claims that already have decisions recorded in the lower artifact
  const lowerText = {
    brief_gate: art.brief,
    spec_gate: art.spec,
    implement: art.tasks,
  }[step];
  const decisions = extractRecordedDecisions(lowerText);
  return filterUnresolved(allQs, decisions);
}

function _inject(entry, qs) {
  if (qs.length === 0) return;
  const existing = entry.askUserQuestionPayload || { questions: [] };
  const merged = (existing.questions || []).slice();
  for (const q of qs) merged.push(q);
  entry.askUserQuestionPayload = { ...existing, questions: merged };
}

const STEPS = ['brief_gate', 'spec_gate', 'implement'];

module.exports = function registerDiscrepancyGate(register) {
  for (const step of STEPS) {
    register(step, (entry, ctx) => {
      // Defer to whichever blocker already won — Gate 0, A, B, C, etc.
      if (entry._overrideInstruction) return;
      try {
        const art = _loadArtifacts(ctx.tasksDir);
        const qs = _gatherQuestions(step, art);
        _inject(entry, qs);
      } catch {
        /* fail-open */
      }
    });
  }
};
