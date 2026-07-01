#!/usr/bin/env node
'use strict';
/**
 * install-statusline.js — register the maestro fleet status line as the Claude
 * Code statusLine, mirroring the qc-tasks installer.
 *
 * Usage:
 *   node install-statusline.js            register (default)
 *   node install-statusline.js --print    show resolved paths + current config
 *   node install-statusline.js --remove   unregister and restore the chained line
 *
 * Behavior:
 *   - Resolves the renderer to this plugin's own skills/lib/maestro-statusline.sh
 *     ($CLAUDE_PLUGIN_ROOT at runtime, else relative to this file).
 *   - Writes settings.json .statusLine = { type:"command", command:<renderer>,
 *     padding:0, refreshInterval:3 } so the 🎼 bar updates live even while idle.
 *   - If an existing NON-maestro status line is registered, it is preserved into
 *     the chain file so the renderer shows it BENEATH the maestro line. --remove
 *     restores it as the sole status line.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CHAIN_FILE = path.join(HOME, '.cache', 'maestro', 'statusline-chain.cmd');

function rendererPath() {
  // Resolve relative to this file's own location so the registered command
  // always points at this plugin's renderer, regardless of install layout.
  // this file: <plugin>/skills/install/scripts/install-statusline.js
  return path.join(__dirname, '..', '..', 'lib', 'maestro-statusline.sh');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
}

function block(cmd) {
  return { type: 'command', command: cmd, padding: 0, refreshInterval: 3 };
}

function isMaestro(cmd) {
  return typeof cmd === 'string' && cmd.includes('maestro-statusline.sh');
}

function print() {
  const renderer = rendererPath();
  const s = readSettings();
  const cur = s.statusLine && s.statusLine.command;
  let chain = null;
  try {
    chain = fs.readFileSync(CHAIN_FILE, 'utf8').trim();
  } catch {
    /* none */
  }
  console.log('renderer:      ' + renderer);
  console.log('exists:        ' + fs.existsSync(renderer));
  console.log('settings:      ' + SETTINGS);
  console.log('current line:  ' + (cur || '(none)'));
  console.log('registered:    ' + (isMaestro(cur) ? 'yes (maestro)' : 'no'));
  console.log('chained line:  ' + (chain || '(none)'));
}

function install() {
  const renderer = rendererPath();
  const s = readSettings();
  const existing = s.statusLine && s.statusLine.command;

  // Preserve a non-maestro existing line so it renders beneath the maestro line.
  if (existing && !isMaestro(existing)) {
    fs.mkdirSync(path.dirname(CHAIN_FILE), { recursive: true });
    fs.writeFileSync(CHAIN_FILE, existing + '\n');
    console.log('chained existing status line: ' + existing);
  }

  s.statusLine = block(renderer);
  writeSettings(s);
  console.log('registered maestro status line -> ' + renderer);
  console.log('each orchestrator session shows only the fleet it launched.');
  console.log('run /reload-plugins or restart the statusLine refresh to see it.');
}

function remove() {
  const s = readSettings();
  let restored = null;
  try {
    restored = fs.readFileSync(CHAIN_FILE, 'utf8').trim();
  } catch {
    /* none */
  }
  if (restored) {
    s.statusLine = block(restored);
    console.log('restored chained status line: ' + restored);
  } else {
    delete s.statusLine;
    console.log('removed status line (no chained line to restore).');
  }
  writeSettings(s);
  try {
    fs.unlinkSync(CHAIN_FILE);
  } catch {
    /* none */
  }
}

const arg = process.argv[2];
if (arg === '--print') print();
else if (arg === '--remove') remove();
else install();
