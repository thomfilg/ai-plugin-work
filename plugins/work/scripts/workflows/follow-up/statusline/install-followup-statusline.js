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
 * All settings.json / chain plumbing (and the codex guard) lives in the shared
 * lib/statusline/install-statusline.js. Renderer path resolves from __dirname
 * (never process.env.CLAUDE_PLUGIN_ROOT).
 */
const path = require('path');
const os = require('os');

const { runStatuslineInstaller } = require('../../lib/statusline/install-statusline');

runStatuslineInstaller({
  mode: process.argv[2],
  label: 'follow-up',
  renderer: path.join(__dirname, 'followup-statusline.sh'),
  rendererName: 'followup-statusline.sh',
  chainFile: path.join(os.homedir(), '.cache', 'followup', 'statusline-chain.cmd'),
  codexNote:
    'Watch follow-up progress from the CLI instead:\n' +
    "  watch -n 3 'cat <TASKS_BASE>/<ticket>/.follow-up-state.json'\n" +
    '(the /follow-up monitor step keeps writing that state file on codex too)\n',
});
