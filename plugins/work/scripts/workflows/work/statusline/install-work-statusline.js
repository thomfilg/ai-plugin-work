#!/usr/bin/env node
'use strict';
/**
 * install-work-statusline.js — register/remove the /work status bar.
 *
 *   (no args)   register work-statusline.sh as the Claude Code statusLine,
 *               preserving any existing bar (e.g. the follow-up bar) into the
 *               chain file so it renders BENEATH the work line
 *   --print     show resolved renderer path + current/chained config
 *   --remove    unregister and restore the chained bar
 *
 * All settings.json / chain plumbing (and the codex guard) lives in the shared
 * lib/statusline/install-statusline.js. Renderer path resolves from __dirname
 * (never process.env.CLAUDE_PLUGIN_ROOT).
 *
 * Install order for the full stack: maestro → follow-up → work, so the work bar
 * is outermost and chains follow-up (which chains maestro).
 */
const path = require('path');
const os = require('os');

const { runStatuslineInstaller } = require('../../lib/statusline/install-statusline');

runStatuslineInstaller({
  mode: process.argv[2],
  label: 'work',
  renderer: path.join(__dirname, 'work-statusline.sh'),
  rendererName: 'work-statusline.sh',
  chainFile: path.join(os.homedir(), '.cache', 'work', 'statusline-chain.cmd'),
  codexNote:
    'Watch /work progress from the CLI instead:\n' +
    "  watch -n 3 'cat <TASKS_BASE>/<ticket>/.work-state.json'\n" +
    '(the /work engine keeps writing that state file on codex too)\n',
});
