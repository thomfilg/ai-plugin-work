'use strict';
/**
 * install-statusline.js — shared register/remove/--print engine for the plugin's
 * Claude Code status bars (follow-up, work, …) via the single-host model
 * (see host/statusline-host.js). Each bar's installer is a thin wrapper that
 * supplies its own renderer path, fragment name, label, and codex note; the
 * host + settings.json plumbing lives here so the bars stay byte-identical in
 * behaviour and free of copy-paste.
 *
 * The host at ~/.claude/statusline-host.sh owns the single statusLine slot at a
 * fixed, checkout-independent path and renders every registered fragment, so
 * installing/removing one bar never clobbers the others and new tabs/sessions
 * pick it up with no reinstall.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { detectRuntime } = require('../runtime');
const host = require('./host/statusline-host');

// Kept for back-compat with callers/tests that referenced the settings path.
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function printMode(fragment, renderer, write) {
  const s = host.state(fragment);
  write(
    `renderer:      ${renderer} (exists=${fs.existsSync(renderer)})\n` +
      `host:          ${s.hostPath}${s.hostExists ? '' : ' (MISSING)'}\n` +
      `current slot:  ${s.currentSlot}\n` +
      `host active:   ${s.registered ? 'yes' : 'no'}\n` +
      `fragment:      ${s.myTarget}\n` +
      `all fragments: ${s.allFragments.join(', ') || '(none)'}\n`
  );
}

function removeMode(label, fragment, write) {
  host.remove(fragment);
  write(`${label} status bar removed (${fragment}); other bars untouched\n`);
}

function registerMode(label, renderer, fragment, write) {
  host.register(fragment, renderer);
  write(
    `${label} status bar registered -> ${renderer}\n` +
      `host owns the slot at ${host.HOST_PATH} — new tabs pick it up automatically.\n`
  );
}

/**
 * Run a bar installer. Handles the codex guard (no statusline surface) and the
 * default/--print/--remove modes.
 * @param {object} opts
 * @param {string} opts.mode process.argv[2]
 * @param {string} opts.label human label, e.g. 'work' / 'follow-up'
 * @param {string} opts.renderer absolute path to the bar's .sh renderer
 * @param {string} opts.fragment registry fragment name, e.g. '30-followup.cmd'
 * @param {string} opts.codexNote CLI-alternative text for the codex refusal
 * @param {(s:string)=>void} [opts.write] output sink (defaults to stdout)
 * @param {()=>never} [opts.exit] exit fn (defaults to process.exit)
 */
function runStatuslineInstaller(opts) {
  const write = opts.write || ((s) => process.stdout.write(s));
  const exit = opts.exit || ((c) => process.exit(c));
  if (detectRuntime() === 'codex') {
    // Codex CLI DOES have a status line (/statusline → tui.status_line), but it
    // only renders a fixed enum of built-in fields (model, git branch, tokens…)
    // — not command-backed renderers like this one (openai/codex#20140). So the
    // bar can't paint on codex; refuse cleanly and point at the CLI alternative.
    write(
      "[work:codex-degraded] statusline unavailable — codex's status line (tui.status_line) " +
        'renders only built-in fields, not command-backed renderers like this one.\n' +
        opts.codexNote
    );
    return exit(0);
  }
  if (opts.mode === '--print') return printMode(opts.fragment, opts.renderer, write);
  if (opts.mode === '--remove') return removeMode(opts.label, opts.fragment, write);
  return registerMode(opts.label, opts.renderer, opts.fragment, write);
}

module.exports = { runStatuslineInstaller, SETTINGS };
