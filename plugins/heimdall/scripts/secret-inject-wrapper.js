#!/usr/bin/env node
/*
 * secret-inject-wrapper.js — generic CLI command-injection wrapper for Heimdall.
 *
 * Runs as RUN_USER (the dedicated runner uid), exec'd by the setuid broker:
 *     mcp-pg-broker <name> [args...]   ->   node secret-inject-wrapper.js <name> [args...]
 *
 * It looks <name> up in a ROOT-OWNED commands map co-located with itself, reads
 * that entry's secrets file (which RUN_USER owns), and runs the entry's command
 * with the secret in its environment plus the forwarded args. The agent supplies
 * only <name> (broker allow-list-gated) and the run args; the COMMAND and the
 * SECRETS PATH come solely from the root-owned map, so the agent can neither pick
 * an arbitrary command nor point it at an arbitrary file. The command runs as
 * RUN_USER, so the agent uid cannot read its /proc/<pid>/environ either.
 *
 * SAFE-BY-OWNERSHIP: like the broker's broker.conf, the commands map is refused
 * unless it is owned by root and not group/world writable — otherwise the agent
 * could rewrite the command/secret mapping. (HEIMDALL_TEST_SKIP_OWNER_CHECK is
 * honored ONLY for unit tests against a tmp map; the installer never sets it.)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function die(msg, code = 1) {
  process.stderr.write(`secret-inject-wrapper: ${msg}\n`);
  process.exit(code);
}

// The commands map sits next to this wrapper (both installed root-owned in the
// per-repo broker dir). Overridable only for tests.
const MAP_PATH = process.env.HEIMDALL_COMMANDS_JSON || path.join(__dirname, 'commands.json');

function loadCommands() {
  let fd;
  try {
    fd = fs.openSync(MAP_PATH, 'r');
  } catch (err) {
    die(`cannot open commands map ${MAP_PATH}: ${err.message}`);
  }
  try {
    if (!process.env.HEIMDALL_TEST_SKIP_OWNER_CHECK) {
      const st = fs.fstatSync(fd);
      // Refuse a map that is not root-owned or is group/world writable — a
      // tampered map could redirect the command or the secrets path.
      if (st.uid !== 0 || st.mode & 0o022) {
        die(`commands map ${MAP_PATH} must be root-owned and not group/world writable`);
      }
    }
    const raw = fs.readFileSync(fd, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    die(`commands map ${MAP_PATH} unreadable/invalid: ${err.message}`);
  } finally {
    fs.closeSync(fd);
  }
}

// Strip one matching pair of surrounding single/double quotes, if present.
function unquote(v) {
  const q = v[0];
  if ((q === '"' || q === "'") && v.length >= 2 && v[v.length - 1] === q) {
    return v.slice(1, -1);
  }
  return v;
}

// Parse a shell-style secrets file (KEY=value / export KEY=value) into env vars.
// Not a shell: no expansion/command substitution, just literal assignments, so
// the agent-unreadable file's values land in the child env verbatim.
function parseSecrets(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    die(`cannot read secrets file ${file}: ${err.message}`);
  }
  const env = {};
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = unquote(line.slice(eq + 1).trim());
    }
  }
  return env;
}

function main() {
  const [name, ...args] = process.argv.slice(2);
  if (!name) die('usage: secret-inject-wrapper.js <name> [args...]', 2);

  const commands = loadCommands();
  const entry = commands[name];
  if (!entry || typeof entry !== 'object') die(`unknown command '${name}'`, 2);
  if (!entry.exec || !entry.secretsFile) {
    die(`commands map entry '${name}' missing exec/secretsFile`);
  }

  const secretEnv = parseSecrets(entry.secretsFile);
  // process.env is already the broker's sanitized env (PATH, HOME,
  // DOCKER_API_VERSION, HEIMDALL_CALLER_UID); layer the secret on top.
  const env = { ...process.env, ...secretEnv };

  const res = spawnSync(entry.exec, args, { stdio: 'inherit', env });
  if (res.error) die(`failed to run ${entry.exec}: ${res.error.message}`);
  if (typeof res.status === 'number') process.exit(res.status);
  // Killed by a signal — mirror the shell's 128+signal convention.
  process.exit(res.signal ? 128 : 1);
}

main();
