/**
 * Integration tests for lib/ticket-provider.js `getRelatedTicketsPrompt()` —
 * the shared schemaBlock must instruct the agent to EXCLUDE the current ticket
 * id from every link bucket (siblings, blockedBy, dependsOn, relatedTo, parent)
 * and to NEVER write `_related/<self>.md`.
 *
 * Run: node --test scripts/workflows/lib/__tests__/ticket-provider-prompt-exclude-self.integration.test.js
 *
 * Task: GH-415 / task5
 * Requirements: R4
 * Scenario: agent prompt explicitly excludes self from every bucket
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getRelatedTicketsPrompt } = require('../ticket-provider');

const TICKET_ID = 'GH-415';
const MANIFEST_PATH = '/tmp/tasks/GH-415/related-tickets.json';

const BUCKETS = ['siblings', 'blockedBy', 'dependsOn', 'relatedTo', 'parent'];

function assertSchemaBlockExcludesSelf(prompt, providerLabel) {
  assert.ok(prompt && typeof prompt === 'string', `${providerLabel}: prompt must be a non-empty string`);

  // Must mention the current ticket id
  assert.ok(
    prompt.includes(TICKET_ID),
    `${providerLabel}: prompt must reference the current ticket id "${TICKET_ID}"`
  );

  // Must contain the spec GREP marker — either "Exclude.*current ticket" or "never its own"
  const specMarker = /Exclude.*current ticket|never its own/.test(prompt);
  assert.ok(
    specMarker,
    `${providerLabel}: prompt must match spec GREP /Exclude.*current ticket|never its own/`
  );

  // All five bucket names must appear in conjunction with a prohibition on the current ticket
  for (const bucket of BUCKETS) {
    assert.ok(
      prompt.includes(bucket),
      `${providerLabel}: prompt must mention bucket "${bucket}"`
    );
  }

  // The literal `_related/<self>.md` must appear paired with `never`
  const relatedPath = `_related/${TICKET_ID}.md`;
  assert.ok(
    prompt.includes(relatedPath),
    `${providerLabel}: prompt must contain literal path "${relatedPath}"`
  );
  // "never" must appear somewhere near (in the same prompt) — pairing requirement
  assert.ok(
    /never/i.test(prompt),
    `${providerLabel}: prompt must contain "never" paired with "${relatedPath}"`
  );

  // Stronger pairing check: "never" and the _related/<self>.md path must appear in
  // a single sentence/clause (within 200 chars of each other) so the rule reads
  // as one instruction, not two unrelated mentions.
  const idx = prompt.indexOf(relatedPath);
  const window = prompt.slice(Math.max(0, idx - 200), idx + relatedPath.length + 200);
  assert.ok(
    /never/i.test(window),
    `${providerLabel}: "never" must appear within 200 chars of "${relatedPath}" (pairing requirement)`
  );
}

describe('getRelatedTicketsPrompt() shared schemaBlock excludes self from every bucket', () => {
  it('github provider: prompt instructs agent to exclude self from all buckets and never write _related/<self>.md', () => {
    const prompt = getRelatedTicketsPrompt(TICKET_ID, { provider: 'github' }, MANIFEST_PATH);
    assertSchemaBlockExcludesSelf(prompt, 'github');
  });

  it('jira provider: same exclusion rule appears (shared schemaBlock)', () => {
    const prompt = getRelatedTicketsPrompt(TICKET_ID, { provider: 'jira' }, MANIFEST_PATH);
    assertSchemaBlockExcludesSelf(prompt, 'jira');
  });

  it('linear provider: same exclusion rule appears (shared schemaBlock)', () => {
    const prompt = getRelatedTicketsPrompt(TICKET_ID, { provider: 'linear' }, MANIFEST_PATH);
    assertSchemaBlockExcludesSelf(prompt, 'linear');
  });

  it('none provider: returns null (no prompt to inspect)', () => {
    const prompt = getRelatedTicketsPrompt(TICKET_ID, { provider: 'none' }, MANIFEST_PATH);
    assert.equal(prompt, null);
  });

  it('null providerConfig: returns null', () => {
    const prompt = getRelatedTicketsPrompt(TICKET_ID, null, MANIFEST_PATH);
    assert.equal(prompt, null);
  });
});
