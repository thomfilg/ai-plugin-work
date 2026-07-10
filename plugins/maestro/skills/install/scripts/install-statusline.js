#!/usr/bin/env node
'use strict';
/**
 * install-statusline.js — register the maestro fleet status line via the shared
 * single-host statusline model (see lib/statusline-host.js).
 *
 * Usage:
 *   node install-statusline.js            register (default)
 *   node install-statusline.js --print    show resolved paths + current config
 *   node install-statusline.js --remove   unregister just the maestro bar
 *
 * Behavior:
 *   - Installs the fixed host at ~/.claude/statusline-host.sh (checkout-
 *     independent → every new tab/session picks it up, no reinstall) and drops
 *     the maestro fragment ~/.claude/statuslines/10-maestro.cmd pointing at this
 *     plugin's renderer.
 *   - Because each plugin owns only its own fragment, installing/removing the
 *     maestro bar never clobbers the work/follow-up/qc bars, and vice-versa.
 *   - Codex guard (design C4/§M): codex has no plugin statusline surface, so
 *     under AGENT_RUNTIME=codex every mode refuses cleanly (exit 0) and prints
 *     the tmux alternative instead of touching ~/.claude/settings.json.
 */
const path = require('path');

const { detectRuntime } = require('../../../scripts/lib/runtime');
const host = require('./lib/statusline-host');

const FRAGMENT = '10-maestro.cmd';

if (detectRuntime() === 'codex') {
  process.stdout.write(
    '[maestro:codex-degraded] statusline unavailable — codex has no plugin statusline surface.\n' +
      'Fleet visibility without it:\n' +
      "  tmux set -g status-right '#(tail -n1 /tmp/maestro-conduct.log | cut -c1-120)'\n" +
      '  tail -f /tmp/maestro-alerts.jsonl   # the conductor alert stream\n'
  );
  process.exit(0);
}

function rendererPath() {
  // Resolve relative to this file so the fragment always points at this
  // plugin's own renderer, regardless of install layout.
  // this file: <plugin>/skills/install/scripts/install-statusline.js
  return path.join(__dirname, '..', '..', 'lib', 'maestro-statusline.sh');
}

function print() {
  const s = host.state(FRAGMENT);
  console.log('renderer:      ' + rendererPath());
  console.log('host:          ' + s.hostPath + (s.hostExists ? '' : ' (MISSING)'));
  console.log('current slot:  ' + s.currentSlot);
  console.log('host active:   ' + (s.registered ? 'yes' : 'no'));
  console.log('maestro frag:  ' + s.myTarget);
  console.log('all fragments: ' + (s.allFragments.join(', ') || '(none)'));
}

function install() {
  const renderer = rendererPath();
  host.register(FRAGMENT, renderer);
  console.log('registered maestro status line -> ' + renderer);
  console.log('host owns the slot at ' + host.HOST_PATH + ' — new tabs pick it up automatically.');
  console.log('run /reload-plugins or wait for the statusLine refresh to see it.');
}

function remove() {
  host.remove(FRAGMENT);
  console.log('removed the maestro fragment (' + FRAGMENT + '); other bars untouched.');
}

const arg = process.argv[2];
if (arg === '--print') print();
else if (arg === '--remove') remove();
else install();
