'use strict';
/**
 * install-statusline.js — shared register/remove/--print engine for the plugin's
 * Claude Code status bars (follow-up, work, …). Each bar's installer is a thin
 * wrapper that supplies its own renderer path, chain file, labels, and codex
 * note; all the settings.json + chain-file plumbing lives here so the bars stay
 * byte-identical in behaviour and free of copy-paste.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { detectRuntime } = require('../runtime');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

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
const readChain = (chainFile) => {
  try {
    return fs.readFileSync(chainFile, 'utf8').trim();
  } catch {
    return '';
  }
};

function printMode(renderer, chainFile, write) {
  const cur = (loadCfg().statusLine || {}).command || '(none)';
  write(
    `renderer: ${renderer} (exists=${fs.existsSync(renderer)})\n` +
      `current:  ${cur}\n` +
      `chained:  ${readChain(chainFile) || '(none)'}\n`
  );
}

function removeMode(label, chainFile, write) {
  const cfg = loadCfg();
  const prev = readChain(chainFile);
  if (prev) cfg.statusLine = bar(prev);
  else delete cfg.statusLine;
  persist(cfg);
  try {
    fs.unlinkSync(chainFile);
  } catch {
    /* nothing to clear */
  }
  write(`${label} status bar removed${prev ? ` — restored ${prev}` : ''}\n`);
}

function registerMode(label, renderer, rendererName, chainFile, write) {
  const cfg = loadCfg();
  const cur = (cfg.statusLine || {}).command;
  if (cur && !cur.includes(rendererName)) {
    fs.mkdirSync(path.dirname(chainFile), { recursive: true });
    fs.writeFileSync(chainFile, `${cur}\n`); // chain the existing bar beneath ours
  }
  cfg.statusLine = bar(renderer);
  persist(cfg);
  write(`${label} status bar registered -> ${renderer}\n`);
}

/**
 * Run a bar installer. Handles the codex guard (no statusline surface) and the
 * default/--print/--remove modes.
 * @param {object} opts
 * @param {string} opts.mode process.argv[2]
 * @param {string} opts.label human label, e.g. 'work' / 'follow-up'
 * @param {string} opts.renderer absolute path to the bar's .sh renderer
 * @param {string} opts.rendererName basename used to detect "already ours"
 * @param {string} opts.chainFile absolute path to this bar's chain file
 * @param {string} opts.codexNote CLI-alternative text for the codex refusal
 * @param {(s:string)=>void} [opts.write] output sink (defaults to stdout)
 * @param {()=>never} [opts.exit] exit fn (defaults to process.exit)
 */
function runStatuslineInstaller(opts) {
  const write = opts.write || ((s) => process.stdout.write(s));
  const exit = opts.exit || ((c) => process.exit(c));
  if (detectRuntime() === 'codex') {
    write(
      '[work:codex-degraded] statusline unavailable — codex has no plugin statusline surface.\n' +
        opts.codexNote
    );
    return exit(0);
  }
  if (opts.mode === '--print') return printMode(opts.renderer, opts.chainFile, write);
  if (opts.mode === '--remove') return removeMode(opts.label, opts.chainFile, write);
  return registerMode(opts.label, opts.renderer, opts.rendererName, opts.chainFile, write);
}

module.exports = { runStatuslineInstaller, SETTINGS };
