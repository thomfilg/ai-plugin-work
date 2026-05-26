/**
 * Phase: draft — brief.md with required sections + searched Open Questions.
 *
 * The agent investigates ambiguities BEFORE drafting (each Open Question
 * carries a `Searched:` annotation listing the paths/queries consulted),
 * then writes brief.md. We validate every required section is present and
 * every Open Question is annotated.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { BRIEF_PHASES } = require('../../brief-phase-registry');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Headings ending in `)` (like `### Must Have (P0)`) followed by `\n` are
// two non-word chars in a row, where `\b` does NOT match. Using
// `(?=\s|$)` is correct for both word-ending and paren-ending headings.
const REQUIRED_BRIEF_SECTIONS = [
  /^##\s+Problem Statement(?=\s|$)/im,
  /^##\s+Goal(?=\s|$)/im,
  /^##\s+Target Users(?=\s|$)/im,
  /^###\s+Must Have\s*\(P0\)(?=\s|$)/im,
  /^##\s+Constraints(?=\s|$)/im,
  /^##\s+Out of scope\s*\(sibling-owned\)(?=\s|$)/im,
  /^##\s+Success Metrics(?=\s|$)/im,
  /^##\s+Open Questions(?=\s|$)/im,
];

function sliceSection(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const f = path.join(tasksDir, 'brief.md');
  const c = readFile(f);
  if (!c) {
    errors.push(`Missing ${f}.`);
    return errors;
  }
  for (const re of REQUIRED_BRIEF_SECTIONS) {
    if (!re.test(c)) errors.push(`brief.md missing required section: ${re}.`);
  }
  // Open Questions: each non-empty entry must carry a `Searched:` line.
  // The "no open questions" placeholder is `- _None._` (or `- None.`,
  // `- N/A`) — recognised and exempt from the annotation requirement.
  const oq = sliceSection(c, /^##\s+Open Questions\b/im) || '';
  const EMPTY_PLACEHOLDER_RE = /^[-*+]\s+(?:_?(?:none|n\/a|nothing)\b\.?_?|—|-)\s*$/i;
  const bullets = oq
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+/.test(l));
  for (const b of bullets) {
    if (EMPTY_PLACEHOLDER_RE.test(b)) continue;
    if (!/Searched:/i.test(b)) {
      const idx = oq.indexOf(b);
      const tail = oq.slice(idx + b.length, idx + b.length + 400);
      if (!/Searched:/i.test(tail)) {
        errors.push(
          `Open Question without 'Searched:' annotation: "${b.slice(0, 100)}". Each open question must list what docs/code you searched (paths + patterns) before leaving it open. If you have no open questions, write '- _None._' under the heading.`
        );
      }
    }
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: 'brief.md drafted' };
}

function instructions(ctx) {
  const { ticket, tasksDir } = ctx;
  const briefPath = path.join(tasksDir, 'brief.md');
  return [
    `# brief-next — Phase 3 of 5: DRAFT`,
    `Ticket: ${ticket}`,
    '',
    '### Before drafting: investigate docs for ambiguities',
    "List every ambiguity you would otherwise drop into Open Questions. For EACH ambiguity, search the project docs (README, docs/, ADRs, design notes, this plugin's own AGENTS.md) AND the codebase for prior resolutions BEFORE leaving it open. If a search resolves the ambiguity, fold the answer into the brief proper. If not, leave it open AND record what you searched.",
    '',
    '### Required brief structure',
    `Write \`${briefPath}\` with all of the following sections (exact headings):`,
    '',
    '- `## Problem Statement` — one paragraph, user-facing pain.',
    '- `## Goal` — one paragraph, measurable outcome.',
    '- `## Target Users` — bulleted list of personas.',
    '- `## Requirements`',
    '  - `### Must Have (P0)` — numbered list. Each P0 maps to one or more ticket AC items.',
    '  - `### Should Have (P1)` — optional, numbered.',
    '  - `### Could Have (P2)` — optional, numbered.',
    '- `## Constraints` — bulleted: timelines, tech limits, compliance.',
    '- `## Out of scope (sibling-owned)` — populated from sibling-overlap.md (every sibling marked `sibling-owned`). One bullet per surface, citing the sibling ID.',
    '- `## Success Metrics` — bulleted measurable outcomes.',
    '- `## Open Questions` — bulleted. Each MUST carry a `Searched:` annotation listing what you looked at, e.g.:',
    '',
    '  ```',
    '  - Should the retry use exponential backoff or fixed delay?',
    '    Searched: docs/architecture/retry.md, ADR-014, grep "backoff" in services/ → no prior decision.',
    '  ```',
    '',
    '  If you have no open questions, write `- _None._` under the heading. Do NOT use the section as a parking lot for unsearched ambiguities.',
    '',
    '### What I will check before advancing',
    `- All required sections present in \`${briefPath}\``,
    '- Every Open Questions bullet has a `Searched:` annotation OR the section contains `_None._`',
    '',
    'When done, re-invoke me.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(BRIEF_PHASES.draft, {
    next: BRIEF_PHASES.validate,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.REQUIRED_BRIEF_SECTIONS = REQUIRED_BRIEF_SECTIONS;
