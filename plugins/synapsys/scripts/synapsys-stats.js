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

const { fs, path, setupCli, discoverStores, listMemoriesFromStore } = require(
  require('node:path').join(__dirname, '..', 'lib', 'script-bootstrap')
);
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
  // Skip DOUBLE-underscore sidecars (e.g. `__session-rotations.jsonl`) — those
  // store cross-session instrumentation rows that do NOT follow the per-memory
  // event schema and would crash or skew stats if parsed as memory events.
  // Single-underscore names like `_unknown-session.jsonl` (legitimate fallback
  // bucket from telemetry.resolveSessionId) and any session id starting with
  // `_` (allowed by SAFE_ID_RE) ARE real telemetry data and stay in scope.
  // See session-id-rotation.js::rotationsFile for the convention.
  return entries
    .filter((n) => n.endsWith('.jsonl') && !n.startsWith('__'))
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
  const c = counts.get(ev.memory) || { fired: 0, cited: 0, changed: 0 };
  if (ev.event === 'fired') c.fired += 1;
  else if (ev.event === 'cited') c.cited += 1;
  else if (ev.event === 'behavior_changed') c.changed += 1;
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
    if (!counts.has(name)) counts.set(name, { fired: 0, cited: 0, changed: 0 });
  }

  const perMemory = Array.from(counts.entries()).map(([name, c]) => ({
    name,
    fired: c.fired,
    cited: c.cited,
    changed: c.changed || 0,
    known: known.has(name),
    stopOnly: stopOnly.has(name),
  }));

  return { perMemory, known: Array.from(known) };
}

function formatBehaviorChangers(perMemory) {
  // Include any known memory with at least one behavior_changed event, even
  // when fired is 0 in this window — a Stop self-report can land a `changed`
  // row without a paired `fired` row (the trigger fired in a prior window or
  // the cite scan ran without a matcher hit). Without this, those memories
  // appear in NO section: Behavior-changers excluded them on fired:0 and
  // Never-fired excludes them on changed>0.
  const changers = perMemory
    .filter((m) => m.known && (m.changed || 0) > 0)
    .map((m) => ({ ...m, ratio: m.fired > 0 ? m.changed / m.fired : Infinity }))
    .sort((a, b) => {
      if (b.ratio !== a.ratio) return b.ratio - a.ratio;
      return b.changed - a.changed;
    });
  const lines = [];
  lines.push('Behavior-changers (sorted by changed/fired ratio):');
  lines.push('  name   fired   cited   changed   verdict');
  if (changers.length === 0) lines.push('  (none)');
  for (const m of changers) {
    const verdict = m.ratio >= 0.5 ? 'keep' : 'review';
    lines.push(
      `  ${m.name}   fired:${m.fired}   cited:${m.cited}   changed:${m.changed}   ${verdict}`
    );
  }
  return lines;
}

function selectTopInfluencers(perMemory) {
  return perMemory
    .filter((m) => m.known && m.cited > 0)
    .sort((a, b) => {
      if (b.cited !== a.cited) return b.cited - a.cited;
      return b.fired * b.cited - a.fired * a.cited;
    });
}

function selectNoiseCandidates(perMemory) {
  // Stop-only memories fire on every assistant turn by design; the
  // "tighten triggers" advice does not apply to them, so they're excluded
  // from noise classification regardless of fired count.
  return perMemory
    .filter(
      (m) =>
        m.known &&
        !m.stopOnly &&
        m.fired >= NOISE_FIRED_THRESHOLD &&
        m.cited === 0 &&
        m.changed === 0
    )
    .sort((a, b) => b.fired - a.fired);
}

function selectNeverFired(perMemory) {
  // Exclude memories with behavior_changed telemetry — a memory that changed
  // behavior at least once is not "never fired" even if no `fired` row exists
  // (Stop self-report can land a `changed` event without a paired fire).
  return perMemory
    .filter((m) => m.known && m.fired === 0 && m.cited === 0 && m.changed === 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatTopSection(top) {
  const lines = ['Top influencers (fired × cited):'];
  if (top.length === 0) lines.push('  (none)');
  for (const m of top) {
    const ratio = m.fired === 0 ? 0 : (m.cited / m.fired).toFixed(2);
    lines.push(`  ${m.name}   fired:${m.fired}  cited:${m.cited}  influence:${ratio}  keep`);
  }
  return lines;
}

function formatNoiseSection(noise) {
  const lines = ['Noise candidates (fired ≥10, cited:0):'];
  if (noise.length === 0) lines.push('  (none)');
  for (const m of noise) {
    lines.push(`  ${m.name}   fired:${m.fired}  cited:${m.cited}  narrow trigger or delete`);
  }
  return lines;
}

function formatNeverSection(never) {
  const lines = ['Never-fired (consider deletion or session-start docs instead):'];
  if (never.length === 0) lines.push('  (none)');
  for (const m of never) {
    lines.push(`  ${m.name}   fired:0  cited:0`);
  }
  return lines;
}

function formatSections(stats, { color = false, changersOnly = false } = {}) {
  const { perMemory } = stats;
  void color;

  if (changersOnly) {
    return formatBehaviorChangers(perMemory).join('\n') + '\n';
  }

  // All three sections must restrict to memories discovered via --cwd
  // (`m.known`). The global ~/.claude/synapsys/.telemetry/ aggregates events
  // from every project, so without this filter Top influencers and Noise
  // candidates would surface deleted or other-project memories that the
  // current store no longer (or never) owned.
  const lines = [
    ...formatTopSection(selectTopInfluencers(perMemory)),
    '',
    ...formatNoiseSection(selectNoiseCandidates(perMemory)),
    '',
    ...formatNeverSection(selectNeverFired(perMemory)),
    '',
    ...formatBehaviorChangers(perMemory),
  ];
  return lines.join('\n') + '\n';
}

function main() {
  const { flag, cwd } = setupCli();
  const windowMs = parseWindow(flag('last') || '7d');
  const useColor = !flag('no-color');
  const changersOnly = !!flag('changers-only');
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
    process.stdout.write(formatSections(stats, { color: useColor, changersOnly }));
  }
  process.exit(0);
}

module.exports = {
  parseWindow,
  readJsonlInWindow,
  aggregate,
  formatSections,
  listJsonlFiles,
};

if (require.main === module) {
  main();
}
