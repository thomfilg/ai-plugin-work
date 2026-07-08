'use strict';

/**
 * transcript-shared.js — line-level JSONL helpers shared by the two
 * transcript reader legs (transcript-claude.js / transcript-codex.js).
 * The dispatching facade lives in transcript.js.
 */

const fs = require('node:fs');

const FIRST_LINE_BYTE_CAP = 1024 * 1024;

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readFirstLine(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(FIRST_LINE_BYTE_CAP);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const chunk = buffer.toString('utf8', 0, bytes);
    const newline = chunk.indexOf('\n');
    return newline === -1 ? chunk : chunk.slice(0, newline);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Texts of every `{type, text}` content block of the given type, in order. */
function textBlocks(content, type) {
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && c.type === type && c.text).map((c) => c.text);
}

function addToolEvent(event, events, byId) {
  events.push(event);
  if (event.id) byId.set(event.id, event);
}

function normalizeAgentAlias(name) {
  return String(name || '')
    .replace(/^[\w-]+:/, '')
    .toLowerCase();
}

function aliasMatch(value, aliases) {
  if (!value) return false;
  const normalized = normalizeAgentAlias(value);
  return aliases.some((alias) => normalizeAgentAlias(alias) === normalized);
}

module.exports = { readLines, parseLine, readFirstLine, textBlocks, addToolEvent, aliasMatch };
