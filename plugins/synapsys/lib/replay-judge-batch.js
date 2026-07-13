'use strict';

/**
 * synapsys-replay — pure batch helpers for the subagent-driven judge flow.
 *
 * Public surface (consumed by scripts/synapsys-replay-next.js and the
 * `synapsys-replay-judge` agent):
 *   - buildBatchInput(tuples) -> { memory, body, prompt, matched }[]
 *   - parseBatchOutput(rawJson, inputBatch) -> { memory, relevant }[]
 *   - sampleForCap(tuples, cap) -> { sampled, extrapolated }
 *   - JUDGE_BATCH_SIZE (number)
 *   - JUDGE_SYSTEM_PROMPT (string)
 *
 * All helpers are pure: no fs, no fetch, no env reads, no side effects.
 */

const JUDGE_BATCH_SIZE = 10;
const MEMORY_BODY_PREVIEW_CHARS = 200;
const PROMPT_PREVIEW_CHARS = 600;
const MATCHED_PREVIEW_CHARS = 200;

const JUDGE_SYSTEM_PROMPT =
  'You are a relevance judge for synapsys memories. For each numbered item, decide whether the memory was ACTUALLY RELEVANT to the user prompt shown. Each item gives you the memory name, the first part of its content body, the user prompt, and the substring that matched. Reply with one line per item in the exact form "N: yes" or "N: no" (lowercase, no extra text). Answer "yes" only when the memory content would have been useful context for that prompt; otherwise "no". Do not add explanations or any other output.';

function clipText(s, max) {
  if (typeof s !== 'string') return s;
  if (s.length <= max) return s;
  const budget = max - 1; // reserve 1 char for ellipsis
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function buildBatchInput(tuples) {
  if (!Array.isArray(tuples)) return [];
  return tuples.map((it) => ({
    memory: it.memory,
    body: (it.body || '').slice(0, MEMORY_BODY_PREVIEW_CHARS),
    prompt: clipText(it.prompt || '', PROMPT_PREVIEW_CHARS),
    matched: clipText(it.matched || '', MATCHED_PREVIEW_CHARS),
  }));
}

function failAll(inputBatch) {
  return inputBatch.map((it) => ({ memory: it.memory, relevant: 'judge-failed' }));
}

function normalizeEntry(parsedEntry, inputEntry) {
  if (!parsedEntry || typeof parsedEntry !== 'object') {
    return { memory: inputEntry.memory, relevant: 'judge-failed' };
  }
  const { relevant } = parsedEntry;
  if (relevant !== 'yes' && relevant !== 'no' && relevant !== 'judge-failed') {
    return { memory: inputEntry.memory, relevant: 'judge-failed' };
  }
  return { memory: inputEntry.memory, relevant };
}

function parseBatchOutput(rawJson, inputBatch) {
  const input = Array.isArray(inputBatch) ? inputBatch : [];
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return failAll(input);
  }
  if (!Array.isArray(parsed) || parsed.length !== input.length) {
    return failAll(input);
  }
  return input.map((it, i) => normalizeEntry(parsed[i], it));
}

/**
 * `sampleForCap(tuples, cap)` — when `tuples.length > cap`, return `cap`
 * items evenly sampled per `Math.floor(i * fires / cap)` and flag
 * `extrapolated:true`. Otherwise return all items unchanged.
 */
function sampleForCap(tuples, cap) {
  const items = Array.isArray(tuples) ? tuples : [];
  const fires = items.length;
  if (fires <= cap) return { sampled: items.slice(), extrapolated: false };
  const sampled = [];
  for (let i = 0; i < cap; i++) {
    sampled.push(items[Math.floor((i * fires) / cap)]);
  }
  return { sampled, extrapolated: true };
}

module.exports = {
  buildBatchInput,
  parseBatchOutput,
  sampleForCap,
  JUDGE_BATCH_SIZE,
  JUDGE_SYSTEM_PROMPT,
};
