#!/usr/bin/env node
'use strict';

/**
 * stepScaffold CLI — generates a new /work step file from a factory template
 * and prints the registry edits required.
 *
 * Usage:
 *   node factories/stepScaffold/cli.js \
 *     --id=foo_gate \
 *     --kind=gate \
 *     --artifact=foo.md \
 *     --command=/foo-skill \
 *     --retry-to=foo \
 *     --out=plugins/work/scripts/workflows/work/steps/foo-gate.js
 *
 * --kind  = gate | artifact | transition
 * --id    = step id (snake_case, must be added to STEPS by hand)
 * --out   = destination file path (relative to cwd)
 * Other flags depend on the kind — see templates/*.template.js for the
 * tokens each template substitutes.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
    else if (arg.startsWith('--')) args[arg.slice(2)] = true;
  }
  return args;
}

function loadTemplate(kind) {
  // Templates are stored as `.template` (not `.template.js`) so static
  // analysis tools (CodeQL, ESLint, biome) don't try to parse the
  // unsubstituted `{{token}}` placeholders as JavaScript. The CLI
  // produces real `.js` files via `substitute()` and `writeFileSync`
  // — those ARE valid JS once tokens are resolved.
  const file = path.join(__dirname, 'templates', `${kind}.template`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `stepScaffold: unknown kind "${kind}". Valid: gate, artifact, transition, agent-invocation, plan-mutator`
    );
  }
  return fs.readFileSync(file, 'utf8');
}

function substitute(template, tokens) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in tokens)) throw new Error(`stepScaffold: missing token "${key}" in args`);
    return tokens[key];
  });
}

const TOKEN_BUILDERS = {
  gate: (base, args) => ({
    ...base,
    artifact: args.artifact || 'REPLACE_ME.md',
    precondition: args.precondition || `(s) => Boolean(s && s.has${capitalize(args.id || 'X')})`,
  }),
  artifact: (base, args) => ({
    ...base,
    artifact: args.artifact || 'REPLACE_ME.md',
    agentType: args['agent-type'] || 'skill',
  }),
};

function tokensForKind(kind, args) {
  const base = {
    id: args.id,
    command: args.command || '/REPLACE_ME',
    retryTo: args['retry-to'] || '',
  };
  const builder = TOKEN_BUILDERS[kind];
  return builder ? builder(base, args) : base;
}

function capitalize(s) {
  return String(s).replace(/(^|_)(.)/g, (_, __, c) => c.toUpperCase());
}

function emitRegistryHint(args) {
  const lines = [
    '',
    '── Registry edits (apply these by hand) ──',
    `  1. plugins/work/scripts/workflows/work/step-registry.js`,
    `       STEPS.${args.id} = '${args.id}'`,
    `       STEP_ORDER: insert '${args.id}' in canonical order`,
  ];
  if (args['retry-to']) {
    lines.push(`       RETRY_EDGES['${args.id}'] = ['${args['retry-to']}']`);
  }
  lines.push(`  2. plugins/work/scripts/workflows/work/steps/index.js`);
  lines.push(`       const ${camelize(args.id)} = require('./${kebabize(args.id)}');`);
  lines.push(`       STEP_PIPELINE: insert at the matching position`);
  return lines.join('\n');
}

function camelize(s) {
  return String(s).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function kebabize(s) {
  return String(s).replace(/_/g, '-');
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.id || !args.kind || !args.out) {
    process.stderr.write(
      'Usage: cli.js --id=<step_id> --kind=<gate|artifact|transition> --out=<path> [other flags]\n'
    );
    process.exit(2);
  }
  const tpl = loadTemplate(args.kind);
  const tokens = tokensForKind(args.kind, args);
  const body = substitute(tpl, tokens);

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Use the 'wx' flag so the existence check and the write are a single
  // atomic operation — fixes the TOCTOU race that `fs.existsSync` + a
  // separate `writeFileSync` would otherwise allow. When --force is set we
  // skip the exclusive flag (caller has explicitly opted into overwrite).
  try {
    fs.writeFileSync(outPath, body, { flag: args.force ? 'w' : 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      process.stderr.write(`Refusing to overwrite ${outPath} (pass --force to override)\n`);
      process.exit(3);
    }
    throw err;
  }
  process.stdout.write(`✓ wrote ${outPath}\n`);
  process.stdout.write(emitRegistryHint(args) + '\n');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseArgs, loadTemplate, substitute, tokensForKind, main };
