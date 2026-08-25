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
 *      identifier from the doc's CLAIM regions. Evidence prose — the
 *      `## Open Questions` section and any `Searched:` annotation — is not a
 *      claim about a sibling surface and is skipped (see `stripEvidenceProse`).
 *      Filter out built-in noise (`string`, `null`, etc.).
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
const {
  DENY,
  stripEvidenceProse,
  extractBacktickIdentifiers,
  normalizeIdentifier,
  lineRefersToFile,
} = require('../surface-tokens');

const VERIFIED_HEADER = '## Verified sibling surface';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** The `{siblingId, file}` pairs one related-ticket entry contributes. */
function surfacesOf(sib) {
  if (!sib || !sib.id) return [];
  const surfaces = Array.isArray(sib.surfaces) ? sib.surfaces : [];
  return surfaces
    .filter((f) => typeof f === 'string' && f)
    .map((f) => ({ siblingId: sib.id, file: f }));
}

function listSurfaceFiles(manifest) {
  if (!manifest) return [];
  const out = [];
  for (const key of ['siblings', 'blockedBy', 'dependsOn', 'relatedTo', 'parent']) {
    const arr = key === 'parent' ? [manifest.parent].filter(Boolean) : manifest[key] || [];
    for (const sib of arr) out.push(...surfacesOf(sib));
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

/**
 * Resolve a sibling surface file against the caller-supplied worktree root.
 *
 * Two climbed candidates used to be tried as well, `<tasksDir>/../..` and
 * `<tasksDir>/..`, on the assumption that tasks live under `<worktree>/tasks`.
 * TASKS_BASE is configured independently (#791), so those resolve to the parent
 * of TASKS_BASE and its grandparent — arbitrary directories that happen to
 * exist. A surface file "found" under one of them is a false positive, which is
 * worse here than finding nothing.
 */
function makeSurfaceResolver(manifest) {
  const roots =
    manifest.worktreeRoot && typeof manifest.worktreeRoot === 'string'
      ? [manifest.worktreeRoot]
      : [];
  return function resolveSurfacePath(file) {
    for (const root of roots) {
      const p = path.resolve(root, file);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
}

/** The surface file that defines `id`, or null when none of them does. */
function findDefiningSurface(id, surfaceFiles, resolveSurfacePath) {
  for (const sf of surfaceFiles) {
    const abs = resolveSurfacePath(sf.file);
    if (!abs) continue;
    if (fileContainsIdentifier(abs, id)) {
      return { file: sf.file, identifier: id, siblingId: sf.siblingId };
    }
  }
  return null;
}

/**
 * Record an identifier no surface file defines.
 *
 * ERROR when the wrapping line explicitly names a sibling-owned file (the
 * brief/spec tied the identifier to that file and the file does not define it);
 * WARNING otherwise, since it probably was never meant to come from a sibling.
 */
function recordUnresolved(t, id, surfaceFiles, errors, warnings) {
  const lineRefersToSurface = surfaceFiles.find((sf) => lineRefersToFile(t.lineText, sf.file));
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

/** Every backticked identifier in brief + spec, tagged with its source doc. */
function candidateTokens(brief, spec) {
  return [
    ...extractBacktickIdentifiers(stripEvidenceProse(brief)).map((t) => ({
      ...t,
      source: 'brief',
    })),
    ...extractBacktickIdentifiers(stripEvidenceProse(spec || '')).map((t) => ({
      ...t,
      source: 'spec',
    })),
  ];
}

function auditArtifacts(tasksDir, manifest) {
  const briefPath = path.join(tasksDir, 'brief.md');
  const brief = readFile(briefPath);
  const spec = readFile(path.join(tasksDir, 'spec.md'));
  const errors = [];
  const warnings = [];
  const verified = [];

  if (!brief) {
    errors.push(`Missing ${briefPath}.`);
    return { errors, warnings, verified };
  }

  const surfaceFiles = listSurfaceFiles(manifest);
  if (surfaceFiles.length === 0) {
    return {
      errors,
      warnings,
      verified,
      summary: 'no sibling-owned surfaces — nothing to verify',
    };
  }

  auditTokens(candidateTokens(brief, spec), {
    surfaceFiles,
    resolveSurfacePath: makeSurfaceResolver(manifest),
    errors,
    warnings,
    verified,
  });

  return { errors, warnings, verified };
}

/** Every normalized identifier in `tokens`, classified as verified/error/warning. */
function auditTokens(tokens, sink) {
  const { surfaceFiles, resolveSurfacePath, errors, warnings, verified } = sink;
  for (const t of tokens) {
    const norm = normalizeIdentifier(t.token);
    if (norm == null) continue;
    for (const id of Array.isArray(norm) ? norm : [norm]) {
      const hit = findDefiningSurface(id, surfaceFiles, resolveSurfacePath);
      if (!hit) {
        recordUnresolved(t, id, surfaceFiles, errors, warnings);
      } else if (!verified.some((v) => v.file === hit.file && v.identifier === hit.identifier)) {
        verified.push(hit); // dedupe
      }
    }
  }
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
module.exports.stripEvidenceProse = stripEvidenceProse;
module.exports.lineRefersToFile = lineRefersToFile;
module.exports.normalizeIdentifier = normalizeIdentifier;
module.exports.listSurfaceFiles = listSurfaceFiles;
module.exports.renderVerifiedBlock = renderVerifiedBlock;
module.exports.upsertVerifiedSection = upsertVerifiedSection;
module.exports.DENY = DENY;
module.exports.VERIFIED_HEADER = VERIFIED_HEADER;
