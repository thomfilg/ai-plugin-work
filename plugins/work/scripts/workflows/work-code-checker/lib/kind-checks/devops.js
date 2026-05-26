/**
 * Kind: devops — code-quality check for infra / CI yaml + shell scripts.
 *
 * Flags:
 *  - Shell scripts without `set -euo pipefail`.
 *  - YAML workflows with `run:` blocks > 30 lines (extract a script).
 *  - Any app-source file in the diff (devops should not touch app code).
 */

'use strict';

const {
  readChangedFiles,
  readFileFromWorktree,
  isDevopsFile,
  isAppSourceFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('devops');
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const devopsFiles = changed.filter(isDevopsFile);
  const errors = [];
  const warnings = [];

  const appDrift = changed.filter(isAppSourceFile);
  if (appDrift.length) {
    errors.push(
      `DevOps kind but diff contains app-source files: ${appDrift
        .map((f) => `\`${f}\``)
        .join(', ')}. Cross-kind escape — split the change.`
    );
  }

  const unsafeShells = [];
  for (const f of devopsFiles) {
    if (!/\.(sh|bash)$/.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    if (!/set\s+-[eu]/i.test(text)) unsafeShells.push(f);
  }
  if (unsafeShells.length) {
    warnings.push(
      `Shell script(s) missing \`set -euo pipefail\`: ${unsafeShells
        .map((f) => `\`${f}\``)
        .join(', ')}.`
    );
  }

  const longInlineYaml = [];
  for (const f of devopsFiles) {
    if (!/\.(yml|yaml)$/.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    // Crude: count consecutive script lines after `run: |`.
    const re = /run:\s*\|\s*\n([\s\S]*?)(?=\n\s*[a-zA-Z_-]+:|\n[a-zA-Z_-]+:|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1].split('\n').length > 30) longInlineYaml.push(f);
    }
  }
  if (longInlineYaml.length) {
    warnings.push(
      `Long inline \`run:\` block (>30 lines) in: ${[...new Set(longInlineYaml)]
        .map((f) => `\`${f}\``)
        .join(', ')}. Extract to a script file.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${devopsFiles.length} infra file(s), ${appDrift.length} app-drift, ${unsafeShells.length} unsafe-shells`,
  };
}

module.exports = function register(registerKind) {
  registerKind('devops', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
