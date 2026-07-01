#!/usr/bin/env node
/**
 * heimdall-conceal-status — report the secrets-safe posture for a project.
 * Usage: node heimdall-conceal-status.js [repo-dir]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// First non-flag arg is the repo dir; flags like --reminder are filtered out so
// `node status.js --reminder` doesn't mistake the flag for a path.
const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const startDir = path.resolve(posArgs[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd());

// Resolve uid/gid → name from /etc/passwd /etc/group (plain file reads). We
// deliberately avoid spawning `stat`/`id`: passing env/argv-derived paths to a
// subprocess is what CodeQL flags (shell- and indirect-command-line-injection),
// and fs.statSync already carries the numeric owner + mode.
function buildIdMap(file, idCol, nameCol) {
  const m = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const f = line.split(':');
      if (f.length > idCol) m.set(Number(f[idCol]), f[nameCol]);
    }
  } catch {
    /* best-effort: fall back to numeric ids */
  }
  return m;
}
const UID_NAMES = buildIdMap('/etc/passwd', 2, 0);
const GID_NAMES = buildIdMap('/etc/group', 2, 0);
const uname = (uid) => UID_NAMES.get(uid) || String(uid);
const gname = (gid) => GID_NAMES.get(gid) || String(gid);

function stat(p) {
  if (!p) return 'n/a';
  try {
    const s = fs.statSync(p);
    const mode = (s.mode & 0o777).toString(8).padStart(3, '0');
    return `${uname(s.uid)}:${gname(s.gid)} ${mode}${s.isDirectory() ? ' (dir)' : ''}`;
  } catch {
    return 'MISSING';
  }
}

// Per-path broker default — MUST match setup-secrets-heimdall.sh (basename +
// short hash of the absolute config-dir path) so the audit reports the same
// broker path the installer uses.
function brokerDefaultFor(base) {
  const slug =
    path.basename(base).replace(/[^A-Za-z0-9._-]/g, '_') +
    '-' +
    crypto.createHash('sha256').update(base).digest('hex').slice(0, 8);
  return `/usr/local/lib/mcp-broker/${slug}/mcp-pg-broker`;
}

// Read one config file: { state: 'absent'|'ok'|'unreadable'|'invalid', cfg?, error? }.
function readConfigAt(cfgPath) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unreadable', error: err.message };
  }
  try {
    return { state: 'ok', cfg: JSON.parse(raw) };
  } catch (err) {
    return { state: 'invalid', error: err.message };
  }
}

// Walk UP from startDir collecting EVERY conceal config, bounded at $HOME
// (matches the hook: merges all ancestors, fails closed on any broken one, and
// never climbs above $HOME). Returns { state, configs?, baseDir?, cfgPath?, error? }:
//   absent      — no config at or above startDir (up to $HOME)
//   unreadable  — a present config could not be read   (hook fails closed)
//   invalid     — a present config is not valid JSON   (hook fails closed)
//   ok          — configs[] (nearest-first) with their dirs + the nearest baseDir
function collectConfigs(start) {
  const home = os.homedir();
  let dir = path.resolve(start);
  const configs = [];
  for (;;) {
    const cfgPath = path.join(dir, '.claude', 'heimdall-conceal.json');
    const r = readConfigAt(cfgPath);
    if (r.state === 'unreadable' || r.state === 'invalid') {
      return { state: r.state, cfgPath, error: r.error };
    }
    if (r.state === 'ok') configs.push({ dir, cfg: r.cfg });
    if (dir === home) break; // bounded at $HOME, matching the hook
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (configs.length === 0) return { state: 'absent' };
  return { state: 'ok', configs, baseDir: configs[0].dir };
}

const absUnder = (dir, p) => (path.isAbsolute(p) ? p : path.join(dir, p));
// Take the first (nearest) defined value for a scalar field.
function pick(out, key, value) {
  if (out[key] === undefined && value) out[key] = value;
}

// Merge collected configs into one audit view. secretsFiles/wrapper/mcpJson are
// resolved to ABSOLUTE paths against the dir of the config they came from (so an
// ancestor's relative path isn't mis-resolved); scalar fields take the nearest
// defined value.
function mergeOne(out, dir, cfg) {
  for (const f of cfg.secretsFiles || []) out.secretsFiles.push(absUnder(dir, f));
  // CLI consumers (injectCommands) lock their own secretsFile — count those too,
  // else an inject-only repo audits as "conceal-only" and hides the real secret.
  for (const c of cfg.injectCommands || []) {
    if (c && c.secretsFile) out.secretsFiles.push(absUnder(dir, c.secretsFile));
  }
  pick(out, 'wrapper', cfg.wrapper && absUnder(dir, cfg.wrapper));
  pick(out, 'mcpJson', cfg.mcpJson && absUnder(dir, cfg.mcpJson));
  pick(out, 'brokerPath', cfg.brokerPath);
  pick(out, 'runnerUser', cfg.runnerUser);
}

function mergeForAudit(configs) {
  const out = { secretsFiles: [] };
  for (const c of configs) mergeOne(out, c.dir, c.cfg);
  // The broker slug is derived (by setup-secrets-heimdall.sh) from the dir of
  // the config that actually defines the secrets boundary — NOT necessarily the
  // nearest config. Use that dir so the audit reports the broker path harden
  // installed, even when run from a subdirectory under a guard-only config.
  const sb = configs.find(
    (c) =>
      (c.cfg.secretsFiles || []).length ||
      (c.cfg.injectCommands || []).length ||
      c.cfg.wrapper ||
      c.cfg.brokerPath
  );
  out.secretsBase = sb ? sb.dir : undefined;
  return out;
}

// This script runs AS the agent uid, so a direct read check is the decisive
// test of whether the agent can read the secrets — no `sudo` subprocess needed.
function canAgentRead(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function reportSecretsFiles(secretsFiles) {
  console.log('Secrets files:');
  let protectedCount = 0;
  for (const p of secretsFiles) {
    // A MISSING file also fails the read check, but it is not a locked
    // credential — it must NOT count toward "boundary active".
    const present = fs.existsSync(p);
    const exposed = present && canAgentRead(p);
    if (present && !exposed) protectedCount++;
    const note = !present ? 'MISSING (not locked)' : exposed ? 'YES (exposed!)' : 'denied';
    console.log(`  ${p}  [${stat(p)}]  agent-read: ${note}`);
  }
  return protectedCount;
}

// Escalation check (runs AS the agent uid): a file-ownership boundary is void if
// the agent can become root. The dominant non-interactive path is a ROOTFUL
// docker socket reachable via the 'docker' group. We detect it WITHOUT spawning
// docker (CodeQL-safe): agent is in the docker group AND the system socket is
// accessible. A rootless socket lives under /run/user/<uid>/ and is not flagged.
// Passwordless sudo can't be probed from here without spawning sudo, so it's
// left to the installer's gate; we note it.
function dockerGid() {
  try {
    for (const line of fs.readFileSync('/etc/group', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] === 'docker' && f.length > 2) return Number(f[2]);
    }
  } catch {
    /* no /etc/group → treat as no docker group */
  }
  return null;
}

function agentDockerBypass() {
  const gid = dockerGid();
  if (gid === null) return false;
  let groups = [];
  try {
    groups = process.getgroups();
  } catch {
    return false;
  }
  if (!groups.includes(gid)) return false;
  // In the docker group — is the ROOTFUL system socket actually reachable?
  try {
    fs.accessSync('/var/run/docker.sock', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function reportEscalation() {
  const bypass = agentDockerBypass();
  if (bypass) {
    console.log(
      "Escalation:  BYPASSABLE — agent is in the 'docker' group with a reachable rootful socket (root-equivalent)."
    );
    console.log(
      '             Fix: sudo bash setup-rootless-docker.sh <you> + dockerd-rootless-setuptool.sh install + wsl --shutdown.'
    );
  } else {
    console.log(
      'Escalation:  no docker-group bypass (sudo password requirement checked by the installer).'
    );
  }
  return bypass;
}

function reportMcpWiring(mcpJson, broker) {
  if (!mcpJson) {
    console.log('.mcp.json:   not configured');
    return;
  }
  try {
    const mcp = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
    const viaBroker = Object.values(mcp.mcpServers || {}).filter(
      (s) => s.command === broker
    ).length;
    console.log(`.mcp.json:   ${viaBroker} server(s) route through the broker`);
  } catch {
    console.log('.mcp.json:   not found');
  }
}

// Non-printing count of locked (present + agent-denied) secrets files — used by
// the reminder path, which must compute the verdict without emitting the report.
function countProtected(secretsFiles) {
  let n = 0;
  for (const p of secretsFiles) {
    if (fs.existsSync(p) && !canAgentRead(p)) n++;
  }
  return n;
}

// Case-specific reminder text (SessionStart hook). null = nothing to nag about.
// Critically, it names the ACTUAL remaining step: "install not run" vs "installed
// but docker bypass still open" point at different fixes.
function buildReminder(total, protectedCount, bypassable) {
  if (total === 0) return null; // no secrets configured
  if (protectedCount < total) {
    return (
      '⚠️  HEIMDALL: a secret here is NOT PROTECTED — the LLM/agent can read it. ' +
      'The privileged OS install has not been run.\n' +
      '   Fix: /heimdall:harden (one sudo). This repeats every session until done.'
    );
  }
  if (bypassable) {
    return (
      '⚠️  HEIMDALL: the secret file IS locked, but the rootful-docker bypass is OPEN — ' +
      'the LLM/agent can still read it via `docker run -v /:/host`.\n' +
      '   Fix (NOT a re-install): sudo bash setup-rootless-docker.sh <you> + ' +
      'dockerd-rootless-setuptool.sh install + wsl --shutdown.\n' +
      '   This repeats every session until docker can no longer reach the secret.'
    );
  }
  return null; // protected, no docker bypass
}

// SessionStart reminder path: silent unless a configured secret is reachable.
function runReminder(found) {
  if (found.state !== 'ok') {
    process.exitCode = 0;
    return;
  }
  const m = mergeForAudit(found.configs);
  const total = m.secretsFiles.length;
  const text = buildReminder(total, countProtected(m.secretsFiles), agentDockerBypass());
  if (text) {
    console.log(text);
    process.exitCode = 2;
  } else {
    process.exitCode = 0;
  }
}

function main() {
  const found = collectConfigs(startDir);
  if (process.argv.includes('--reminder')) {
    runReminder(found);
    return;
  }
  if (found.state === 'absent') {
    console.log(`heimdall: no config at or above ${startDir} → guard inactive for this project.`);
    process.exit(0);
  }
  if (found.state !== 'ok') {
    console.log(
      `heimdall: config at ${found.cfgPath} is present but ${found.state} (${found.error}).`
    );
    console.log(
      'STATUS: the PreToolUse conceal guard is FAILING CLOSED — it blocks all tool calls until this config is fixed.'
    );
    process.exit(1);
  }

  const base = found.baseDir; // nearest config dir — broker slug + display root
  const m = mergeForAudit(found.configs);

  // The user running this audit IS the agent uid (that's whose read access we
  // test below), so report it directly rather than shelling out.
  console.log(`Repo:        ${base}`);
  console.log(`Agent uid:   ${os.userInfo().username}`);
  console.log(`Runner:      ${m.runnerUser || 'mcp-runner'}`);
  console.log(`Configs:     ${found.configs.length} (merged, nearest-first)`);
  console.log('');

  const protectedCount = reportSecretsFiles(m.secretsFiles);
  console.log('');
  console.log(`Wrapper:     ${m.wrapper || '(none)'}  [${stat(m.wrapper)}]`);
  const broker = m.brokerPath || brokerDefaultFor(m.secretsBase || base);
  const brokerConf = path.join(path.dirname(broker), 'broker.conf');
  console.log(`Broker:      ${broker}  [${stat(broker)}]`);
  console.log(`Broker conf: ${brokerConf}  [${stat(brokerConf)}]`);

  reportMcpWiring(m.mcpJson, broker);
  const bypassable = reportEscalation();

  console.log('');
  reportStatus(m.secretsFiles.length, protectedCount, bypassable);
}

// Final verdict + exit code. Exit codes let the install/harden flow GATE on real
// protection rather than trusting the user ran the privileged step: 0 = protected
// (or n/a), 2 = secrets are reachable by the agent/LLM (NOT protected).
function reportStatus(total, protectedCount, bypassable) {
  if (total === 0) {
    // Conceal-only: hook-level deny patterns, no MCP secrets to lock.
    console.log(
      'STATUS: conceal-only — hook-level deny patterns active; no secretsFiles configured, so /heimdall:harden does not apply.'
    );
    process.exitCode = 0;
    return;
  }
  if (protectedCount === total && !bypassable) {
    console.log(
      'STATUS: PROTECTED — the agent/LLM is denied on all secrets files, with no rootful-docker escalation path.'
    );
    process.exitCode = 0;
    return;
  }
  if (protectedCount === total && bypassable) {
    console.log(
      'STATUS: NOT PROTECTED (BYPASSABLE) — the OS install IS done (files locked, broker installed), but the agent/LLM can still become root via the rootful docker socket and read them.'
    );
    console.log(
      '        Close the docker path: sudo bash setup-rootless-docker.sh <you> + dockerd-rootless-setuptool.sh install + wsl --shutdown. (No need to re-run the secrets install.)'
    );
    process.exitCode = 2;
    return;
  }
  console.log(
    'STATUS: NOT PROTECTED — the agent/LLM CAN READ these secrets right now. The privileged OS install has NOT been run,'
  );
  console.log(
    '        so Heimdall is doing NOTHING to block reads. You MUST run /heimdall:harden and authenticate (sudo) for this to work.'
  );
  process.exitCode = 2;
}

main();
