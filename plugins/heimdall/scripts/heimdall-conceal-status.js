#!/usr/bin/env node
/**
 * heimdall-conceal-status — report the secrets-safe posture for a project.
 * Usage: node heimdall-conceal-status.js [repo-dir]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const startDir = path.resolve(process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd());

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
    crypto.createHash('sha1').update(base).digest('hex').slice(0, 8);
  return `/usr/local/lib/mcp-broker/${slug}/mcp-pg-broker`;
}

// Find the conceal config by walking UP from startDir to the nearest ancestor
// carrying .claude/heimdall-conceal.json — mirrors the PreToolUse hook, so an
// audit run from a subdirectory reports the SAME active/inactive state the hook
// enforces. Distinguishes absent (genuinely inactive) from present-but-broken
// (the hook fails closed → must not be reported "inactive").
function findConfig(start) {
  let dir = path.resolve(start);
  for (;;) {
    const cfgPath = path.join(dir, '.claude', 'heimdall-conceal.json');
    let raw;
    try {
      raw = fs.readFileSync(cfgPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') return { state: 'unreadable', cfgPath, error: err.message };
      const parent = path.dirname(dir);
      if (parent === dir)
        return {
          state: 'absent',
          cfgPath: path.join(path.resolve(start), '.claude', 'heimdall-conceal.json'),
        };
      dir = parent;
      continue;
    }
    try {
      return { state: 'ok', dir, cfgPath, cfg: JSON.parse(raw) };
    } catch (err) {
      return { state: 'invalid', cfgPath, error: err.message };
    }
  }
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

function reportSecretsFiles(cfg, abs) {
  console.log('Secrets files:');
  let protectedCount = 0;
  const files = cfg.secretsFiles || [];
  for (const f of files) {
    const p = abs(f);
    // A MISSING file also fails the read check, but it is not a locked
    // credential — it must NOT count toward "boundary active".
    const present = fs.existsSync(p);
    const exposed = present && canAgentRead(p);
    if (present && !exposed) protectedCount++;
    const note = !present ? 'MISSING (not locked)' : exposed ? 'YES (exposed!)' : 'denied';
    console.log(`  ${f}  [${stat(p)}]  agent-read: ${note}`);
  }
  return { files, protectedCount };
}

function reportMcpWiring(cfg, abs, broker) {
  try {
    const mcp = JSON.parse(fs.readFileSync(abs(cfg.mcpJson || '.mcp.json'), 'utf8'));
    const viaBroker = Object.values(mcp.mcpServers || {}).filter(
      (s) => s.command === broker
    ).length;
    console.log(`.mcp.json:   ${viaBroker} server(s) route through the broker`);
  } catch {
    console.log('.mcp.json:   not found');
  }
}

function main() {
  const found = findConfig(startDir);
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
  const cfg = found.cfg;
  // Resolve the config's relative paths against the dir the config lives in
  // (which the hook walked up to), not the audit's cwd.
  const base = found.dir;
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(base, p));

  // The user running this audit IS the agent uid (that's whose read access we
  // test below), so report it directly rather than shelling out.
  const agentUser = os.userInfo().username;
  console.log(`Repo:        ${base}`);
  console.log(`Agent uid:   ${agentUser}`);
  console.log(`Runner:      ${cfg.runnerUser || 'mcp-runner'}`);
  console.log('');

  const { files, protectedCount } = reportSecretsFiles(cfg, abs);
  console.log('');
  console.log(`Wrapper:     ${cfg.wrapper}  [${stat(abs(cfg.wrapper))}]`);
  const broker = cfg.brokerPath || brokerDefaultFor(base);
  const brokerConf = path.join(path.dirname(broker), 'broker.conf');
  console.log(`Broker:      ${broker}  [${stat(broker)}]`);
  console.log(`Broker conf: ${brokerConf}  [${stat(brokerConf)}]`);

  reportMcpWiring(cfg, abs, broker);

  console.log('');
  if (files.length && protectedCount === files.length) {
    console.log('STATUS: boundary ACTIVE — agent uid is denied on all (existing) secrets files.');
  } else {
    console.log('STATUS: boundary NOT fully active — run /heimdall:harden (sudo setup).');
  }
}

main();
