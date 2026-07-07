#!/usr/bin/env node
'use strict';
/**
 * install-followup-statusline.js — register/remove the /follow-up status bar.
 *
 *   (no args)   register followup-statusline.sh as the Claude Code statusLine,
 *               preserving any existing bar into the chain file
 *   --print     show resolved renderer path + current/chained config
 *   --remove    unregister and restore the chained bar
 *
 * Renderer path resolves from __dirname (never process.env.CLAUDE_PLUGIN_ROOT).
 *
 * Codex guard (design C4/§M): codex has no plugin statusline surface, so under
 * AGENT_RUNTIME=codex every mode refuses cleanly (exit 0) and prints the CLI
 * alternative instead of touching ~/.claude/settings.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { detectRuntime } = require('../../lib/runtime');

if (detectRuntime() === 'codex') {
  process.stdout.write(
    '[work:codex-degraded] statusline unavailable — codex has no plugin statusline surface.\n' +
      'Watch follow-up progress from the CLI instead:\n' +
      "  watch -n 3 'cat <TASKS_BASE>/<ticket>/.follow-up-state.json'\n" +
      '(the /follow-up monitor step keeps writing that state file on codex too)\n'
  );
  process.exit(0);
}

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CHAIN = path.join(os.homedir(), '.cache', 'followup', 'statusline-chain.cmd');
const RENDERER = path.join(__dirname, 'followup-statusline.sh');

const loadCfg = () => {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return {};
  }
};
const persist = (cfg) => {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, `${JSON.stringify(cfg, null, 2)}\n`);
};
const bar = (cmd) => ({ type: 'command', command: cmd, padding: 0, refreshInterval: 3 });
const readChain = () => {
  try {
    return fs.readFileSync(CHAIN, 'utf8').trim();
  } catch {
    return '';
  }
};

const mode = process.argv[2];

if (mode === '--print') {
  const cur = (loadCfg().statusLine || {}).command || '(none)';
  process.stdout.write(
    `renderer: ${RENDERER} (exists=${fs.existsSync(RENDERER)})\n` +
      `current:  ${cur}\n` +
      `chained:  ${readChain() || '(none)'}\n`
  );
} else if (mode === '--remove') {
  const cfg = loadCfg();
  const prev = readChain();
  if (prev) cfg.statusLine = bar(prev);
  else delete cfg.statusLine;
  persist(cfg);
  try {
    fs.unlinkSync(CHAIN);
  } catch {
    /* nothing to clear */
  }
  process.stdout.write(`follow-up status bar removed${prev ? ` — restored ${prev}` : ''}\n`);
} else {
  const cfg = loadCfg();
  const cur = (cfg.statusLine || {}).command;
  if (cur && !cur.includes('followup-statusline.sh')) {
    fs.mkdirSync(path.dirname(CHAIN), { recursive: true });
    fs.writeFileSync(CHAIN, `${cur}\n`); // chain the existing bar beneath ours
  }
  cfg.statusLine = bar(RENDERER);
  persist(cfg);
  process.stdout.write(`follow-up status bar registered -> ${RENDERER}\n`);
}
