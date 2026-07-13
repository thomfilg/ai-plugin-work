#!/usr/bin/env node
'use strict';
/**
 * install-work-statusline.js — register/remove the /work status bar.
 *
 *   (no args)   register the work bar as a fragment under the shared host
 *   --print     show resolved renderer path + current/host config
 *   --remove    remove only the work fragment (other bars untouched)
 *
 * All host + settings.json plumbing (and the codex guard) lives in the shared
 * lib/statusline/install-statusline.js. Renderer path resolves from __dirname
 * (never process.env.CLAUDE_PLUGIN_ROOT).
 *
 * Fragment order (filename sort) stacks the bars: maestro (10) → work (20) →
 * follow-up (30) → qc (40), all rendered by the one host — no install-order
 * dependency, no clobbering.
 */
const path = require('path');

const { runStatuslineInstaller } = require('../../lib/statusline/install-statusline');

runStatuslineInstaller({
  mode: process.argv[2],
  label: 'work',
  renderer: path.join(__dirname, 'work-statusline.sh'),
  fragment: '20-work.cmd',
  codexNote:
    'On codex, /statusline configures built-in fields only and /status prints session\n' +
    'info — neither renders /work state. Watch it from the CLI instead:\n' +
    "  watch -n 3 'cat <TASKS_BASE>/<ticket>/.work-state.json'\n" +
    '(the /work engine keeps writing that state file on codex too)\n',
});
