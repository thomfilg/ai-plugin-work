/**
 * Kind: backend — API / server work.
 *
 * Verifies:
 *  - Files to Create/Modify includes a backend file.
 *  - spec.md mentions a tRPC procedure / handler / route.
 *  - Test Scenarios reference an integration test.
 *  - `## Security Considerations` section is non-empty.
 */

'use strict';

const path = require('node:path');
const {
  readSpec,
  filesInFilesToModify,
  isBackendFile,
  sliceSection,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  const kinds = detectKinds(ctx.tasksDir);
  return kinds.includes('backend') || kinds.includes('fullstack');
}

function validate(ctx) {
  const spec = readSpec(ctx.tasksDir);
  const files = filesInFilesToModify(spec);
  const errors = [];
  const warnings = [];

  if (!files.some(isBackendFile)) {
    warnings.push(
      'backend kind detected but no backend file (`app/api/*`, `lib/*/schemas.ts`, `prisma/`, `server/`) is listed in `## Files to Create/Modify`.'
    );
  }

  if (!/(trpc|procedure|router|handler|route)/i.test(spec)) {
    warnings.push(
      'spec.md does not mention "tRPC", "procedure", "router", "handler", or "route" — verify the API surface is documented.'
    );
  }

  if (!/integration\s*test|\.integration\.test\.(ts|tsx|js|jsx)/i.test(spec)) {
    warnings.push(
      'spec.md does not mention an integration test — backend changes should ship with `*.integration.test.ts` coverage.'
    );
  }

  const sec = sliceSection(spec, /^##\s+Security Considerations(?=\s|$)/im);
  if (!sec || sec.trim().length < 20) {
    errors.push(
      '`## Security Considerations` section is missing or trivial (< 20 chars). Backend changes must explicitly document auth/authz/input-validation considerations.'
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${files.filter(isBackendFile).length} backend file(s) listed`,
  };
}

module.exports = function register(registerKind) {
  registerKind('backend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
