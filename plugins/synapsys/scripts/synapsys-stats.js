#!/usr/bin/env node
'use strict';

/**
 * synapsys:stats — aggregate per-memory telemetry from
 * `.telemetry/*.jsonl` files across discoverable stores and emit three
 * sections (Top influencers / Noise candidates / Never-fired) within
 * a time window selectable via `--last=<Nd>` (default `7d`).
 *
 * Pure helpers (parseWindow, readJsonlInWindow, aggregate, formatSections)
 * are exported for unit tests; CLI runs only when invoked directly.
 */

const {
  fs,
  path,
  setupCli,
  discoverStores,
  listMemoriesFromStore,
} = require(require('node:path').join(__dirname, '..', 'lib', 'script-bootstrap'));
const { telemetryDir } = require(require('node:path').join(__dirname, '..', 'lib', 'telemetry'));

const NOISE_FIRED_THRESHOLD = 10;

function parseWindow(spec) {
  const s = String(spec || '7d').trim();
  const m = s.match(/^(\d+)d$/i);
  const days = m ? parseInt(m[1], 10) : 7;
  return days * 24 * 60 * 60 * 1000;
}

function listJsonlFiles(telDir) {
  let entries;
  try {
    entries = fs.readdirSync(telDir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => path.join(telDir, n));
}

function readJsonlInWindow(file, cutoffMs) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (stat.mtimeMs < cutoffMs) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // malformed line — skip, fail-open
    }
  }
  return out;
}

function collectKnownMemoryNames(stores) {
  const known = new Set();
  for (const store of stores) {
    for (const mem of listMemoriesFromStore(store)) {
      if (mem && mem.name) known.add(mem.name);
    }
  }
  return known;
}

// Memories whose only event is Stop fire on every assistant turn by design,
// so they would otherwise dominate Noise candidates even when working as
// intended. Build a Set of their names so the noise filter can skip them.
function collectStopOnlyMemoryNames(stores) {
  const stopOnly = new Set();
  for (const store of stores) {
    for (const mem of listMemoriesFromStore(store)) {
      if (!mem || !mem.name || !Array.isArray(mem.events)) continue;
      const events = mem.events.filter((e) => typeof e === 'string' && e.length > 0);
      if (events.length === 1 && events[0] === 'Stop') stopOnly.add(mem.name);
    }
  }
  return stopOnly;
}

function tallyEvent(counts, ev) {
  if (!ev || !ev.memory || !ev.event) return;
  const c = counts.get(ev.memory) || { fired: 0, cited: 0 };
  if (ev.event === 'fired') c.fired += 1;
  else if (ev.event === 'cited') c.cited += 1;
  counts.set(ev.memory, c);
}

function aggregate(cwd, { windowMs }) {
  const cutoff = Date.now() - windowMs;
  const stores = discoverStores(cwd);
  const known = collectKnownMemoryNames(stores);
  const stopOnly = collectStopOnlyMemoryNames(stores);
  const counts = new Map(); // name → { fired, cited }

  for (const file of listJsonlFiles(telemetryDir())) {
    for (const ev of readJsonlInWindow(file, cutoff)) tallyEvent(counts, ev);
  }

  // Include zero-fire known memories so Never-fired can list them.
  for (const name of known) {
    if (!counts.has(name)) counts.set(name, { fired: 0, cited: 0 });
  }

  const perMemory = Array.from(counts.entries()).map(([name, c]) => ({
    name,
    fired: c.fired,
    cited: c.cited,
    known: known.has(name),
    stopOnly: stopOnly.has(name),
  }));

  return { perMemory, known: Array.from(known) };
}

function formatSections(stats, { color = false } = {}) {
  const { perMemory } = stats;

  // All three sections must restrict to memories discovered via --cwd
  // (`m.known`). The global ~/.claude/synapsys/.telemetry/ aggregates events
  // from every project, so without this filter Top influencers and Noise
  // candidates would surface deleted or other-project memories that the
  // current store no longer (or never) owned.
  const top = perMemory
    .filter((m) => m.known && m.cited > 0)
    .sort((a, b) => {
      if (b.cited !== a.cited) return b.cited - a.cited;
      return b.fired * b.cited - a.fired * a.cited;
    });

  // Stop-only memories fire on every assistant turn by design; the
  // "tighten triggers" advice does not apply to them, so they're excluded
  // from noise classification regardless of fired count.
  const noise = perMemory
    .filter((m) => m.known && !m.stopOnly && m.fired >= NOISE_FIRED_THRESHOLD && m.cited === 0)
    .sort((a, b) => b.fired - a.fired);

  const never = perMemory
    .filter((m) => m.known && m.fired === 0 && m.cited === 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines = [];
  lines.push('Top influencers (fired × cited):');
  if (top.length === 0) lines.push('  (none)');
  for (const m of top) {
    const ratio = m.fired === 0 ? 0 : (m.cited / m.fired).toFixed(2);
    lines.push(`  ${m.name}   fired:${m.fired}  cited:${m.cited}  influence:${ratio}  keep`);
  }
  lines.push('');
  lines.push('Noise candidates (fired ≥10, cited:0):');
  if (noise.length === 0) lines.push('  (none)');
  for (const m of noise) {
    lines.push(`  ${m.name}   fired:${m.fired}  cited:${m.cited}  narrow trigger or delete`);
  }
  lines.push('');
  lines.push('Never-fired (consider deletion or session-start docs instead):');
  if (never.length === 0) lines.push('  (none)');
  for (const m of never) {
    lines.push(`  ${m.name}   fired:0  cited:0`);
  }
  void color;
  return lines.join('\n') + '\n';
}

function main() {
  const { flag, cwd } = setupCli();
  const windowMs = parseWindow(flag('last') || '7d');
  const useColor = !flag('no-color');
  let stats;
  try {
    stats = aggregate(cwd, { windowMs });
  } catch (err) {
    process.stderr.write(`synapsys:stats: aggregation error: ${err.message}\n`);
    stats = { perMemory: [], known: [] };
  }
  if (flag('json')) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  } else {
    process.stdout.write(formatSections(stats, { color: useColor }));
  }
  process.exit(0);
}

module.exports = {
  parseWindow,
  readJsonlInWindow,
  aggregate,
  formatSections,
};

if (require.main === module) {
  main();
}
