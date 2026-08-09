'use strict';

/**
 * git-identity-args.js — every way a git command can name its author.
 *
 * Git offers a surprising number of them, and each one is a place an AI
 * identity can enter a commit without touching stored config:
 *
 *   --author="Name <mail>"                   the author field, directly
 *   GIT_AUTHOR_NAME= / GIT_COMMITTER_EMAIL=  environment, per invocation
 *   git config user.name <value>             a write to stored config
 *   git -c user.name=<value>                 config override, per invocation
 *   GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n    config override, via environment
 *   git --config-env=user.name=VAR           config override, one indirection
 *
 * Only the third leaves a trace the effective-identity pass would ever find,
 * which is why every one of the others is read here instead.
 *
 * `--config-env` is the odd one out: the value lives in a named variable
 * rather than the command. When the command sets that variable itself the
 * value is resolved here; otherwise the REFERENCE is recorded and the guard
 * resolves it against its own environment. An override whose value nobody can
 * read is reported as unverifiable, never as clean.
 */

const { asText, longFlagValue } = require('./shell-tokenize');

const IDENTITY_ENV_RE = /^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)$/;
const GIT_CONFIG_KEY_RE = /^GIT_CONFIG_KEY_(\d+)$/;
const GIT_CONFIG_VALUE_RE = /^GIT_CONFIG_VALUE_(\d+)$/;
const CONFIG_IDENTITY_KEY_RE = /^user\.(?:name|email)$/i;
const INLINE_CONFIG_IDENTITY_RE = /^(user\.(?:name|email))=([\s\S]*)$/i;
/** `--config-env=user.name=VARNAME` — the value lives in the named variable. */
const CONFIG_ENV_IDENTITY_RE = /^(user\.(?:name|email))=([A-Za-z_][A-Za-z0-9_]*)$/i;
const AUTHOR_SPEC_RE = /^\s*(.*?)\s*<([^>]*)>\s*$/;

/** One identity entry, routed to `name` or `email` by the key it came from. */
function identityEntry(source, key, value) {
  const isEmail = key.toLowerCase().endsWith('email');
  return { source, name: isEmail ? '' : value, email: isEmail ? value : '' };
}

/** Split an `--author` spec ("Name <mail>") into an identity pair. */
function parseAuthorSpec(spec) {
  const match = AUTHOR_SPEC_RE.exec(asText(spec));
  if (!match) return { name: asText(spec).trim(), email: '' };
  return { name: match[1], email: match[2] };
}

/** Collect `GIT_AUTHOR_NAME=…` style identity assignments. */
function readEnvIdentities(env, out) {
  for (const entry of env) {
    if (!IDENTITY_ENV_RE.test(entry.name)) continue;
    out.identities.push(identityEntry(entry.name, entry.name, entry.value));
  }
}

/**
 * Collect `GIT_CONFIG_KEY_n=user.name GIT_CONFIG_VALUE_n=…` pairs — a config
 * override that never touches a config file, so neither the `git config`
 * surface nor the effective-identity pass would ever see it.
 */
function readGitConfigEnvIdentities(env, out) {
  const keys = new Map();
  const values = new Map();
  for (const entry of env) {
    const key = GIT_CONFIG_KEY_RE.exec(entry.name);
    if (key) keys.set(key[1], entry.value);
    const value = GIT_CONFIG_VALUE_RE.exec(entry.name);
    if (value) values.set(value[1], entry.value);
  }
  for (const [index, key] of keys) {
    const value = values.get(index);
    if (value === undefined || !CONFIG_IDENTITY_KEY_RE.test(key)) continue;
    out.identities.push(identityEntry(`GIT_CONFIG_KEY_${index}`, key, value));
  }
}

/** Collect the value of a `git config user.name|user.email <value>` write. */
function readConfigIdentity(argv, start, out) {
  for (let i = start; i < argv.length; i++) {
    if (!CONFIG_IDENTITY_KEY_RE.test(argv[i])) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) continue;
    out.identities.push(identityEntry(argv[i], argv[i], value));
  }
}

/**
 * Collect `git -c user.name=… commit …` overrides — a per-invocation identity
 * that never touches the stored config.
 */
function readInlineConfigIdentity(argv, end, out) {
  for (let i = 0; i < end; i++) {
    if (argv[i] !== '-c') continue;
    const match = INLINE_CONFIG_IDENTITY_RE.exec(argv[i + 1] || '');
    if (match) out.identities.push(identityEntry(`-c ${match[1]}`, match[1], match[2]));
  }
}

/**
 * Collect `git --config-env=user.name=VARNAME commit …` overrides, resolving
 * the named variable from the command's own assignments when it sets one and
 * recording the reference otherwise.
 */
function readConfigEnvIdentity(argv, end, env, out) {
  for (let i = 0; i < end; i++) {
    const spec = longFlagValue(argv, i, '--config-env');
    if (spec === null) continue;
    const match = CONFIG_ENV_IDENTITY_RE.exec(spec);
    if (!match) continue;
    const [, key, varName] = match;
    const inline = env.find((entry) => entry.name === varName);
    const source = `--config-env ${key}`;
    out.identities.push(
      inline ? identityEntry(source, key, inline.value) : { source, key, envVar: varName }
    );
  }
}

/**
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` point git at DIFFERENT config
 * files. The identity in them is the one git will use, so the guard has to
 * read the same files rather than the ones it would find on its own.
 */
const CONFIG_SOURCE_ENV_RE = /^GIT_CONFIG_(?:GLOBAL|SYSTEM)$/;

function readConfigSources(env) {
  const sources = {};
  for (const entry of env) {
    if (CONFIG_SOURCE_ENV_RE.test(entry.name)) sources[entry.name] = entry.value;
  }
  return sources;
}

/** Every identity a command names, collected onto `out.identities`. */
function readIdentities(argv, subcommandIndex, env, out) {
  readEnvIdentities(env, out);
  readGitConfigEnvIdentities(env, out);
  readInlineConfigIdentity(argv, subcommandIndex, out);
  readConfigEnvIdentity(argv, subcommandIndex, env, out);
}

module.exports = {
  identityEntry,
  readConfigSources,
  parseAuthorSpec,
  readIdentities,
  readConfigIdentity,
  readEnvIdentities,
  readGitConfigEnvIdentities,
  readInlineConfigIdentity,
  readConfigEnvIdentity,
};
