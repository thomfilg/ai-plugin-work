'use strict';

/**
 * schema.js — load, validate, merge, and fingerprint env-config schemas.
 *
 * A config schema is a per-plugin JSON file (`config-schema.json` at the
 * plugin root) declaring every user-configurable environment variable the
 * plugin reads. The declarative table is the single source of truth for
 * startup validation, new-variable detection, and .envrc generation.
 *
 * Shape:
 * {
 *   "plugin": "<plugin name>",
 *   "prefixes": ["FOO_", ...],        // namespaces scanned for unknown keys
 *   "internal": ["FOO_RUNTIME_X"],    // known-but-not-user-facing vars
 *   "vars": {
 *     "FOO_BAR": {
 *       "type": "string|bool01|boolean|enum|number|path|json|command",
 *       "default": "",                // rendered as the commented default
 *       "description": "...",         // one-liner shown in prompts/.envrc
 *       "section": "Feature Flags",   // .envrc grouping header
 *       "values": ["a","b"],          // enum only
 *       "required": false,            // must be set for the plugin to work
 *       "advanced": false,            // documented but never prompted
 *       "example": "my-value"         // optional richer example
 *     }
 *   }
 * }
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VALID_TYPES = new Set([
  'string',
  'bool01',
  'boolean',
  'enum',
  'number',
  'path',
  'json',
  'command',
]);

const VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function fail(source, message) {
  throw new Error(`envConfig schema (${source}): ${message}`);
}

function requireNonEmptyString(value, source, message) {
  if (typeof value !== 'string' || !value) fail(source, message);
}

function validateVarType(name, def, source) {
  if (!VAR_NAME_RE.test(name)) fail(source, `invalid var name "${name}"`);
  if (!def || typeof def !== 'object') fail(source, `var "${name}" must be an object`);
  if (!VALID_TYPES.has(def.type)) fail(source, `var "${name}" has unknown type "${def.type}"`);
  if (def.type === 'enum' && (!Array.isArray(def.values) || def.values.length === 0)) {
    fail(source, `enum var "${name}" needs a non-empty "values" array`);
  }
}

function validateVarDef(name, def, source) {
  validateVarType(name, def, source);
  requireNonEmptyString(def.description, source, `var "${name}" needs a description`);
  requireNonEmptyString(def.section, source, `var "${name}" needs a section`);
}

function validateSchemaHeader(schema, source) {
  if (!schema || typeof schema !== 'object') fail(source, 'schema must be an object');
  requireNonEmptyString(schema.plugin, source, 'missing "plugin" name');
  if (!Array.isArray(schema.prefixes)) fail(source, 'missing "prefixes" array');
  if (schema.internal && !Array.isArray(schema.internal)) {
    fail(source, '"internal" must be an array when present');
  }
  if (!schema.vars || typeof schema.vars !== 'object') fail(source, 'missing "vars" object');
}

/** Validate a parsed schema object. Throws with a precise message on drift. */
function validateSchemaShape(schema, source = 'inline') {
  validateSchemaHeader(schema, source);
  for (const [name, def] of Object.entries(schema.vars)) {
    validateVarDef(name, def, source);
  }
  return schema;
}

/** Load and validate a single config-schema.json. Returns null when absent. */
function loadSchema(schemaPath) {
  if (!fs.existsSync(schemaPath)) return null;
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  return validateSchemaShape(schema, schemaPath);
}

/** Stable content hash of a schema (key-sorted) — the #70 drift fingerprint. */
function schemaHash(schema) {
  const canonical = JSON.stringify(schema, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Walk up from startDir to the nearest .claude-plugin/marketplace.json. */
function findMarketplaceRoot(startDir, maxDepth = 6) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Discover every sibling plugin schema declared by the marketplace manifest.
 * Plugin-agnostic: names come from marketplace.json, never hardcoded.
 */
function discoverSchemas(marketplaceRoot) {
  const manifestPath = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const schemas = [];
  for (const entry of manifest.plugins || []) {
    if (!entry || typeof entry.source !== 'string') continue;
    const schema = loadSchema(path.join(marketplaceRoot, entry.source, 'config-schema.json'));
    if (schema) schemas.push(schema);
  }
  return schemas;
}

/**
 * Merge schemas into one lookup: first declaration of a var wins.
 * Returns { plugins, prefixes, internal:Set, vars, varPlugin }.
 */
function mergeSchemas(schemas) {
  const merged = {
    plugins: [],
    prefixes: [],
    internal: new Set(),
    vars: {},
    varPlugin: {},
  };
  for (const schema of schemas) {
    merged.plugins.push(schema.plugin);
    for (const prefix of schema.prefixes) {
      if (!merged.prefixes.includes(prefix)) merged.prefixes.push(prefix);
    }
    for (const name of schema.internal || []) merged.internal.add(name);
    for (const [name, def] of Object.entries(schema.vars)) {
      if (merged.vars[name]) continue;
      merged.vars[name] = def;
      merged.varPlugin[name] = schema.plugin;
    }
  }
  return merged;
}

module.exports = {
  VALID_TYPES,
  loadSchema,
  validateSchemaShape,
  schemaHash,
  findMarketplaceRoot,
  discoverSchemas,
  mergeSchemas,
};
