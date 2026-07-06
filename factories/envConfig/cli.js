#!/usr/bin/env node
'use strict';

/**
 * cli.js — configure-flow backend for the per-plugin /…:configure skills.
 *
 * Commands (all print JSON unless noted):
 *   plan     --plugin-root <dir> [--all] [--cwd <dir>]
 *            Inventory for the interactive setup: every declared var with
 *            its current value/source, gh accounts, git identity, and the
 *            suggested .envrc path.
 *   write    --plugin-root <dir> [--all] --answers <file.json>
 *            Apply answers: render/merge the chosen target file and
 *            acknowledge the schema hash in the detection cache.
 *   validate --plugin-root <dir> [--all]
 *            Print startup-style warnings (text, exit 0 always).
 *
 * The skill collects answers via AskUserQuestion; this CLI stays
 * non-interactive so it is scriptable and testable.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  loadSchema,
  mergeSchemas,
  schemaHash,
  findMarketplaceRoot,
  discoverSchemas,
} = require('./schema');
const { readValues } = require('./envFiles');
const { detect, projectKey, markConfigured } = require('./detect');
const { findUnknownKeys, validateValues } = require('./validate');
const { renderEnvrc, mergeEnvContent } = require('./render');
const { defaultCachePath } = require('./sessionHook');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function resolveSchemas(pluginRoot, all) {
  const own = loadSchema(path.join(pluginRoot, 'config-schema.json'));
  if (!own) throw new Error(`no config-schema.json under ${pluginRoot}`);
  if (!all) return [own];
  const marketplaceRoot = findMarketplaceRoot(pluginRoot);
  if (!marketplaceRoot) return [own];
  const schemas = discoverSchemas(marketplaceRoot);
  // Own plugin first so its sections lead the rendered .envrc.
  schemas.sort((a, b) => (a.plugin === own.plugin ? -1 : b.plugin === own.plugin ? 1 : 0));
  return schemas;
}

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

/** Parse `gh auth status` for logged-in account names (all hosts). */
function ghAccounts() {
  const output = tryExec('gh', ['auth', 'status']);
  const accounts = [];
  for (const match of output.matchAll(/account\s+(\S+)/g)) {
    if (!accounts.includes(match[1])) accounts.push(match[1]);
  }
  return accounts;
}

function gitIdentity(cwd) {
  return {
    name: tryExec('git', ['-C', cwd, 'config', 'user.name']),
    email: tryExec('git', ['-C', cwd, 'config', 'user.email']),
  };
}

function varInventory(schemas, values) {
  const vars = [];
  for (const schema of schemas) {
    for (const [name, def] of Object.entries(schema.vars)) {
      const current = values[name];
      vars.push({
        name,
        plugin: schema.plugin,
        section: def.section,
        type: def.type,
        description: def.description,
        default: def.default ?? '',
        example: def.example ?? '',
        values: def.values ?? null,
        required: Boolean(def.required),
        advanced: Boolean(def.advanced),
        current: current ? current.value : null,
        source: current ? current.source : null,
      });
    }
  }
  return vars;
}

function cmdPlan(args) {
  const cwd = args.cwd || process.cwd();
  const schemas = resolveSchemas(path.resolve(args['plugin-root']), Boolean(args.all));
  const { values, files } = readValues({ cwd });
  const projectRoot = projectKey(cwd);
  const suggestedEnvrcPath = files.envrc || path.join(path.dirname(projectRoot), '.envrc');
  const plan = {
    plugins: schemas.map((s) => s.plugin),
    projectRoot,
    files,
    suggestedEnvrcPath,
    ghAccounts: ghAccounts(),
    gitIdentity: gitIdentity(cwd),
    vars: varInventory(schemas, values),
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backup = `${filePath}.bak-${Date.now()}`;
  fs.copyFileSync(filePath, backup);
  return backup;
}

function writeEnvrcTarget(answers, schemas, values) {
  const target = answers.envrcPath;
  if (!target) throw new Error('answers.envrcPath is required for target "envrc"');
  const exists = fs.existsSync(target);
  const backup = backupIfExists(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (exists && !answers.regenerate) {
    // Preserve hand-edited content (dynamic values, comments): merge exports.
    const existing = fs.readFileSync(`${backup}`, 'utf8');
    fs.writeFileSync(target, mergeEnvContent(existing, values, { exportPrefix: true }));
    return { written: target, backup, mode: 'merge' };
  }
  fs.writeFileSync(
    target,
    renderEnvrc({ ghUser: answers.ghUser, gitIdentity: answers.gitIdentity, schemas, values })
  );
  return { written: target, backup, mode: 'render' };
}

function writeTarget(answers, schemas) {
  const values = answers.values || {};
  if (answers.target === 'envrc') return writeEnvrcTarget(answers, schemas, values);
  const target = answers.envPath;
  if (!target) throw new Error('answers.envPath is required for env targets');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, mergeEnvContent(existing, values));
  return { written: target, backup: null, mode: 'merge' };
}

function acknowledge(answers, schemas, cachePath, projectRoot) {
  const touched = new Set([...Object.keys(answers.values || {}), ...(answers.acknowledged || [])]);
  for (const schema of schemas) {
    markConfigured({
      cachePath,
      projectRoot,
      plugin: schema.plugin,
      hash: schemaHash(schema),
      acknowledgedVars: [...touched].filter((name) => name in schema.vars),
    });
  }
}

function cmdWrite(args) {
  const schemas = resolveSchemas(path.resolve(args['plugin-root']), Boolean(args.all));
  const answers = JSON.parse(fs.readFileSync(args.answers, 'utf8'));
  const cwd = args.cwd || process.cwd();
  const result = writeTarget(answers, schemas);
  const cachePath = args.cache || defaultCachePath();
  acknowledge(answers, schemas, cachePath, projectKey(cwd));
  process.stdout.write(`${JSON.stringify({ ...result, cacheUpdated: true }, null, 2)}\n`);
}

function cmdValidate(args) {
  const cwd = args.cwd || process.cwd();
  const schemas = resolveSchemas(path.resolve(args['plugin-root']), Boolean(args.all));
  const merged = mergeSchemas(schemas);
  const { values } = readValues({ cwd });
  const lines = [];
  for (const unknown of findUnknownKeys(merged, values)) {
    const hint = unknown.suggestion ? ` — did you mean ${unknown.suggestion}?` : '';
    lines.push(`⚠ unknown config var ${unknown.name}${hint}`);
  }
  for (const bad of validateValues(merged, values)) {
    lines.push(`⚠ ${bad.name}=${bad.value} is invalid — expected ${bad.expected}`);
  }
  process.stdout.write(lines.length ? `${lines.join('\n')}\n` : 'config OK — no warnings\n');
}

function cmdDetect(args) {
  const cwd = args.cwd || process.cwd();
  const pluginRoot = path.resolve(args['plugin-root']);
  const schema = loadSchema(path.join(pluginRoot, 'config-schema.json'));
  if (!schema) throw new Error(`no config-schema.json under ${pluginRoot}`);
  const { values } = readValues({ cwd });
  const result = detect({
    schema,
    cachePath: args.cache || defaultCachePath(),
    projectRoot: projectKey(cwd),
    values,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const COMMANDS = { plan: cmdPlan, write: cmdWrite, validate: cmdValidate, detect: cmdDetect };

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args._[0]];
  if (!command || !args['plugin-root']) {
    process.stderr.write(
      'usage: cli.js <plan|write|validate|detect> --plugin-root <dir> [--all] [--answers <file>] [--cwd <dir>]\n'
    );
    process.exit(1);
  }
  try {
    command(args);
  } catch (err) {
    process.stderr.write(`envConfig: ${err.message}\n`);
    process.exit(1);
  }
}

/** One-line per-plugin entrypoint: scriptDir is the plugin's scripts/ dir. */
function mainFor(scriptDir) {
  if (!process.argv.includes('--plugin-root')) {
    process.argv.push('--plugin-root', path.join(scriptDir, '..'));
  }
  main();
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  resolveSchemas,
  ghAccounts,
  varInventory,
  writeTarget,
  main,
  mainFor,
};
