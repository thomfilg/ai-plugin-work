/**
 * Kind: fullstack — runs frontend + backend + cross-cut.
 *
 * The cross-cut check closes the ECHO-4579 loop end-to-end: every backend
 * field referenced by frontend bullets must appear in the
 * `## Verified sibling surface` section produced by `surface_audit`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const frontend = require('./frontend');
const backend = require('./backend');
const { readSpec, sliceSection, detectKinds } = require('./shared');

function appliesTo(ctx) {
  // Fullstack is a spec-time CROSS-CUT, not a per-task work-type. Gating it
  // on `### Type: fullstack` conflicts with the per-task model where authors
  // declare `frontend` + `backend` separately. Instead, fire when the
  // structural precondition for the cross-cut is present:
  //   1. explicit `### Type: fullstack` opt-in, OR
  //   2. tasks declare BOTH frontend AND backend kinds (full-stack ticket
  //      by composition), OR
  //   3. the spec references backend fields from a frontend bullet (the
  //      exact thing the cross-cut closes) — which is also the input
  //      `validate()` already reads.
  const kinds = detectKinds(ctx.tasksDir);
  if (kinds.includes('fullstack')) return true;
  if (kinds.includes('frontend') && kinds.includes('backend')) return true;
  return listFrontendBacktickIdentifiers(readSpec(ctx.tasksDir)).size > 0;
}

function listVerifiedIdentifiers(specText) {
  const block = sliceSection(specText, /^##\s+Verified sibling surface(?=\s|$)/im);
  if (!block) return new Set();
  const out = new Set();
  const re = /`([^`\n]+)::([^`\n]+)`/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    out.add(m[2].trim());
  }
  return out;
}

function listFrontendBacktickIdentifiers(specText) {
  // Heuristic: look in the spec section that lists frontend file bullets.
  // Easier: just look for backticked tokens immediately preceded by the
  // word "field" or "prop". This is loose on purpose — false negatives
  // (skip) are fine.
  const out = new Set();
  const re = /(?:field|prop|column|attribute)\s+`([^`\n]+)`/gi;
  let m;
  while ((m = re.exec(specText)) !== null) {
    const t = m[1].trim();
    // Strip dotted prefix — we want the leaf.
    const leaf = t.includes('.') ? t.split('.').pop() : t;
    if (leaf && /^[A-Za-z_$][\w$]*$/.test(leaf)) out.add(leaf);
  }
  return out;
}

function validate(ctx) {
  const frontVerdict = frontend.validate(ctx);
  const backVerdict = backend.validate(ctx);

  const spec = readSpec(ctx.tasksDir);
  const verified = listVerifiedIdentifiers(spec);
  const referenced = listFrontendBacktickIdentifiers(spec);
  const crossErrors = [];
  for (const id of referenced) {
    if (!verified.has(id)) {
      crossErrors.push(
        `Frontend bullet references field \`${id}\` but it is NOT in \`## Verified sibling surface\`. surface_audit either missed it or the field doesn't exist on the sibling.`
      );
    }
  }

  const errors = [...(frontVerdict.errors || []), ...(backVerdict.errors || []), ...crossErrors];
  const warnings = [...(frontVerdict.warnings || []), ...(backVerdict.warnings || [])];

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `frontend=${frontVerdict.ok ? 'ok' : 'fail'} backend=${backVerdict.ok ? 'ok' : 'fail'} cross-cut=${crossErrors.length ? 'fail' : 'ok'}`,
  };
}

module.exports = function register(registerKind) {
  registerKind('fullstack', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
module.exports.listVerifiedIdentifiers = listVerifiedIdentifiers;
module.exports.listFrontendBacktickIdentifiers = listFrontendBacktickIdentifiers;
