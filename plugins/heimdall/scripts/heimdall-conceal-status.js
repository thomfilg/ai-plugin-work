#!/usr/bin/env node
/**
 * heimdall-conceal-status — report the secrets-safe posture for a project.
 * Usage: node heimdall-conceal-status.js [repo-dir]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const abs = (p) => (path.isAbsolute(p) ? p : path.join(repo, p));

function stat(p) {
  try {
    const s = fs.statSync(p);
    // execFileSync (no shell) — p is config/repo-derived, so a shell string
    // would be an injection vector (CodeQL js/shell-command-injection-from-environment).
    const owner = execFileSync('stat', ['-c', '%U:%G %a', p]).toString().trim();
    return `${owner}${s.isDirectory() ? ' (dir)' : ''}`;
  } catch {
    return 'MISSING';
  }
}

// Mirror setup-secrets-heimdall.sh: the broker (and its co-located broker.conf)
// default to a per-repo directory so projects don't share one global config.
const repoSlug = path.basename(repo).replace(/[^A-Za-z0-9._-]/g, '_');
const DEFAULT_BROKER = `/usr/local/lib/mcp-broker/${repoSlug}/mcp-pg-broker`;

function loadConfig(cfgPath) {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return null;
  }
}

function canAgentRead(agentUser, p) {
  try {
    // execFileSync (no shell): agentUser/p are environment-derived.
    execFileSync('sudo', ['-n', '-u', agentUser, 'cat', p], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function reportSecretsFiles(cfg, agentUser) {
  console.log('Secrets files:');
  let denied = 0;
  const files = cfg.secretsFiles || [];
  for (const f of files) {
    const exposed = canAgentRead(agentUser, abs(f));
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
  const cfg = loadConfig(cfgPath);
  if (!cfg) {
    console.log(`heimdall: no config at ${cfgPath} → guard inactive for this project.`);
    process.exit(0);
  }

  const agentUser = execFileSync('stat', ['-c', '%U', repo]).toString().trim();
  console.log(`Repo:        ${repo}`);
  console.log(`Agent uid:   ${agentUser}`);
  console.log(`Runner:      ${cfg.runnerUser || 'mcp-runner'}`);
  console.log('');

  const { files, denied } = reportSecretsFiles(cfg, agentUser);
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
