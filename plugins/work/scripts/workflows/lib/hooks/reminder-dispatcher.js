#!/usr/bin/env node

'use strict';

/**
 * reminder-dispatcher.js — the single consolidated UserPromptSubmit reminder
 * hook (GH-773). Replaces the "N standalone prompt-reminder hooks = N processes
 * re-injecting static context every prompt" pattern with ONE process that:
 *
 *   1. reads stdin JSON (fail-open exit 0 on empty/parse error);
 *   2. resolves the manifest path (`REMINDER_MANIFEST` env → shipped default);
 *   3. validates each entry, dropping only the bad ones (per-entry fail-open);
 *   4. resolves the session id once via remind-once;
 *   5. filters entries by trigger regex + per-session cadence (remind-once);
 *   6. concatenates the surviving bodies into ONE context block emitted via
 *      getRuntime(payload).emit.context('UserPromptSubmit', block); zero firing
 *      entries → emits nothing, exit 0;
 *   7. records each fired once-per-session entry.
 *
 * Manifest entry: `{ id, trigger: "always"|<regex string>, body: <path>,
 * cadence?: "once-per-session"|"every-prompt" }`. `cadence` defaults to
 * `once-per-session`. Any manifest/IO/parse error degrades to the remaining
 * valid entries or no output — it NEVER blocks the prompt.
 *
 * CLI: `node reminder-dispatcher.js validate <manifest>` → exit 0 valid,
 * exit 1 with per-entry diagnostics (CI-usable).
 *
 * Node built-ins only; reuses normalizeHookPayload path (via remind-once),
 * getRuntime, and logHookError.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getRuntime } = require('../runtime');
const { logHookError } = require('../hook-error-log');
const remindOnce = require('./remind-once');

const DEFAULT_MANIFEST = path.join(__dirname, 'reminders.manifest.json');
const MAX_BODY_BYTES = 64 * 1024;
const VALID_CADENCES = new Set(['once-per-session', 'every-prompt']);

function log(err) {
  try {
    logHookError('reminder-dispatcher', err);
  } catch {
    /* fail-open */
  }
}

function manifestPath() {
  return process.env.REMINDER_MANIFEST || DEFAULT_MANIFEST;
}

/** Directory a body path must stay within (the manifest's own directory tree). */
function allowedRoot(mPath) {
  return path.resolve(path.dirname(mPath));
}

function resolveBodyPath(mPath, body) {
  const root = allowedRoot(mPath);
  const resolved = path.resolve(root, body);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Shape check for the string identity fields. Returns an error string or null. */
function entryShapeError(raw) {
  if (!raw || typeof raw !== 'object') return 'missing or invalid id';
  if (typeof raw.id !== 'string' || !raw.id) return 'missing or invalid id';
  if (typeof raw.trigger !== 'string' || !raw.trigger) return 'missing trigger';
  return null;
}

/** Compile a trigger to a regex (null for "always"). Returns { regex } or { error }. */
function compileTrigger(trigger) {
  if (trigger === 'always') return { regex: null };
  try {
    return { regex: new RegExp(trigger) };
  } catch {
    return { error: `bad trigger regex "${trigger}"` };
  }
}

/** Validate one entry against the manifest path. Returns { entry } or { error }. */
function validateEntry(raw, mPath) {
  const shapeErr = entryShapeError(raw);
  if (shapeErr) return { error: shapeErr };
  const cadence = raw.cadence === undefined ? 'once-per-session' : raw.cadence;
  if (!VALID_CADENCES.has(cadence)) return { error: `unknown cadence "${raw.cadence}"` };
  const compiled = compileTrigger(raw.trigger);
  if (compiled.error) return { error: compiled.error };
  const bodyPath = typeof raw.body === 'string' ? resolveBodyPath(mPath, raw.body) : null;
  if (!bodyPath) return { error: 'body path missing or escapes allowed dir' };
  if (!fs.existsSync(bodyPath)) return { error: `body file not found: ${raw.body}` };
  return { entry: { id: raw.id, trigger: raw.trigger, regex: compiled.regex, cadence, bodyPath } };
}

/**
 * Parse + validate a manifest. Returns { entries: [...valid], errors: [{id, error}] }.
 * A manifest that is unreadable / not an array yields empty entries + one error.
 */
function validateManifest(mPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  } catch (err) {
    return { entries: [], errors: [{ id: '<manifest>', error: `unreadable: ${err.message}` }] };
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], errors: [{ id: '<manifest>', error: 'manifest is not an array' }] };
  }
  const entries = [];
  const errors = [];
  for (const raw of parsed) {
    const result = validateEntry(raw, mPath);
    if (result.error) errors.push({ id: (raw && raw.id) || '<unknown>', error: result.error });
    else entries.push(result.entry);
  }
  return { entries, errors };
}

function readBody(bodyPath) {
  try {
    const st = fs.statSync(bodyPath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_BODY_BYTES) return null;
    return fs.readFileSync(bodyPath, 'utf8').trim();
  } catch (err) {
    log(err);
    return null;
  }
}

/** Whether an entry should fire for this prompt + session. */
function entryFires(entry, prompt, sessionId) {
  if (entry.regex && !entry.regex.test(prompt)) return false;
  return remindOnce.shouldRemind(sessionId, entry.id, entry.cadence);
}

/** Collect the fired entries' bodies and the ids to record. */
function collectFired(entries, prompt, sessionId) {
  const blocks = [];
  const toRecord = [];
  for (const entry of entries) {
    if (!entryFires(entry, prompt, sessionId)) continue;
    const body = readBody(entry.bodyPath);
    if (!body) continue;
    blocks.push(body);
    if (entry.cadence === 'once-per-session') toRecord.push(entry.id);
  }
  return { blocks, toRecord };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Hook path: stdin → manifest → filter → combine → emit. Always exit 0. */
function runHook() {
  const payload = parsePayload(readStdin());
  if (!payload) return process.exit(0);
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const { entries } = validateManifest(manifestPath());
  if (entries.length === 0) return process.exit(0);
  const sessionId = remindOnce.resolveSessionId(payload);
  const { blocks, toRecord } = collectFired(entries, prompt, sessionId);
  if (blocks.length === 0) return process.exit(0);
  const block = blocks.join('\n\n');
  getRuntime(payload).emit.context('UserPromptSubmit', block);
  for (const id of toRecord) remindOnce.recordReminder(sessionId, id);
  process.exit(0);
}

/** CLI: validate a manifest. Exit 0 clean, exit 1 with per-entry diagnostics. */
function runValidate(mPath) {
  const target = mPath || manifestPath();
  const { entries, errors } = validateManifest(target);
  if (errors.length === 0) {
    process.stdout.write(`ok: ${entries.length} valid entr${entries.length === 1 ? 'y' : 'ies'}\n`);
    return process.exit(0);
  }
  for (const e of errors) process.stderr.write(`invalid entry "${e.id}": ${e.error}\n`);
  return process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'validate') return runValidate(argv[1]);
  return runHook();
}

try {
  main();
} catch (err) {
  log(err);
  process.exit(0);
}

module.exports = { validateManifest, validateEntry, resolveBodyPath };
