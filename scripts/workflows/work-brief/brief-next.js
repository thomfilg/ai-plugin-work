#!/usr/bin/env node

/**
 * brief-next.js
 *
 * Self-paced runner for the `brief` step, modeled on task-next.js for
 * `implement`. The agent invokes this script and follows the Markdown
 * response. Each phase validates artifacts, records evidence, and
 * advances. Phases (in order):
 *
 *   1. inputs    — recall memory, fetch ticket + every linked ticket's
 *                  FULL content (not just titles), save to _related/.
 *   2. overlap   — analyze overlaps with each linked ticket, write
 *                  sibling-overlap.md with one section per linked ticket
 *                  and a verdict (sibling-owned | shared | no-overlap).
 *   3. draft     — investigate docs for ambiguities, then write brief.md
 *                  with required sections. Each Open Question entry MUST
 *                  carry a `Searched:` annotation listing the paths/queries
 *                  consulted, OR the section is empty.
 *   4. validate  — re-check section presence, AC→P0 mapping, and that
 *                  brief.md's `Out of scope (sibling-owned)` reflects the
 *                  sibling-owned verdicts from sibling-overlap.md.
 *   5. memorize  — persist decisions via the installed memory plugin
 *                  (e.g. cortex). Skipped with a warning if none detected.
 *
 * The script is the source of truth for what to do at every phase. The
 * agent only sees the printed Markdown; it does not need to know the
 * gate logic.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BRIEF_PHASE_CLI = path.resolve(__dirname, 'brief-phase-state.js');

let logNextScriptEvent;
try {
  ({ logNextScriptEvent } = require('../lib/next-script-log'));
} catch {
  logNextScriptEvent = () => {};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let config;
try {
  config = require('../lib/config');
} catch {
  config = null;
}

function resolveTasksBase() {
  return (
    process.env.TASKS_BASE ||
    (config && config.TASKS_BASE) ||
    path.join(require('node:os').homedir(), 'worktrees', 'tasks')
  );
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function die(msg) {
  process.stderr.write(`brief-next: ${msg}\n`);
  process.exit(2);
}

function resolveWorktreeRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ─── Token snapshot/remint (mirrors task-next.js) ──────────────────────────

let _companionTokenSnapshot = null;

function snapshotCompanionToken(scriptBasename) {
  try {
    const dir = process.env.CLAUDE_WRITE_TOKEN_DIR || '/tmp/.claude-write-tokens';
    const file = path.join(dir, scriptBasename);
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    _companionTokenSnapshot = { path: file, data };
  } catch {
    /* fail-open — phase recording will surface the missing token */
  }
}

function mintCompanionToken() {
  if (!_companionTokenSnapshot) return false;
  try {
    fs.mkdirSync(path.dirname(_companionTokenSnapshot.path), { recursive: true, mode: 0o700 });
    const data = { ..._companionTokenSnapshot.data, timestamp: Date.now() };
    fs.writeFileSync(_companionTokenSnapshot.path, JSON.stringify(data), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ─── Memory plugin detection ───────────────────────────────────────────────

/**
 * Detect installed memory plugins (cortex, mem0, anything that exposes
 * recall/remember tools). Returns { name, recallTool, rememberTool } or
 * null. The check looks for known plugin manifest paths under ~/.claude/.
 */
function detectMemoryPlugin() {
  const home = require('node:os').homedir();
  const candidates = [
    {
      manifestGlob: ['.claude/plugins/marketplaces', '.claude/plugins/cache'],
      probe: /cortex/i,
      name: 'cortex',
      recallTool: 'mcp__plugin_cortex_cortex__cortex_recall',
      rememberTool: 'mcp__plugin_cortex_cortex__cortex_remember',
      saveTool: 'mcp__plugin_cortex_cortex__cortex_save',
    },
    {
      manifestGlob: ['.claude/plugins/marketplaces', '.claude/plugins/cache'],
      probe: /mem0/i,
      name: 'mem0',
      recallTool: 'mem0_recall',
      rememberTool: 'mem0_remember',
      saveTool: null,
    },
  ];
  for (const c of candidates) {
    for (const base of c.manifestGlob) {
      const dir = path.join(home, base);
      if (!fs.existsSync(dir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => c.probe.test(e.name))) {
        return c;
      }
    }
  }
  return null;
}

// ─── related-tickets.json reading ──────────────────────────────────────────

function readRelatedManifest(tasksDir) {
  const p = path.join(tasksDir, 'related-tickets.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function listLinkedIds(manifest) {
  if (!manifest) return [];
  const ids = new Set();
  if (manifest.parent && manifest.parent.id) ids.add(manifest.parent.id);
  for (const key of ['siblings', 'blockedBy', 'dependsOn', 'relatedTo']) {
    for (const e of manifest[key] || []) if (e && e.id) ids.add(e.id);
  }
  return [...ids];
}

// ─── Phase state CLI wrappers ──────────────────────────────────────────────

function callPhaseCli(args) {
  mintCompanionToken();
  const r = spawnSync(process.execPath, [BRIEF_PHASE_CLI, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return { code: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}

function getCurrentPhase(ticket) {
  const r = callPhaseCli(['current', ticket]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out.trim().split('\n').pop());
    return j.currentPhase;
  } catch {
    return null;
  }
}

function ensureInit(ticket) {
  const r = callPhaseCli(['init', ticket]);
  if (r.code !== 0) die(`Could not init brief-phase state:\n${r.out}`);
}

function recordPhase(ticket, phase, summary) {
  return callPhaseCli(['record', ticket, phase, '--summary', summary || '']);
}

function transitionPhase(ticket, target) {
  return callPhaseCli(['transition', ticket, target]);
}

// ─── Phase validation logic ────────────────────────────────────────────────

function validateInputs(tasksDir, manifest, linkedIds) {
  const errors = [];
  const relDir = path.join(tasksDir, '_related');
  if (!fs.existsSync(relDir)) {
    errors.push(
      `Missing directory ${relDir}. Save each linked ticket's full content as ${relDir}/<TICKET-ID>.md.`
    );
    return errors;
  }
  for (const id of linkedIds) {
    const f = path.join(relDir, `${id}.md`);
    const c = readFile(f);
    if (!c || c.trim().length < 50) {
      errors.push(
        `Missing or too-short ${f} (< 50 chars). Fetch the linked ticket's FULL description (not just title) and save it here.`
      );
    }
  }
  return errors;
}

function validateOverlap(tasksDir, linkedIds) {
  const errors = [];
  const f = path.join(tasksDir, 'sibling-overlap.md');
  const c = readFile(f);
  if (!c) {
    errors.push(`Missing ${f}.`);
    return errors;
  }
  for (const id of linkedIds) {
    const headerRe = new RegExp(`^##\\s+${id}\\b`, 'm');
    if (!headerRe.test(c)) {
      errors.push(`sibling-overlap.md is missing section for ${id} (expected '## ${id}').`);
      continue;
    }
    const startIdx = c.match(headerRe).index;
    const after = c.slice(startIdx);
    const nextHdr = after.slice(2).match(/^##\s/m);
    const section = nextHdr ? after.slice(0, nextHdr.index + 2) : after;
    if (!/\*\*Verdict:\*\*\s*(sibling-owned|shared|no-overlap)\b/i.test(section)) {
      errors.push(
        `sibling-overlap.md section for ${id} missing '**Verdict:** sibling-owned|shared|no-overlap'.`
      );
    }
  }
  return errors;
}

const REQUIRED_BRIEF_SECTIONS = [
  /^##\s+Problem Statement\b/im,
  /^##\s+Goal\b/im,
  /^##\s+Target Users\b/im,
  /^###\s+Must Have\s*\(P0\)\b/im,
  /^##\s+Constraints\b/im,
  /^##\s+Out of scope\s*\(sibling-owned\)\b/im,
  /^##\s+Success Metrics\b/im,
  /^##\s+Open Questions\b/im,
];

function sliceSection(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

function validateDraft(tasksDir) {
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
  const oq = sliceSection(c, /^##\s+Open Questions\b/im) || '';
  const bullets = oq
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+/.test(l));
  for (const b of bullets) {
    // Each bullet must either close with "Searched:" inline or be followed
    // by an indented sub-bullet starting with "Searched:". Accept either.
    if (!/Searched:/i.test(b)) {
      // look for sub-bullet by scanning lines after this one
      const idx = oq.indexOf(b);
      const tail = oq.slice(idx + b.length, idx + b.length + 400);
      if (!/Searched:/i.test(tail)) {
        errors.push(
          `Open Question without 'Searched:' annotation: "${b.slice(0, 100)}". Each open question must list what docs/code you searched (paths + patterns) before leaving it open.`
        );
      }
    }
  }
  return errors;
}

function validateValidate(tasksDir, linkedIds) {
  const errors = [];
  const briefPath = path.join(tasksDir, 'brief.md');
  const overlapPath = path.join(tasksDir, 'sibling-overlap.md');
  const brief = readFile(briefPath);
  const overlap = readFile(overlapPath);
  if (!brief) errors.push(`Missing ${briefPath}.`);
  if (!overlap) errors.push(`Missing ${overlapPath}.`);
  if (!brief || !overlap) return errors;

  // Every sibling-owned verdict in overlap.md must appear in brief.md's
  // `Out of scope (sibling-owned)` section.
  const oos = sliceSection(brief, /^##\s+Out of scope\s*\(sibling-owned\)\b/im) || '';
  for (const id of linkedIds) {
    const headerRe = new RegExp(`^##\\s+${id}\\b`, 'm');
    const m = overlap.match(headerRe);
    if (!m) continue;
    const startIdx = m.index;
    const after = overlap.slice(startIdx);
    const nextHdr = after.slice(2).match(/^##\s/m);
    const section = nextHdr ? after.slice(0, nextHdr.index + 2) : after;
    const verdict = (section.match(/\*\*Verdict:\*\*\s*(sibling-owned|shared|no-overlap)/i) ||
      [])[1];
    if (verdict && verdict.toLowerCase() === 'sibling-owned') {
      if (!oos.includes(id)) {
        errors.push(
          `brief.md 'Out of scope (sibling-owned)' is missing ${id}, which sibling-overlap.md marks sibling-owned.`
        );
      }
    }
  }
  return errors;
}

// ─── Phase instructions (Markdown to the agent) ────────────────────────────

function instructInputs(ctx) {
  const { ticket, tasksDir, linkedIds, manifest, memory } = ctx;
  const memBlock = memory
    ? [
        '',
        `### 0. Recall prior memory (${memory.name})`,
        `Before reading anything, call \`${memory.recallTool}\` with each of these queries (one call per query) and read the results:`,
        `- \`${ticket}\``,
        `- the ticket title (extract from related-tickets.json self field if present)`,
        `- "${ticket} brief"`,
        `- "sibling overlap" + the area of work (e.g. tRPC, schema, component name)`,
        `- "past decisions" + the area of work`,
        '',
        'Treat any hits as authoritative prior context — read them in full before you draft anything. If multiple agents have already decided how to scope this ticket, do not re-litigate; carry the decision forward.',
      ]
    : [
        '',
        '### 0. Recall prior memory',
        'No memory plugin detected. Skipping recall step. If you have a memory plugin installed, surface it to the orchestrator so this step can be enabled.',
      ];
  return [
    `# brief-next — Phase 1 of 5: INPUTS`,
    `Ticket: ${ticket}`,
    `Tasks dir: ${tasksDir}`,
    '',
    ...memBlock,
    '',
    '### 1. Read your own ticket',
    `Open the ticket payload your previous workflow step fetched (typically under \`${path.join(tasksDir, 'ticket')}.{md,json}\` or surfaced in the previous step output). Read every field: title, description, acceptance criteria, comments. Take notes.`,
    '',
    '### 2. Read every linked ticket — FULL CONTENT, not just title',
    manifest
      ? `\`related-tickets.json\` lists ${linkedIds.length} linked ticket(s): ${linkedIds.join(', ') || '(none)'}. For EACH id, fetch the full description (jira/linear/gh) and save it to \`${path.join(tasksDir, '_related')}/<id>.md\`. Title is not enough — you must read the full body to detect overlaps in phase 2.`
      : 'No `related-tickets.json` found. Generate it first via the related-tickets-inject step or have the orchestrator regenerate it. This script will block until the manifest is present.',
    '',
    '### What I will check before advancing',
    `- \`${path.join(tasksDir, 'related-tickets.json')}\` exists`,
    `- For every linked ticket id, \`${path.join(tasksDir, '_related')}/<id>.md\` exists with at least 50 chars of body (title-only files are rejected)`,
    '',
    'When done, re-invoke me.',
    '',
  ].join('\n');
}

function instructOverlap(ctx) {
  const { ticket, tasksDir, linkedIds } = ctx;
  const overlapPath = path.join(tasksDir, 'sibling-overlap.md');
  return [
    `# brief-next — Phase 2 of 5: OVERLAP`,
    `Ticket: ${ticket}`,
    '',
    '### Task',
    `Read every file in \`${path.join(tasksDir, '_related')}/\`. For each linked ticket (${linkedIds.length}), decide whether your ticket overlaps with theirs in any surface: file paths, tRPC procedures, schemas, components, endpoints, DB tables, environment variables, or product flows.`,
    '',
    `Write \`${overlapPath}\` in this exact format:`,
    '',
    '```markdown',
    '# Sibling Overlap Analysis',
    '',
    '## <TICKET-ID> — <title>',
    '**Verdict:** sibling-owned | shared | no-overlap',
    '**Surfaces:** comma-separated list of overlapping surfaces (file paths, procedures, schemas...)',
    '**Notes:** one-to-three sentence rationale, citing specific lines/paragraphs from the sibling description that informed the verdict.',
    '',
    '## <NEXT-TICKET-ID> — ...',
    '...',
    '```',
    '',
    '### Verdict semantics',
    "- **sibling-owned** — the surface is theirs; you must put it in your brief's `## Out of scope (sibling-owned)` and not implement it.",
    '- **shared** — both tickets touch it; coordination required. Note who owns the change.',
    '- **no-overlap** — different concerns; no risk of stepping on each other.',
    '',
    '### What I will check before advancing',
    `- \`${overlapPath}\` exists`,
    `- One \`## <TICKET-ID>\` section per linked ticket (${linkedIds.length} sections)`,
    `- Each section has a \`**Verdict:**\` line with one of the three values`,
    '',
    'When done, re-invoke me.',
    '',
  ].join('\n');
}

function instructDraft(ctx) {
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

function instructValidate(ctx) {
  const { ticket, tasksDir } = ctx;
  return [
    `# brief-next — Phase 4 of 5: VALIDATE`,
    `Ticket: ${ticket}`,
    '',
    '### What I check',
    `- \`brief.md\` has every required section.`,
    `- Every linked ticket marked \`sibling-owned\` in sibling-overlap.md is referenced in brief.md's \`Out of scope (sibling-owned)\`.`,
    '',
    'If validation passes, I record the phase and advance you to MEMORIZE. If it fails, I print the gaps and you fix them.',
    '',
    'Re-invoke me to run the check.',
    '',
  ].join('\n');
}

function instructMemorize(ctx) {
  const { ticket, memory, linkedIds } = ctx;
  if (!memory) {
    return [
      `# brief-next — Phase 5 of 5: MEMORIZE (skipped)`,
      '',
      'No memory plugin detected on this machine. Recording phase as complete with `summary=no-memory-plugin` and advancing to done.',
      '',
      'To enable memory persistence, install a plugin like cortex and re-run this workflow.',
      '',
    ].join('\n');
  }
  return [
    `# brief-next — Phase 5 of 5: MEMORIZE (${memory.name})`,
    `Ticket: ${ticket}`,
    '',
    '### Task',
    `Persist your key decisions via \`${memory.rememberTool}\` so future agents can recall them. Save AT LEAST these entries (one tool call each — DO NOT batch into one entry):`,
    '',
    `1. **Ticket overview**: tag with the ticket ID and area-of-work keywords. Body = problem statement + goal from brief.md.`,
    `2. **Sibling ownership map**: for each linked ticket (${linkedIds.length}), save the verdict from sibling-overlap.md with tags ${ticket}, sibling-overlap, and the linked ticket id.`,
    `3. **P0 requirements**: save the Must Have (P0) list with tags ${ticket}, requirements, P0.`,
    `4. **Open questions + their searches**: save each unresolved Open Question with the search trail. Tag ${ticket}, open-question, plus the area keyword.`,
    `5. **Out-of-scope reasoning**: save the sibling-owned out-of-scope list so the next agent working on a related ticket can recall who owns what.`,
    '',
    memory.saveTool
      ? `Finally, archive the session via \`${memory.saveTool}\` so the full conversation context is queryable.`
      : '',
    '',
    '### Why this matters',
    'When a sibling/follow-up ticket runs `brief-next` later, its INPUTS phase will recall these entries and avoid re-litigating decisions you already made. Skip this and you waste future agent time on questions you already answered.',
    '',
    'When done, re-invoke me and I will transition you to done.',
    '',
  ].join('\n');
}

function instructDone(ctx) {
  return [
    `# brief-next — DONE`,
    `Ticket: ${ctx.ticket}`,
    '',
    'All five phases recorded. Artifacts:',
    `- \`brief.md\``,
    `- \`sibling-overlap.md\``,
    `- \`_related/<id>.md\` (per linked ticket)`,
    `- \`brief-phase.json\``,
    '',
    'Re-invoke /work2 (or /work) to advance to the brief_gate step.',
    '',
  ].join('\n');
}

// ─── Main ──────────────────────────────────────────────────────────────────

function main(argv) {
  const startedAt = Date.now();
  const args = argv.slice(2);
  const ticket = args[0];
  if (!ticket || /^-/.test(ticket)) {
    process.stderr.write('usage: brief-next.js <TICKET>\n  e.g. node brief-next.js ECHO-4560\n');
    process.exit(2);
  }
  logNextScriptEvent('brief-next', {
    event: 'invoked',
    ticket,
    cwd: process.cwd(),
    agent: process.env.CLAUDE_CURRENT_AGENT || null,
  });

  snapshotCompanionToken('brief-phase-state.js');

  const tasksBase = resolveTasksBase();
  const tasksDir = path.join(tasksBase, ticket);
  if (!fs.existsSync(tasksDir)) die(`tasks dir not found: ${tasksDir}`);

  const manifest = readRelatedManifest(tasksDir);
  const linkedIds = listLinkedIds(manifest);
  const memory = detectMemoryPlugin();
  const worktreeRoot = resolveWorktreeRoot() || path.dirname(tasksBase);

  ensureInit(ticket);
  let phase = getCurrentPhase(ticket) || 'inputs';

  const ctx = { ticket, tasksDir, tasksBase, manifest, linkedIds, memory, worktreeRoot };

  // Validation gates: each phase validates inputs FROM the previous instruction.
  // If validation fails, print the failures and the current-phase instructions.
  let blockReason = '';
  let advanced = false;

  if (phase === 'inputs') {
    if (!manifest) {
      blockReason = `related-tickets.json missing at ${path.join(tasksDir, 'related-tickets.json')}. Cannot proceed without sibling context.`;
    } else {
      const errs = validateInputs(tasksDir, manifest, linkedIds);
      if (errs.length === 0 && linkedIds.length >= 0) {
        const r = recordPhase(
          ticket,
          'inputs',
          `linked=${linkedIds.length} memory=${memory ? memory.name : 'none'}`
        );
        if (r.code !== 0) blockReason = `Could not record phase inputs:\n${r.out}`;
        else {
          const t = transitionPhase(ticket, 'overlap');
          if (t.code !== 0) blockReason = `Could not transition to overlap:\n${t.out}`;
          else {
            advanced = true;
            phase = 'overlap';
          }
        }
      } else if (errs.length > 0) {
        blockReason = errs.join('\n');
      }
    }
  } else if (phase === 'overlap') {
    const errs = validateOverlap(tasksDir, linkedIds);
    if (errs.length === 0) {
      const r = recordPhase(ticket, 'overlap', `siblings=${linkedIds.length}`);
      if (r.code !== 0) blockReason = `Could not record phase overlap:\n${r.out}`;
      else {
        const t = transitionPhase(ticket, 'draft');
        if (t.code !== 0) blockReason = `Could not transition to draft:\n${t.out}`;
        else {
          advanced = true;
          phase = 'draft';
        }
      }
    } else {
      blockReason = errs.join('\n');
    }
  } else if (phase === 'draft') {
    const errs = validateDraft(tasksDir);
    if (errs.length === 0) {
      const r = recordPhase(ticket, 'draft', 'brief.md drafted');
      if (r.code !== 0) blockReason = `Could not record phase draft:\n${r.out}`;
      else {
        const t = transitionPhase(ticket, 'validate');
        if (t.code !== 0) blockReason = `Could not transition to validate:\n${t.out}`;
        else {
          advanced = true;
          phase = 'validate';
        }
      }
    } else {
      blockReason = errs.join('\n');
    }
  } else if (phase === 'validate') {
    const errs = validateValidate(tasksDir, linkedIds);
    if (errs.length === 0) {
      const r = recordPhase(ticket, 'validate', 'cross-checks ok');
      if (r.code !== 0) blockReason = `Could not record phase validate:\n${r.out}`;
      else {
        const t = transitionPhase(ticket, 'memorize');
        if (t.code !== 0) blockReason = `Could not transition to memorize:\n${t.out}`;
        else {
          advanced = true;
          phase = 'memorize';
        }
      }
    } else {
      blockReason = errs.join('\n');
    }
  } else if (phase === 'memorize') {
    // We can't verify memory writes (no introspection across plugins).
    // Record on re-invoke; if no memory plugin, auto-advance.
    if (!memory) {
      const r = recordPhase(ticket, 'memorize', 'no-memory-plugin');
      if (r.code !== 0) blockReason = `Could not record phase memorize:\n${r.out}`;
      else {
        const t = transitionPhase(ticket, 'done');
        if (t.code !== 0) blockReason = `Could not transition to done:\n${t.out}`;
        else {
          advanced = true;
          phase = 'done';
        }
      }
    } else {
      // First call in memorize prints instructions. Second call (when agent
      // has finished saving) advances. We detect "second call" by the
      // presence of a sentinel file the agent must touch after persisting.
      const sentinel = path.join(tasksDir, '.brief-memorized');
      if (fs.existsSync(sentinel)) {
        const r = recordPhase(ticket, 'memorize', `via=${memory.name}`);
        if (r.code !== 0) blockReason = `Could not record phase memorize:\n${r.out}`;
        else {
          const t = transitionPhase(ticket, 'done');
          if (t.code !== 0) blockReason = `Could not transition to done:\n${t.out}`;
          else {
            advanced = true;
            phase = 'done';
          }
        }
      }
    }
  }

  // Compose response
  const header = [
    `brief-next: ${ticket}`,
    `  tasks dir: ${tasksDir}`,
    `  current phase (after this run): ${phase}`,
    `  memory plugin: ${memory ? memory.name : '(none detected)'}`,
    `  linked tickets: ${linkedIds.length}${linkedIds.length ? ` (${linkedIds.join(', ')})` : ''}`,
    advanced ? '  result: PHASE ADVANCED' : blockReason ? '  result: BLOCKED' : '  result: WAITING',
    '',
  ].join('\n');

  let body;
  if (blockReason && !advanced) {
    body = [
      `## ❌ Phase ${phase.toUpperCase()} blocked`,
      '',
      '```',
      blockReason,
      '```',
      '',
      '---',
      '',
      phase === 'inputs'
        ? instructInputs(ctx)
        : phase === 'overlap'
          ? instructOverlap(ctx)
          : phase === 'draft'
            ? instructDraft(ctx)
            : phase === 'validate'
              ? instructValidate(ctx)
              : instructMemorize(ctx),
    ].join('\n');
  } else {
    body =
      phase === 'inputs'
        ? instructInputs(ctx)
        : phase === 'overlap'
          ? instructOverlap(ctx)
          : phase === 'draft'
            ? instructDraft(ctx)
            : phase === 'validate'
              ? instructValidate(ctx)
              : phase === 'memorize'
                ? instructMemorize(ctx)
                : instructDone(ctx);
  }

  process.stdout.write(header + '\n' + body);
  const exitCode = blockReason && !advanced ? 2 : 0;
  logNextScriptEvent('brief-next', {
    event: 'completed',
    ticket,
    phase,
    advanced,
    blocked: Boolean(blockReason),
    blockReason: blockReason ? blockReason.slice(0, 500) : null,
    linkedTickets: linkedIds.length,
    memoryPlugin: memory ? memory.name : null,
    exitCode,
    durationMs: Date.now() - startedAt,
  });
  process.exit(exitCode);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (e) {
    die(e.message || String(e));
  }
}

module.exports = { detectMemoryPlugin };
