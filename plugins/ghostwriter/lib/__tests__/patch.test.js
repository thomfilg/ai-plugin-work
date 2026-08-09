/**
 * Unit tests for lib/patch.js — reading a byline out of a mail-formatted patch.
 *
 * The parser exists because `git am` puts the author and the message in the
 * FILE, so these tests pin the two things that decide whether the guard sees
 * the right text: which header wins, and where the message stops. The second
 * matters most — a parser that runs into the diff reports every patch touching
 * this plugin as an offender.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/patch.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parsePatches } = require('../patch');

const TOOL = ['Cl', 'aude'].join('');

const MAIL = [
  'From 8a3f4c2e0f9b1d Mon Sep 17 00:00:00 2001',
  'From: Ada Lovelace <ada@example.com>',
  'Date: Mon, 2 Jun 2025 10:00:00 +0000',
  'Subject: [PATCH v2 3/7] feat: a change',
  '',
  'Why it changed.',
  '',
  '---',
  ' lib/a.js | 2 +-',
  'diff --git a/lib/a.js b/lib/a.js',
  `+  reject('Co-Authored-By: ${TOOL} <a@b>');`,
  '',
].join('\n');

describe('parsePatches', () => {
  it('reads the author and the message out of a patch', () => {
    const [mail] = parsePatches(MAIL);
    assert.deepEqual(mail, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'feat: a change\n\nWhy it changed.',
    });
  });

  // The whole reason the diff is excluded: this plugin's own source quotes the
  // strings it rejects, and a patch that touches it must still be appliable.
  it('stops at the diff separator', () => {
    assert.ok(!parsePatches(MAIL)[0].message.includes('reject('));
  });

  it('strips the bracketed bookkeeping from the subject', () => {
    const [mail] = parsePatches(MAIL);
    assert.equal(mail.message.split('\n')[0], 'feat: a change');
  });

  // git prefers an in-body header, which is how a patch keeps its author
  // through a mailing list that rewrites the envelope.
  it('lets an in-body From: override the mail header', () => {
    const [mail] = parsePatches(MAIL.replace('Why it changed.', `From: ${TOOL} <a@b>\n\nbody`));
    assert.equal(mail.name, TOOL);
    assert.equal(mail.email, 'a@b');
    assert.equal(mail.message, 'feat: a change\n\nbody');
  });

  it('folds a continued header back onto one line', () => {
    const folded = MAIL.replace(
      'From: Ada Lovelace <ada@example.com>',
      'From: Ada\n  Lovelace <ada@example.com>'
    );
    assert.equal(parsePatches(folded)[0].name, 'Ada Lovelace');
  });

  // Nothing is dropped when the address is unusual: the raw value stays in
  // `name`, so it still reaches the identity rules.
  it('keeps a bare address, and unquotes a quoted display name', () => {
    assert.equal(
      parsePatches(MAIL.replace('Ada Lovelace <ada@example.com>', 'bot@x'))[0].name,
      'bot@x'
    );
    assert.equal(
      parsePatches(MAIL.replace('Ada Lovelace <', '"Ada Lovelace" <'))[0].name,
      'Ada Lovelace'
    );
  });

  it('splits an mbox into one entry per patch', () => {
    const series = MAIL + MAIL.replace('Ada Lovelace <ada@example.com>', `${TOOL} <a@b>`);
    const mails = parsePatches(series);
    assert.equal(mails.length, 2);
    assert.deepEqual(
      mails.map((mail) => mail.name),
      ['Ada Lovelace', TOOL]
    );
  });

  it('reports empty fields for text that is not a patch at all', () => {
    assert.deepEqual(parsePatches(''), [{ name: '', email: '', message: '' }]);
  });
});
