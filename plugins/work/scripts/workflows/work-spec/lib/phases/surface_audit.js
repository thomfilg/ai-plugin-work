/**
 * Phase: surface_audit — verify every sibling-owned identifier the spec
 * references actually exists in the sibling-owned file.
 *
 * This is the ECHO-4579 defense. The brief said "no backend changes" but
 * required projecting `workbookId/workbookName/ownerId/locationId/locationName`
 * fields that did not exist on the sibling-owned schema. The agent caught it
 * at implement time and silently extended the sibling's surface — that
 * should have been blocked here.
 *
 * Algorithm:
 *   1. Read related-tickets.json — collect each sibling's `surfaces[]` array
 *      of repo-relative file paths.
 *   2. From brief.md (and spec.md if present), extract every backticked
 *      identifier. Filter out built-in noise (`string`, `null`, etc.).
 *   3. Try to associate each identifier with a sibling-owned surface file:
 *        - dotted form `Schema.field` → match `Schema` against any surface.
 *        - generic-indexed form (`RouterOutputs[...]`) → unwrap to `RouterOutputs`.
 *        - bare bareword → fall back to any nearby file reference in the
 *          same bullet (best-effort; otherwise reported as a non-blocking
 *          WARNING rather than an error).
 *   4. For each (file, identifier) pair, grep the file (literal token).
 *      Miss → error.
 *   5. On success, write `## Verified sibling surface` block into spec.md.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SPEC_PHASES } = require('../../spec-phase-registry');

// Identifiers we never bother to check — common built-ins, primitives,
// and conventional null markers. Add sparingly.
const DENY = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'void',
  'any',
  'unknown',
  'true',
  'false',
  'Date',
  'Promise',
  'Array',
  'Record',
  'Partial',
  'Readonly',
  'Omit',
  'Pick',
  'object',
  'never',
  'this',
]);

const VERIFIED_HEADER = '## Verified sibling surface';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Pull every backticked token out of `text`. Returns an array of
 * { token, line } where line is the 1-based line number of the bullet
 * the token was found in (so the caller can correlate to nearby file
 * references).
 */
function isFilePathLike(token) {
  // Reject things that are clearly paths, not identifiers.
  if (token.includes('/')) return true;
  if (/\.(ts|tsx|js|jsx|json|md|yml|yaml|sql|sh|prisma|mjs|cjs)$/i.test(token)) return true;
  return false;
}

function extractBacktickIdentifiers(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Backtick spans — non-greedy, single-line.
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const token = m[1].trim();
      if (!token) continue;
      // File paths are not identifiers — surface_audit verifies the
      // identifiers AT those paths, not the paths themselves.
      if (isFilePathLike(token)) continue;
      out.push({ token, line: i + 1, lineText: line });
    }
  }
  return out;
}

/**
 * Try to extract a short identifier from a backtick token that may be a
 * dotted path, generic-indexed type, or plain name. Returns either:
 *   - a string (one identifier to check) for trivial cases, or
 *   - an array of strings if the token contains multiple identifier-like
 *     subparts the caller should check individually.
 *
 * Heuristics, not parsing — biased toward false negatives (skip), not
 * false positives (block).
 */
function normalizeIdentifier(token) {
  // Strip type-args / generics / index access.
  let t = token.trim();
  if (!t) return null;
  // Disallow tokens that include obvious code noise (parens, arrows, etc).
  if (/[()=>{}]/.test(t)) return null;
  // Generic-indexed: `RouterOutputs['explore']['list']['items'][number]`
  //   → keep the leading base identifier AND the bracketed string keys.
  if (/\[/.test(t)) {
    const base = t.split('[')[0].trim();
    const keys = [...t.matchAll(/\[\s*['"]([^'"]+)['"]\s*\]/g)].map((m) => m[1]);
    const out = [base, ...keys].filter(Boolean).filter((x) => !DENY.has(x));
    return out.length ? out : null;
  }
  // Dotted: `exploreItemSchema.workbookId` → check both.
  if (t.includes('.')) {
    const parts = t
      .split('.')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return null;
    const out = parts.filter((p) => /^[A-Za-z_$][\w$]*$/.test(p) && !DENY.has(p));
    return out.length ? out : null;
  }
  // Plain identifier.
  if (!/^[A-Za-z_$][\w$]*$/.test(t)) return null;
  if (DENY.has(t)) return null;
  return t;
}

function listSurfaceFiles(manifest) {
  if (!manifest) return [];
  const out = [];
  for (const key of ['siblings', 'blockedBy', 'dependsOn', 'relatedTo', 'parent']) {
    const arr = key === 'parent' ? [manifest.parent].filter(Boolean) : manifest[key] || [];
    for (const sib of arr) {
      if (!sib || !sib.id) continue;
      const surfaces = Array.isArray(sib.surfaces) ? sib.surfaces : [];
      for (const f of surfaces) {
        if (typeof f === 'string' && f) out.push({ siblingId: sib.id, file: f });
      }
    }
  }
  return out;
}

function fileContainsIdentifier(absPath, identifier) {
  // Literal word-boundary search. Avoids substring matches like
  // `workbookId` matching `workbookIdentifier`.
  const txt = readFile(absPath);
  if (txt == null) return false;
  const re = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return re.test(txt);
}

/**
 * Build the verified-surface block to inject into spec.md.
 */
function renderVerifiedBlock(verified) {
  if (!verified.length) {
    return [VERIFIED_HEADER, '', '_(no sibling-owned identifiers referenced)_', ''].join('\n');
  }
  const lines = [VERIFIED_HEADER, ''];
  for (const v of verified) {
    lines.push(`- \`${v.file}::${v.identifier}\` — found`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Replace an existing `## Verified sibling surface` section in spec.md (if
 * any) with the new block; otherwise append at end. Pure string transform,
 * returns the new content.
 */
function upsertVerifiedSection(specText, block) {
  if (!specText) return block;
  const idx = specText.indexOf(VERIFIED_HEADER);
  if (idx === -1) return `${specText.replace(/\s+$/, '')}\n\n${block}`;
  // Find the next `## ` heading after the header, or fall through to end of file.
  const after = specText.slice(idx + VERIFIED_HEADER.length);
  const nextHdr = after.match(/^##\s/m);
  const end = nextHdr ? idx + VERIFIED_HEADER.length + nextHdr.index : specText.length;
  return specText.slice(0, idx) + block + specText.slice(end);
}

function auditArtifacts(tasksDir, manifest) {
  const briefPath = path.join(tasksDir, 'brief.md');
  const specPath = path.join(tasksDir, 'spec.md');
  const brief = readFile(briefPath);
  const spec = readFile(specPath);
  const errors = [];
  const warnings = [];
  const verified = [];

  const surfaceFiles = listSurfaceFiles(manifest);
  if (!brief) {
    errors.push(`Missing ${briefPath}.`);
    return { errors, warnings, verified };
  }
  if (surfaceFiles.length === 0) {
    return {
      errors,
      warnings,
      verified,
      summary: 'no sibling-owned surfaces — nothing to verify',
    };
  }

  // worktree root = parent of tasksDir if tasks live under <worktree>/tasks
  // otherwise resolve via the canonical TASKS_BASE → worktree heuristic. We
  // probe both: the worktree root for the file, and the tasksDir's parent.
  const candidateRoots = [];
  // `ctx.worktreeRoot` is the truth, but this is a pure function — caller
  // passes `manifest`. Use the manifest's optional `worktreeRoot` if set,
  // otherwise climb from tasksDir.
  if (manifest.worktreeRoot && typeof manifest.worktreeRoot === 'string') {
    candidateRoots.push(manifest.worktreeRoot);
  }
  candidateRoots.push(path.resolve(tasksDir, '..', '..'));
  candidateRoots.push(path.resolve(tasksDir, '..'));

  function resolveSurfacePath(file) {
    for (const root of candidateRoots) {
      const p = path.resolve(root, file);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  // Collect candidate (token, source) pairs from brief + spec.
  const tokens = [
    ...extractBacktickIdentifiers(brief).map((t) => ({ ...t, source: 'brief' })),
    ...extractBacktickIdentifiers(spec || '').map((t) => ({ ...t, source: 'spec' })),
  ];

  for (const t of tokens) {
    const norm = normalizeIdentifier(t.token);
    if (norm == null) continue;
    const ids = Array.isArray(norm) ? norm : [norm];
    for (const id of ids) {
      // Find which surface file most plausibly contains this id.
      let hit = null;
      let missAttempt = null;
      for (const sf of surfaceFiles) {
        const abs = resolveSurfacePath(sf.file);
        if (!abs) {
          missAttempt = missAttempt || { file: sf.file, reason: 'file-not-resolved' };
          continue;
        }
        if (fileContainsIdentifier(abs, id)) {
          hit = { file: sf.file, identifier: id, siblingId: sf.siblingId };
          break;
        }
      }
      if (hit) {
        // Dedupe verified entries.
        if (!verified.some((v) => v.file === hit.file && v.identifier === hit.identifier)) {
          verified.push(hit);
        }
        continue;
      }

      // Heuristic mapping: does the line/bullet that wrapped the token
      // contain an explicit reference to one of the surface files? If so
      // it's an ERROR (the brief/spec explicitly tied the identifier to a
      // sibling-owned file but that file doesn't define it). Otherwise a
      // WARNING (can't confidently say it was meant to come from a
      // sibling).
      const lineRefersToSurface = surfaceFiles.find(
        (sf) => t.lineText.includes(sf.file) || t.lineText.includes(path.basename(sf.file))
      );
      if (lineRefersToSurface) {
        errors.push(
          `${t.source}.md mentions \`${id}\` in a bullet that references sibling-owned file \`${lineRefersToSurface.file}\`, but \`${id}\` was not found in that file. Sibling \`${lineRefersToSurface.siblingId}\` does not currently expose this identifier — escalate to the sibling owner before depending on it.`
        );
      } else {
        warnings.push(
          `${t.source}.md mentions \`${id}\` but no sibling-owned surface file contains it (probably internal — skipping).`
        );
      }
    }
  }

  return { errors, warnings, verified };
}

function writeVerifiedSection(tasksDir, verified) {
  const specPath = path.join(tasksDir, 'spec.md');
  const spec = readFile(specPath);
  const block = renderVerifiedBlock(verified);
  const next = upsertVerifiedSection(spec, block);
  if (next !== spec) {
    try {
      fs.writeFileSync(specPath, next);
    } catch {
      /* writing spec.md is hook-gated; failure is non-fatal — the artifact
         is still produced by the agent's next pass. */
    }
  }
}

function validate(ctx) {
  // Augment manifest with worktreeRoot for path resolution.
  const manifest = ctx.manifest ? { ...ctx.manifest, worktreeRoot: ctx.worktreeRoot } : null;
  if (!manifest) {
    // No manifest → no siblings → nothing to audit. Auto-pass.
    return { ok: true, summary: 'no related-tickets.json — nothing to audit' };
  }
  const { errors, warnings, verified } = auditArtifacts(ctx.tasksDir, manifest);
  if (verified.length) writeVerifiedSection(ctx.tasksDir, verified);
  if (errors.length) {
    return {
      ok: false,
      errors,
      summary: `${verified.length} verified, ${errors.length} missing, ${warnings.length} warnings`,
    };
  }
  return {
    ok: true,
    summary: `${verified.length} verified, 0 missing, ${warnings.length} warnings`,
  };
}

function instructions(ctx) {
  return [
    `# spec-next — Phase 3 of 8: SURFACE AUDIT`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    "For every sibling-owned file listed in `related-tickets.json` (each sibling's `surfaces[]`), I scan brief.md + spec.md for backticked identifiers (`workbookId`, `Schema.field`, `RouterOutputs[...]`, …) and verify each one actually exists in the file the brief/spec ties it to. Missing identifier in a bullet that explicitly names a sibling file → BLOCK.",
    '',
    'If validation passes, I record a fresh `## Verified sibling surface` section into spec.md so the audit is durable.',
    '',
    '### How to fix a block',
    '- If the identifier was a typo in the brief/spec: fix the spelling.',
    '- If the identifier really does need to exist on the sibling: STOP, escalate to the sibling owner, get them to ship the field. Do NOT silently expand sibling scope (ECHO-4579 lesson).',
    '- If the identifier is internal (NOT sibling-owned), put it in a bullet that does NOT name a sibling-owned file — that downgrades the check to a warning.',
    '',
    'Re-invoke me after fixing.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.surface_audit, {
    next: SPEC_PHASES.draft,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.auditArtifacts = auditArtifacts;
module.exports.extractBacktickIdentifiers = extractBacktickIdentifiers;
module.exports.normalizeIdentifier = normalizeIdentifier;
module.exports.listSurfaceFiles = listSurfaceFiles;
module.exports.renderVerifiedBlock = renderVerifiedBlock;
module.exports.upsertVerifiedSection = upsertVerifiedSection;
module.exports.DENY = DENY;
module.exports.VERIFIED_HEADER = VERIFIED_HEADER;
