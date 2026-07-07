'use strict';

/**
 * Codex MCP wiring audit — codex wires MCP servers through `[mcp_servers.<name>]`
 * tables in $CODEX_HOME/config.toml (there is no project .mcp.json lane on
 * codex — ground truth §8.5), so the secrets audit must cover that surface too.
 * Line-level TOML scan: no deps, read-only, never writes config.toml.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function codexConfigTomlPath(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}

/**
 * Count `[mcp_servers.*]` tables and how many route through the broker
 * (command == brokerPath). Returns { cfgPath, total, viaBroker } or null when
 * no codex config exists (claude-only machines stay silent).
 */
function codexMcpWiring(broker, env = process.env) {
  const cfgPath = codexConfigTomlPath(env);
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch {
    return null;
  }
  let inMcpServer = false;
  let total = 0;
  let viaBroker = 0;
  for (const line of raw.split('\n')) {
    const section = line.match(/^\s*\[+([^\]]+)\]+/);
    if (section) {
      inMcpServer = /^mcp_servers\.[^.]+$/.test(section[1].trim());
      if (inMcpServer) total++;
      continue;
    }
    const command = inMcpServer && line.match(/^\s*command\s*=\s*"([^"]*)"/);
    if (command && command[1] === broker) viaBroker++;
  }
  return { cfgPath, total, viaBroker };
}

module.exports = { codexConfigTomlPath, codexMcpWiring };
