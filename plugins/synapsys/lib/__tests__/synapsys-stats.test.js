'use strict';

/**
 * Unit tests for `plugins/synapsys/scripts/synapsys-stats.js` (GH-512, Task 4).
 *
 * Covers Gherkin scenarios AC10 / AC11 — windowed aggregation across
 * `.telemetry/*.jsonl` files producing Top influencers / Noise candidates /
 * Never-fired sections.
 *
 * Requirements: R3, C2, C6.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATS = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-stats.js');
let helpers;
try {
  // Pure helpers are exported once REFACTOR completes. During RED/GREEN the
  // require may fail; tests below tolerate `helpers === null` by skipping
  // helper-only assertions.
  helpers = require(STATS);
} catch {
  helpers = null;
}

function writeMemoryFile(storeDir, name) {
  const body = ['---', `name: ${name}`, 'description: x', 'events: UserPromptSubmit', 'trigger_prompt: x', '---', ''].join('\n');
  fs.writeFileSync(path.join(storeDir, `${name}.md`), body);
}

function makeFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stats-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stats-home-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  // Telemetry lives under the FIXED home dir (matches lib/telemetry.telemetryDir()),
  // not under the per-store directory.
  const telDir = path.join(home, '.claude', 'synapsys', '.telemetry');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(telDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'synapsys-stats-fixture' })
  );
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  return {
    cwd,
    home,
    storeDir,
    telDir,
    cleanup: () => {
      process.env.HOME = prevHome;
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

function writeJsonl(file, lines) {
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('synapsys:stats surfaces top influencers, noise, and never-fired in a 7d window', () => {
  assert.ok(helpers, 'synapsys-stats.js must export pure helpers (parseWindow, aggregate, formatSections)');
  const { parseWindow, aggregate, formatSections } = helpers;

  const fx = makeFixture();
  try {
    writeMemoryFile(fx.storeDir, 'mem-influencer');
    writeMemoryFile(fx.storeDir, 'mem-noise');
    writeMemoryFile(fx.storeDir, 'mem-quiet');

    const now = Date.now();
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'mem-influencer', event: 'fired' });
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'mem-influencer', event: 'cited', match: 'x' });
    }
    for (let i = 0; i < 10; i++) {
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'mem-noise', event: 'fired' });
    }
    const sessionFile = path.join(fx.telDir, 'session-1.jsonl');
    writeJsonl(sessionFile, lines);

    const windowMs = parseWindow('7d');
    assert.equal(typeof windowMs, 'number');
    assert.ok(windowMs > 0);

    const stats = aggregate(fx.cwd, { windowMs });
    const byName = new Map(stats.perMemory.map((m) => [m.name, m]));
    assert.equal(byName.get('mem-influencer').cited, 5);
    assert.equal(byName.get('mem-influencer').fired, 5);
    assert.equal(byName.get('mem-noise').fired, 10);
    assert.equal(byName.get('mem-noise').cited, 0);

    const out = formatSections(stats, { color: false });
    assert.match(out, /Top influencers[\s\S]*mem-influencer/);
    assert.match(out, /Noise candidates[\s\S]*mem-noise/);
    assert.match(out, /Never-fired[\s\S]*mem-quiet/);
    // mem-quiet must not appear in Top influencers
    const topSection = out.split(/Noise candidates/)[0];
    assert.ok(!/mem-quiet/.test(topSection), 'mem-quiet should not appear in Top influencers');
  } finally {
    fx.cleanup();
  }
});

test('synapsys:stats honors --last 30d window', () => {
  assert.ok(helpers, 'synapsys-stats.js must export pure helpers');
  const { parseWindow, aggregate } = helpers;

  const fx = makeFixture();
  try {
    writeMemoryFile(fx.storeDir, 'mem-old');

    const oldTs = Date.now() - 1000 * 60 * 60 * 24 * 20; // 20 days ago
    const oldFile = path.join(fx.telDir, 'old-session.jsonl');
    writeJsonl(oldFile, [
      { ts: new Date(oldTs).toISOString(), memory: 'mem-old', event: 'fired' },
      { ts: new Date(oldTs).toISOString(), memory: 'mem-old', event: 'cited', match: 'm' },
    ]);
    // Force mtime to 20 days ago so window filter sees it correctly.
    fs.utimesSync(oldFile, new Date(oldTs), new Date(oldTs));

    const stats7 = aggregate(fx.cwd, { windowMs: parseWindow('7d') });
    const found7 = stats7.perMemory.find((m) => m.name === 'mem-old');
    assert.ok(!found7 || (found7.fired === 0 && found7.cited === 0), '7d window must exclude 20-day-old file');

    const stats30 = aggregate(fx.cwd, { windowMs: parseWindow('30d') });
    const found30 = stats30.perMemory.find((m) => m.name === 'mem-old');
    assert.ok(found30, '30d window must include 20-day-old file');
    assert.equal(found30.fired, 1);
    assert.equal(found30.cited, 1);
  } finally {
    fx.cleanup();
  }
});

// PR #524 cursor[bot] Medium — Stop-only memories must NOT appear in Noise candidates
// even when they hit fired >= 10 with cited == 0 (they fire on every assistant turn
// by design; the "tighten triggers" advice does not apply).
test('synapsys:stats excludes Stop-only memories from Noise candidates', () => {
  assert.ok(helpers, 'synapsys-stats.js must export pure helpers');
  const { parseWindow, aggregate, formatSections } = helpers;

  const fx = makeFixture();
  try {
    // Stop-only memory — declares only the Stop event.
    fs.writeFileSync(
      path.join(fx.storeDir, 'stop-only-mem.md'),
      ['---', 'name: stop-only-mem', 'description: x', 'events: Stop',
       'trigger_session: true', '---', ''].join('\n')
    );
    // Multi-event noise memory — fires on UserPromptSubmit AND Stop.
    fs.writeFileSync(
      path.join(fx.storeDir, 'real-noise.md'),
      ['---', 'name: real-noise', 'description: x', 'events: [UserPromptSubmit, Stop]',
       'trigger_prompt: x', '---', ''].join('\n')
    );

    const now = Date.now();
    const lines = [];
    for (let i = 0; i < 15; i++) {
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'stop-only-mem', event: 'fired' });
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'real-noise', event: 'fired' });
    }
    writeJsonl(path.join(fx.telDir, 'session-1.jsonl'), lines);

    const stats = aggregate(fx.cwd, { windowMs: parseWindow('7d') });
    const out = formatSections(stats, { color: false });

    const noiseSection = out.split(/Noise candidates/)[1].split(/Never-fired/)[0];
    assert.ok(!/stop-only-mem/.test(noiseSection), 'stop-only-mem must NOT appear in Noise candidates');
    assert.ok(/real-noise/.test(noiseSection), 'real-noise (multi-event) should still be flagged');
  } finally {
    fx.cleanup();
  }
});

// PR #524 cursor[bot] Medium — sections must restrict to memories discovered via --cwd.
// Other-project / deleted memories must NOT appear in Top influencers or Noise candidates
// just because their events were written to the global telemetry directory.
test('synapsys:stats excludes unknown (other-project/deleted) memories from Top and Noise', () => {
  assert.ok(helpers, 'synapsys-stats.js must export pure helpers');
  const { parseWindow, aggregate, formatSections } = helpers;

  const fx = makeFixture();
  try {
    // Only one memory is discoverable via fx.cwd's store.
    writeMemoryFile(fx.storeDir, 'known-mem');

    const now = Date.now();
    const lines = [];
    // Known memory: looks like a top-influencer.
    for (let i = 0; i < 3; i++) {
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'known-mem', event: 'fired' });
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'known-mem', event: 'cited', match: 'x' });
    }
    // UNKNOWN memory (from another project): high fired + cited.
    for (let i = 0; i < 4; i++) {
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'other-project-influencer', event: 'fired' });
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'other-project-influencer', event: 'cited', match: 'y' });
    }
    // UNKNOWN memory: high fired, zero cited — would otherwise be flagged noise.
    for (let i = 0; i < 12; i++) {
      lines.push({ ts: new Date(now - 1000 * i).toISOString(), memory: 'other-project-noise', event: 'fired' });
    }
    writeJsonl(path.join(fx.telDir, 'cross-project.jsonl'), lines);

    const out = formatSections(aggregate(fx.cwd, { windowMs: parseWindow('7d') }), { color: false });
    const topSection = out.split(/Noise candidates/)[0];
    const noiseSection = out.split(/Noise candidates/)[1].split(/Never-fired/)[0];

    assert.match(topSection, /known-mem/);
    assert.ok(!/other-project-influencer/.test(topSection),
      'other-project memory must NOT appear in Top influencers');
    assert.ok(!/other-project-noise/.test(noiseSection),
      'other-project memory must NOT appear in Noise candidates');
  } finally {
    fx.cleanup();
  }
});
