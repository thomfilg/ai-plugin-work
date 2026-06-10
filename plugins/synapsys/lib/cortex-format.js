'use strict';

const HEADER = '[cortex:auto-recall]';

/**
 * Render a calendar date (UTC) as `YYYY-MM-DD` from an ISO-8601 timestamp.
 * @param {string} savedAt ISO-8601 timestamp.
 * @returns {string} `YYYY-MM-DD`.
 */
function savedDate(savedAt) {
  return new Date(savedAt).toISOString().slice(0, 10);
}

/**
 * Render an integer age-in-days as a human relative-age annotation.
 * @param {number} ageDays Age of the memory in days.
 * @returns {string} e.g. `5 days ago`, `1 day ago`, `7 months ago`.
 */
function relativeAge(ageDays) {
  if (ageDays < 1) return 'today';
  if (ageDays < 30) {
    return ageDays === 1 ? '1 day ago' : `${ageDays} days ago`;
  }
  if (ageDays < 365) {
    const months = Math.floor(ageDays / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.floor(ageDays / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/**
 * Hard-cut a body to at most `maxChars`, appending `…` when truncated so the
 * returned string is exactly `maxChars` long (maxChars-1 visible chars + `…`).
 * @param {string} body Raw memory body.
 * @param {number} maxChars Maximum rendered length including the `…` suffix.
 * @returns {string} The body, truncated when longer than `maxChars`.
 */
function truncateBody(body, maxChars) {
  if (typeof body !== 'string' || body.length <= maxChars) return body;
  return `${body.slice(0, maxChars - 1)}…`;
}

/**
 * Render a single result as a `- {id} (saved {YYYY-MM-DD}, {age}) — {title} :: {body}` line.
 * @param {{id:string,savedAt:string,title:string,body:string,ageDays:number}} result Result entry.
 * @param {number} maxChars Body truncation budget.
 * @returns {string} The formatted result line.
 */
function formatLine(result, maxChars) {
  const date = savedDate(result.savedAt);
  const age = relativeAge(result.ageDays);
  const body = truncateBody(result.body, maxChars);
  return `- ${result.id} (saved ${date}, ${age}) — ${result.title} :: ${body}`;
}

/**
 * Render the `[cortex:auto-recall]` injection block.
 *
 * For each query: results older than `maxAgeDays` are filtered out; remaining
 * results render one line each. A query with no surviving results renders the
 * empty-result marker `[cortex:auto-recall] query="<q>" projectId="<p>" → no matches`.
 *
 * @param {{queries:Array<{query:string,projectId:string,results:Array}>,maxAgeDays:number,maxChars:number}} args Block inputs.
 * @returns {string} The rendered multi-line block.
 */
function formatBlock({ queries, maxAgeDays, maxChars }) {
  const blocks = [];
  for (const q of queries) {
    const fresh = (q.results || []).filter((r) => r.ageDays <= maxAgeDays);
    if (fresh.length === 0) {
      blocks.push(`${HEADER} query="${q.query}" projectId="${q.projectId}" → no matches`);
      continue;
    }
    const lines = [HEADER, ...fresh.map((r) => formatLine(r, maxChars))];
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

module.exports = { formatBlock, relativeAge, formatLine, truncateBody };
