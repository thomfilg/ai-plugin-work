/**
 * Unit tests for loader: discovery, validation, error isolation, .ts skip, path-traversal hardening.
 * Covers Task 3 acceptance criteria (R3, R6, R8, G1, G2, G4, G8).
 *
 * Run with:
 *   node --test plugins/work/scripts/workflows/work/lib/extensions/__tests__/loader.test.js
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOADER_PATH = path.resolve(__dirname, '..', 'loader.js');
const EVENT_BUS_PATH = path.resolve(__dirname, '..', 'event-bus.js');

function loadLoader() {
  delete require.cache[require.resolve(LOADER_PATH)];
  return require(LOADER_PATH);
}

function loadBus() {
  delete require.cache[require.resolve(EVENT_BUS_PATH)];
  return require(EVENT_BUS_PATH);
}

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
  const tasksDir = path.join(root, 'tasks', 'GH-522');
  fs.mkdirSync(tasksDir, { recursive: true });
  return { root, tasksDir };
}

function makeExtensionsDir(repoRoot) {
  const extDir = path.join(repoRoot, '.claude', 'work-extensions');
  fs.mkdirSync(extDir, { recursive: true });
  return extDir;
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

describe('loader', () => {
  let tmpDirs = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs = [];
  });

  describe('No extensions directory — backward compatibility (G1, R8)', () => {
    it('returns empty status and logs "no extensions directory; skipping" when dir missing', () => {
      const { root, tasksDir } = makeTempRepo();
      tmpDirs.push(root);
      const bus = loadBus();
      const { loadExtensions } = loadLoader();

      const { stderr } = captureStderr(() => {
        const status = loadExtensions({ repoRoot: root, tasksDir, bus });
        assert.ok(Array.isArray(status), 'status must be an array');
        assert.equal(status.length, 0, 'status must be empty when no dir');
      });

      // Either via debug log or stderr — the message must appear somewhere observable.
      const debugPath = path.join(tasksDir, 'debug.md');
      const debugContent = fs.existsSync(debugPath) ? fs.readFileSync(debugPath, 'utf8') : '';
      const combined = stderr + debugContent;
      assert.match(combined, /no extensions directory; skipping/i);
    });
  });

  describe('Valid extension is discovered and registered (G2)', () => {
    it('loads a .js extension with {events, handler} and registers against the bus', () => {
      const { root, tasksDir } = makeTempRepo();
      tmpDirs.push(root);
      const extDir = makeExtensionsDir(root);

      fs.writeFileSync(
        path.join(extDir, 'sample.js'),
        `module.exports = {
           events: ['OnTicketResolved'],
           handler: function(payload, ctx) { return 'ok'; },
           priority: 75,
         };`
      );

      const bus = loadBus();
      const { loadExtensions } = loadLoader();
      const status = loadExtensions({ repoRoot: root, tasksDir, bus });

      assert.equal(status.length, 1);
      assert.equal(status[0].loaded, true);
      assert.deepEqual(status[0].events, ['OnTicketResolved']);
      assert.match(status[0].file, /sample\.js$/);

      const handlers = bus.listHandlers('OnTicketResolved');
      assert.equal(handlers.length, 1);
      assert.equal(handlers[0].priority, 75);
    });
  });

  describe('Broken extension at load time does not crash /work (G4, R6)', () => {
    it('catches require() throw, logs error, emits stderr warn, and continues', () => {
      const { root, tasksDir } = makeTempRepo();
      tmpDirs.push(root);
      const extDir = makeExtensionsDir(root);

      fs.writeFileSync(path.join(extDir, 'broken.js'), `throw new Error('kaboom at load');`);
      fs.writeFileSync(
        path.join(extDir, 'good.js'),
        `module.exports = { events: ['OnSessionStart'], handler: () => {} };`
      );

      const bus = loadBus();
      const { loadExtensions } = loadLoader();

      let status;
      const { stderr } = captureStderr(() => {
        status = loadExtensions({ repoRoot: root, tasksDir, bus });
      });

      const broken = status.find((s) => /broken\.js$/.test(s.file));
      const good = status.find((s) => /good\.js$/.test(s.file));
      assert.ok(broken, 'broken entry present');
      assert.equal(broken.loaded, false);
      assert.match(broken.error || '', /kaboom/);
      assert.ok(good, 'good entry present');
      assert.equal(good.loaded, true);

      // Stderr warn emission
      assert.match(stderr, /kaboom|broken\.js/);

      // Debug log error emission
      const debugPath = path.join(tasksDir, 'debug.md');
      const debugContent = fs.existsSync(debugPath) ? fs.readFileSync(debugPath, 'utf8') : '';
      assert.match(debugContent + stderr, /broken\.js/);

      // The good extension is still registered
      assert.equal(bus.listHandlers('OnSessionStart').length, 1);
    });
  });

  describe('.ts extension files are detected and skipped in Phase 1 (G8)', () => {
    it('skips .ts files with warning "Phase 1 supports .js only" referencing the file', () => {
      const { root, tasksDir } = makeTempRepo();
      tmpDirs.push(root);
      const extDir = makeExtensionsDir(root);

      fs.writeFileSync(path.join(extDir, 'typed.ts'), `export const x = 1;`);

      const bus = loadBus();
      const { loadExtensions } = loadLoader();

      let status;
      const { stderr } = captureStderr(() => {
        status = loadExtensions({ repoRoot: root, tasksDir, bus });
      });

      const ts = status.find((s) => /typed\.ts$/.test(s.file));
      assert.ok(ts, 'ts file appears in status');
      assert.equal(ts.loaded, false);

      const debugPath = path.join(tasksDir, 'debug.md');
      const debugContent = fs.existsSync(debugPath) ? fs.readFileSync(debugPath, 'utf8') : '';
      const combined = stderr + debugContent;
      assert.match(combined, /Phase 1 supports \.js only/);
      assert.match(combined, /typed\.ts/);
    });
  });

  describe('Invalid export shape — validation', () => {
    it('skips files missing events or handler with a logged validation error', () => {
      const { root, tasksDir } = makeTempRepo();
      tmpDirs.push(root);
      const extDir = makeExtensionsDir(root);

      fs.writeFileSync(
        path.join(extDir, 'no-events.js'),
        `module.exports = { handler: () => {} };`
      );
      fs.writeFileSync(
        path.join(extDir, 'no-handler.js'),
        `module.exports = { events: ['OnSessionStart'] };`
      );

      const bus = loadBus();
      const { loadExtensions } = loadLoader();

      let status;
      const { stderr } = captureStderr(() => {
        status = loadExtensions({ repoRoot: root, tasksDir, bus });
      });

      const noEv = status.find((s) => /no-events\.js$/.test(s.file));
      const noH = status.find((s) => /no-handler\.js$/.test(s.file));
      assert.equal(noEv.loaded, false);
      assert.equal(noH.loaded, false);
      assert.match((noEv.error || '') + stderr, /events/i);
      assert.match((noH.error || '') + stderr, /handler/i);

      // Nothing registered
      assert.equal(bus.listHandlers('OnSessionStart').length, 0);
    });
  });

  describe('Path-traversal hardening', () => {
    it('rejects symlinks whose realpath escapes the extensions directory', () => {
      const { root, tasksDir } = makeTempRepo();
      tmpDirs.push(root);
      const extDir = makeExtensionsDir(root);

      // Create a real file outside the extensions dir
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, 'evil.js');
      fs.writeFileSync(outsideFile, `module.exports = { events: ['OnPwn'], handler: () => {} };`);

      // Symlink inside extensions dir → outside file
      const linkPath = path.join(extDir, 'evil.js');
      try {
        fs.symlinkSync(outsideFile, linkPath);
      } catch (err) {
        // If symlinks not supported (rare on CI), skip the assertion path
        return;
      }

      const bus = loadBus();
      const { loadExtensions } = loadLoader();

      let status;
      const { stderr } = captureStderr(() => {
        status = loadExtensions({ repoRoot: root, tasksDir, bus });
      });

      const evil = status.find((s) => /evil\.js$/.test(s.file));
      assert.ok(evil, 'evil symlink appears in status');
      assert.equal(evil.loaded, false, 'symlink escaping ext dir must be rejected');

      const debugPath = path.join(tasksDir, 'debug.md');
      const debugContent = fs.existsSync(debugPath) ? fs.readFileSync(debugPath, 'utf8') : '';
      assert.match(stderr + debugContent, /path|traversal|outside|realpath/i);

      // Handler must NOT be registered
      assert.equal(bus.listHandlers('OnPwn').length, 0);
    });
  });
});
