'use strict';

/**
 * synapsys-replay — judge HTTP integration (extracted from the CLI script to
 * keep the main entrypoint under the 400-line quality cap).
 *
 * Public surface (re-exported by scripts/synapsys-replay.js):
 *   - judgeBatch(items, {fetchImpl, apiKey, model})
 *   - sampleForCap(items, cap)
 *   - judgePipeline(items, {fetchImpl, apiKey, model, maxJudges})
 *   - JUDGE_BATCH_SIZE
 *
 * Never throws on network/HTTP errors; never leaks `apiKey` into thrown
 * error messages.
 */

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const JUDGE_BATCH_SIZE = 10; // R18
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5';
const MEMORY_BODY_PREVIEW_CHARS = 200;
const PROMPT_PREVIEW_CHARS = 600;
const MATCHED_PREVIEW_CHARS = 200;
const REPLY_LINE_REGEX = /^\s*(\d+)\s*:\s*(yes|no)\b/i;

function clipText(s, max) {
  if (typeof s !== 'string') return s;
  if (s.length <= max) return s;
  const head = Math.floor(max / 2);
  const tail = max - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

const JUDGE_SYSTEM_PROMPT =
  'You are a relevance judge for synapsys memories. For each numbered item, decide whether the memory was ACTUALLY RELEVANT to the user prompt shown. Each item gives you the memory name, the first part of its content body, the user prompt, and the substring that matched. Reply with one line per item in the exact form "N: yes" or "N: no" (lowercase, no extra text). Answer "yes" only when the memory content would have been useful context for that prompt; otherwise "no". Do not add explanations or any other output.';

function buildJudgeBody(items, model) {
  const numbered = items
    .map((it, i) => {
      const body = (it.body || '').slice(0, MEMORY_BODY_PREVIEW_CHARS);
      const prompt = clipText(it.prompt || '', PROMPT_PREVIEW_CHARS);
      const matched = clipText(it.matched || '', MATCHED_PREVIEW_CHARS);
      return `${i + 1}) memory titled ${it.memory} with content ${JSON.stringify(body)} prompt=${JSON.stringify(prompt)} matched=${JSON.stringify(matched)}`;
    })
    .join('\n');
  return JSON.stringify({
    model: model || DEFAULT_JUDGE_MODEL,
    max_tokens: 256,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: numbered }],
  });
}

function failAll(items, error) {
  return items.map(() => ({ judge_failed: true, error }));
}

function extractJudgeText(payload) {
  if (
    payload &&
    Array.isArray(payload.content) &&
    payload.content[0] &&
    typeof payload.content[0].text === 'string'
  ) {
    return payload.content[0].text;
  }
  return '';
}

function parseVerdicts(text) {
  const verdicts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = REPLY_LINE_REGEX.exec(line);
    if (m) verdicts.set(Number(m[1]), m[2].toLowerCase() === 'yes');
  }
  return verdicts;
}

async function postJudgeRequest(doFetch, apiKey, body) {
  return doFetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body,
  });
}

function pickFetchImpl(fetchImpl) {
  if (fetchImpl) return fetchImpl;
  return typeof fetch === 'function' ? fetch : null;
}

function safeErrorMessage(err) {
  return String(err && err.message ? err.message : err);
}

function verdictsToResults(items, verdicts) {
  return items.map((_, i) => {
    const v = verdicts.get(i + 1);
    if (v === undefined) return { judge_failed: true, error: 'missing reply line' };
    return { relevant: v };
  });
}

async function fetchJudgeResponse(doFetch, apiKey, items, model) {
  try {
    const resp = await postJudgeRequest(doFetch, apiKey, buildJudgeBody(items, model));
    return { resp };
  } catch (err) {
    return { error: safeErrorMessage(err) };
  }
}

async function parseJudgeResponse(resp) {
  if (!resp || !resp.ok) {
    return { error: `http ${resp ? resp.status : 'no-response'}` };
  }
  try {
    return { payload: await resp.json() };
  } catch {
    return { error: 'invalid json' };
  }
}

async function judgeBatch(items, { fetchImpl, apiKey, model } = {}) {
  const doFetch = pickFetchImpl(fetchImpl);
  if (!doFetch) return failAll(items, 'no fetch impl');

  const fetched = await fetchJudgeResponse(doFetch, apiKey, items, model);
  if (fetched.error) return failAll(items, fetched.error);

  const parsed = await parseJudgeResponse(fetched.resp);
  if (parsed.error) return failAll(items, parsed.error);

  const verdicts = parseVerdicts(extractJudgeText(parsed.payload));
  return verdictsToResults(items, verdicts);
}

/**
 * `sampleForCap(items, cap)` — when `items.length > cap`, return `cap`
 * items evenly sampled per `Math.floor(i * fires / cap)` and flag
 * `extrapolated:true`. Otherwise return all items unchanged.
 */
function sampleForCap(items, cap) {
  const fires = items.length;
  if (fires <= cap) return { sampled: items.slice(), extrapolated: false };
  const sampled = [];
  for (let i = 0; i < cap; i++) {
    sampled.push(items[Math.floor((i * fires) / cap)]);
  }
  return { sampled, extrapolated: true };
}

/**
 * `judgePipeline(items, {fetchImpl, apiKey, model, maxJudges})` —
 * applies `sampleForCap` then dispatches `judgeBatch` calls in batches
 * of `JUDGE_BATCH_SIZE` (R18). Honors `--max-judges` as a hard upper
 * bound on judge API calls (G8 / P0 #6).
 */
async function judgePipeline(items, { fetchImpl, apiKey, model, maxJudges } = {}) {
  const { sampled, extrapolated } = sampleForCap(items, maxJudges);
  const results = [];
  for (let i = 0; i < sampled.length; i += JUDGE_BATCH_SIZE) {
    const batch = sampled.slice(i, i + JUDGE_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const batchResults = await judgeBatch(batch, { fetchImpl, apiKey, model });
    for (let j = 0; j < batch.length; j++) {
      results.push({ ...batch[j], ...batchResults[j] });
    }
  }
  return { results, extrapolated };
}

module.exports = {
  judgeBatch,
  sampleForCap,
  judgePipeline,
  JUDGE_BATCH_SIZE,
};
