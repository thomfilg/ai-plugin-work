#!/usr/bin/env node
/**
 * heimdall-conceal-status — report the secrets-safe posture for a project.
 * Usage: node heimdall-conceal-status.js [repo-dir]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const abs = (p) => (path.isAbsolute(p) ? p : path.join(repo, p));

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

// Mirror setup-secrets-heimdall.sh: the broker (and its co-located broker.conf)
// default to a per-repo directory so projects don't share one global config.
const repoSlug = path.basename(repo).replace(/[^A-Za-z0-9._-]/g, '_');
const DEFAULT_BROKER = `/usr/local/lib/mcp-broker/${repoSlug}/mcp-pg-broker`;

// Distinguish absent (guard genuinely inactive) from present-but-broken. The
// PreToolUse hook FAILS CLOSED on an unreadable/invalid config (blocks every
// tool call), so the audit must not report "inactive" in those cases.
function loadConfig(cfgPath) {
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

function reportSecretsFiles(cfg) {
  console.log('Secrets files:');
  let denied = 0;
  const files = cfg.secretsFiles || [];
  for (const f of files) {
    const exposed = canAgentRead(abs(f));
    if (!exposed) denied++;
    console.log(`  ${f}  [${stat(abs(f))}]  agent-read: ${exposed ? 'YES (exposed!)' : 'denied'}`);
  }
  return { files, denied };
}

function reportMcpWiring(cfg) {
  const broker = cfg.brokerPath || DEFAULT_BROKER;
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
  const cfgPath = abs('.claude/heimdall-conceal.json');
  const loaded = loadConfig(cfgPath);
  if (loaded.state === 'absent') {
    console.log(`heimdall: no config at ${cfgPath} → guard inactive for this project.`);
    process.exit(0);
  }
  if (loaded.state !== 'ok') {
    console.log(`heimdall: config at ${cfgPath} is present but ${loaded.state} (${loaded.error}).`);
    console.log(
      'STATUS: the PreToolUse conceal guard is FAILING CLOSED — it blocks all tool calls until this config is fixed.'
    );
    process.exit(1);
  }
  const cfg = loaded.cfg;

  // The user running this audit IS the agent uid (that's whose read access we
  // test below), so report it directly rather than shelling out.
  const agentUser = os.userInfo().username;
  console.log(`Repo:        ${repo}`);
  console.log(`Agent uid:   ${agentUser}`);
  console.log(`Runner:      ${cfg.runnerUser || 'mcp-runner'}`);
  console.log('');

  const { files, denied } = reportSecretsFiles(cfg);
  console.log('');
  console.log(`Wrapper:     ${cfg.wrapper}  [${stat(abs(cfg.wrapper))}]`);
  const broker = cfg.brokerPath || DEFAULT_BROKER;
  const brokerConf = path.join(path.dirname(broker), 'broker.conf');
  console.log(`Broker:      ${broker}  [${stat(broker)}]`);
  console.log(`Broker conf: ${brokerConf}  [${stat(brokerConf)}]`);

  reportMcpWiring(cfg);

  console.log('');
  if (files.length && denied === files.length) {
    console.log('STATUS: boundary ACTIVE — agent uid is denied on all secrets files.');
  } else {
    console.log('STATUS: boundary NOT fully active — run /heimdall:harden (sudo setup).');
  }
}

main();
