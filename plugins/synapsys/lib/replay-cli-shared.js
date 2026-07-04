'use strict';

/**
 * Shared CLI plumbing for the replay-family scripts (synapsys-replay,
 * synapsys-replay-next, synapsys-explain): flag parsing, store selection by
 * kind/path, and memory loading. Extracted to satisfy the duplicate-blocks
 * quality gate after GH-517 split the replay entrypoint into an alias + a
 * phase-next runner.
 */

const fs = require('node:fs');
const path = require('node:path');
const { makeFlag } = require(path.join(__dirname, 'cli-args'));
const memoryStore = require(path.join(__dirname, 'memory-store'));

/**
 * Pure flag parser shared by synapsys-replay (which ignores `runDir`) and
 * synapsys-replay-next. No I/O, no process exits.
 */
function parseReplayFlags(argv) {
  const flag = makeFlag(argv);
  const sinceRaw = flag('since');
  const maxJudgesRaw = flag('max-judges');
  return {
    since: sinceRaw === undefined || sinceRaw === true ? '7d' : sinceRaw,
    project: typeof flag('project') === 'string' ? flag('project') : undefined,
    noJudge: flag('no-judge') === true,
    json: flag('json') === true,
    only: typeof flag('only') === 'string' ? flag('only') : undefined,
    store: typeof flag('store') === 'string' ? flag('store') : undefined,
    maxJudges: maxJudgesRaw === undefined || maxJudgesRaw === true ? 200 : Number(maxJudgesRaw),
    allProjects: flag('all-projects') === true,
    transcriptsBase:
      typeof flag('transcripts-base') === 'string' ? flag('transcripts-base') : undefined,
    runDir: typeof flag('run-dir') === 'string' ? flag('run-dir') : undefined,
  };
}

/**
 * Resolve the store selection for a `--store` flag: all discovered stores when
 * unset, else match by kind name, then by absolute path, then accept a bare
 * directory carrying a `.synapsys.json` marker. Returns `null` when the flag
 * names nothing (callers decide whether that's a die() or an empty run).
 */
function selectStores(storeFlag, cwd) {
  const stores = memoryStore.discoverStores(cwd || process.cwd());
  if (!storeFlag || storeFlag === true) return stores;
  const byKind = stores.filter((s) => s.kind === storeFlag);
  if (byKind.length) return byKind;
  const abs = path.resolve(storeFlag);
  const byPath = stores.filter((s) => path.resolve(s.dir) === abs);
  if (byPath.length) return byPath;
  if (fs.existsSync(path.join(abs, '.synapsys.json'))) {
    return [{ kind: 'path', dir: abs, projectName: path.basename(abs) }];
  }
  return null;
}

/**
 * Flatten memories across stores. `skipErrors` preserves the phase-next
 * runner's fail-open per-store behavior; the interactive CLIs propagate.
 */
function loadMemories(stores, { skipErrors = false } = {}) {
  const all = [];
  for (const s of stores) {
    if (skipErrors) {
      try {
        all.push(...memoryStore.listMemoriesFromStore(s));
      } catch {
        /* skip unreadable store */
      }
    } else {
      all.push(...memoryStore.listMemoriesFromStore(s));
    }
  }
  return all;
}

module.exports = { parseReplayFlags, selectStores, loadMemories };
