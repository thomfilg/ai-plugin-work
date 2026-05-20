#!/usr/bin/env node

/**
 * browser-verify.js — API-first browser/UI verification helper.
 *
 * Replaces the deleted /check-browser skill. Invokable from /qa
 * (and other QA flows) to verify a specific fact about a running app
 * without spinning up Playwright when an API endpoint can answer.
 *
 * Strategy:
 *   1. If a known API endpoint matches the question, curl it and extract
 *      the answer via jq-style filtering.
 *   2. Otherwise, exit non-zero with guidance to use the browser via
 *      mcp__playwright__browser_* tools directly from the calling agent.
 *
 * USAGE:
 *   node browser-verify.js --url <APP_URL> --query <QUESTION>
 *   node browser-verify.js --url http://localhost:5175 --query "queue health"
 *
 * EXIT:
 *   0 — answered via API, single-line answer on stdout
 *   1 — no API match; caller should use browser automation
 *   2 — config or runtime error (URL unreachable, jq failed, etc.)
 *
 * RATIONALE — why a script and not a skill:
 *   - A skill burns conversation context every time
 *   - A script can be invoked from any QA flow with zero overhead
 *   - The API endpoint table is data, not prose — belongs in code
 */

'use strict';

const { execFileSync } = require('child_process');

// ─── API endpoint registry ────────────────────────────────────────────────
// Map of (lowercased) keywords → endpoint + jq filter. Add entries here as
// new verifications become useful across QA runs. Keep filters narrow —
// the goal is "small concise answer," not "raw JSON dump."
const ENDPOINT_REGISTRY = [
  {
    match: /\bqueue (health|status|monitoring)\b/i,
    endpoint: '/api/queue-monitoring',
    filter:
      '{totalQueues: .queueData.totalQueues, operational: .queueData.operationalQueues, critical: .queueData.criticalQueues}',
  },
  {
    match: /\bservices? (status|health)\b/i,
    endpoint: '/api/services-status',
    filter: '.summary',
  },
  {
    match: /\bincidents?\b/i,
    endpoint: '/api/incidents',
    filter:
      '{total: (.incidents | length), open: ([.incidents[] | select(.status=="open")] | length)}',
  },
  {
    match: /\bdashboard\b/i,
    endpoint: '/api/dashboard',
    filter: '.',
  },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--url') out.url = v;
    else if (k === '--query') out.query = v;
    else {
      process.stderr.write(`Unknown arg: ${k}\n`);
      process.exit(2);
    }
  }
  if (!out.url || !out.query) {
    process.stderr.write('usage: browser-verify.js --url <APP_URL> --query <QUESTION>\n');
    process.exit(2);
  }
  return out;
}

function findEndpoint(query) {
  for (const entry of ENDPOINT_REGISTRY) {
    if (entry.match.test(query)) return entry;
  }
  return null;
}

function curlAndFilter(fullUrl, jqFilter) {
  try {
    const body = execFileSync('curl', ['-s', '--max-time', '10', fullUrl], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!body.trim()) {
      process.stderr.write(`Empty response from ${fullUrl}\n`);
      process.exit(2);
    }
    return execFileSync('jq', ['-c', jqFilter], {
      input: body,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    process.stderr.write(`curl/jq failed for ${fullUrl}: ${err.message}\n`);
    process.exit(2);
  }
}

function main() {
  const { url, query } = parseArgs(process.argv.slice(2));
  const match = findEndpoint(query);
  if (!match) {
    process.stderr.write(
      `No API endpoint matches query: "${query}". ` +
        `Use mcp__playwright__browser_* tools from the calling agent for visual verification.\n`
    );
    process.exit(1);
  }
  const fullUrl = url.replace(/\/+$/, '') + match.endpoint;
  const answer = curlAndFilter(fullUrl, match.filter);
  process.stdout.write(`ANSWER: ${answer}\n`);
  process.exit(0);
}

main();
