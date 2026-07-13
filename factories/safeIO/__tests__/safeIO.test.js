'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readFileSafe, readJsonSafe, writeFileAtomic, writeJsonAtomic } = require('../safeIO');

const isWindows = process.platform === 'win32';
// root reads chmod-000 files anyway, which would invalidate the unreadable-file cases
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('safeIO', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeio-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const tmpResidue = (where) => fs.readdirSync(where).filter((f) => f.endsWith('.tmp'));

  describe('readFileSafe', () => {
    it('returns file content as utf8', () => {
      const p = path.join(dir, 'a.txt');
      fs.writeFileSync(p, 'héllo\n');
      assert.equal(readFileSafe(p), 'héllo\n');
    });

    it('returns null by default when the file is missing', () => {
      assert.equal(readFileSafe(path.join(dir, 'nope.txt')), null);
    });

    it('returns the given fallback when the file is missing', () => {
      assert.equal(readFileSafe(path.join(dir, 'nope.txt'), ''), '');
    });

    it('returns the fallback when the path is a directory', () => {
      assert.equal(readFileSafe(dir, 'dir-fallback'), 'dir-fallback');
    });

    it('returns the fallback when the file is unreadable', { skip: isWindows || isRoot }, () => {
      const p = path.join(dir, 'locked.txt');
      fs.writeFileSync(p, 'secret');
      fs.chmodSync(p, 0o000);
      assert.equal(readFileSafe(p, 'denied'), 'denied');
    });
  });

  describe('readJsonSafe', () => {
    it('parses valid JSON', () => {
      const p = path.join(dir, 'a.json');
      fs.writeFileSync(p, '{"n": 7}');
      assert.deepEqual(readJsonSafe(p), { n: 7 });
    });

    it('returns {} by default when the file is missing', () => {
      assert.deepEqual(readJsonSafe(path.join(dir, 'nope.json')), {});
    });

    it('returns the given fallback on malformed JSON', () => {
      const p = path.join(dir, 'bad.json');
      fs.writeFileSync(p, '{"n": 7'); // truncated
      assert.equal(readJsonSafe(p, null), null);
    });

    it('returns the fallback when the file is unreadable', { skip: isWindows || isRoot }, () => {
      const p = path.join(dir, 'locked.json');
      fs.writeFileSync(p, '{"n": 7}');
      fs.chmodSync(p, 0o000);
      assert.deepEqual(readJsonSafe(p, { fell: 'back' }), { fell: 'back' });
    });
  });

  describe('writeFileAtomic', () => {
    it('throws TypeError on a missing path', () => {
      assert.throws(() => writeFileAtomic('', 'x'), new TypeError('safeIO: missing "path"'));
      assert.throws(() => writeFileAtomic(null, 'x'), TypeError);
    });

    it('writes complete text and creates parent directories', () => {
      const p = path.join(dir, 'deep', 'nested', 'out.txt');
      writeFileAtomic(p, 'line1\nline2\n');
      assert.equal(fs.readFileSync(p, 'utf8'), 'line1\nline2\n');
    });

    it('overwrites an existing target (direct atomic rename)', () => {
      const p = path.join(dir, 'out.txt');
      writeFileAtomic(p, 'old content that is longer');
      writeFileAtomic(p, 'new');
      assert.equal(fs.readFileSync(p, 'utf8'), 'new');
    });

    it('leaves zero .tmp residue after success', () => {
      const p = path.join(dir, 'out.txt');
      writeFileAtomic(p, 'once');
      writeFileAtomic(p, 'twice');
      assert.deepEqual(tmpResidue(dir), []);
    });

    it('applies the default mode 0o600', { skip: isWindows }, () => {
      const p = path.join(dir, 'out.txt');
      writeFileAtomic(p, 'x');
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    });

    it('applies an explicit opts.mode', { skip: isWindows }, () => {
      const p = path.join(dir, 'out.txt');
      writeFileAtomic(p, 'x', { mode: 0o644 });
      const umask = process.umask();
      assert.equal(fs.statSync(p).mode & 0o777, 0o644 & ~umask);
    });

    it('on rename failure removes the tmp file and rethrows', () => {
      const target = path.join(dir, 'blocked');
      // rename(file, existing dir) throws — EISDIR/ENOTDIR/EEXIST depending
      // on platform, so only "an error is thrown" is asserted here.
      fs.mkdirSync(target);
      assert.throws(() => writeFileAtomic(target, 'x'));
      assert.equal(fs.existsSync(`${target}.${process.pid}.tmp`), false);
      assert.deepEqual(tmpResidue(dir), []);
      assert.ok(fs.statSync(target).isDirectory(), 'target directory left untouched');
    });

    it('on tmp write failure rethrows the ORIGINAL error and leaves the target untouched', () => {
      const target = path.join(dir, 'victim.txt');
      fs.writeFileSync(target, 'pre-existing');
      const tmp = `${target}.${process.pid}.tmp`;
      // A directory at the exact tmp path makes writeFileSync(tmp) throw
      // (EISDIR on POSIX). The cleanup unlink of that directory ALSO throws
      // (rmdir semantics) — it must be swallowed so the write error wins.
      fs.mkdirSync(tmp);
      let thrown = null;
      try {
        writeFileAtomic(target, 'x');
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Error, 'the tmp write failure must propagate');
      assert.equal(thrown.syscall, 'open', 'the write error propagates, not the cleanup unlink');
      assert.equal(fs.readFileSync(target, 'utf8'), 'pre-existing', 'target untouched');
      assert.ok(fs.statSync(tmp).isDirectory(), 'blocking directory still present');
    });

    it('removes a partially written tmp file when the write itself fails', (t) => {
      const target = path.join(dir, 'out.txt');
      const realWrite = fs.writeFileSync.bind(fs);
      t.mock.method(fs, 'writeFileSync', (p, data, opts) => {
        realWrite(p, 'partial', opts); // the tmp file lands half-written…
        const err = new Error('no space left on device, write'); // …then ENOSPC
        err.code = 'ENOSPC';
        throw err;
      });
      assert.throws(() => writeFileAtomic(target, 'full payload'), /no space left/);
      assert.deepEqual(tmpResidue(dir), [], 'partial tmp removed');
      assert.equal(fs.existsSync(target), false, 'target never created');
    });
  });

  describe('atomic overwrite under a concurrent reader', () => {
    it('a tight-loop reader observes zero ENOENT and only complete payloads', async () => {
      const target = path.join(dir, 'hot.json');
      const stopFile = path.join(dir, 'stop');
      const readyFile = path.join(dir, 'ready');
      const payloadA = JSON.stringify({ gen: 'A', fill: 'a'.repeat(2048) });
      const payloadB = JSON.stringify({ gen: 'B', fill: 'b'.repeat(2048) });
      writeFileAtomic(target, payloadA);

      // Reader child: reads at least 2000 times, then keeps reading until the
      // writer drops the stop file (hard cap keeps the test bounded).
      const readerSrc = [
        "'use strict';",
        "const fs = require('fs');",
        'const [target, stopFile, readyFile] = process.argv.slice(1);',
        "const A = JSON.stringify({ gen: 'A', fill: 'a'.repeat(2048) });",
        "const B = JSON.stringify({ gen: 'B', fill: 'b'.repeat(2048) });",
        "fs.writeFileSync(readyFile, '');",
        'let reads = 0, enoent = 0, otherErr = 0, torn = 0;',
        'while (reads < 2000 || (!fs.existsSync(stopFile) && reads < 200000)) {',
        '  reads += 1;',
        '  try {',
        "    const content = fs.readFileSync(target, 'utf8');",
        '    if (content !== A && content !== B) torn += 1;',
        '  } catch (err) {',
        "    if (err.code === 'ENOENT') enoent += 1; else otherErr += 1;",
        '  }',
        '}',
        'process.stdout.write(JSON.stringify({ reads, enoent, otherErr, torn }));',
      ].join('\n');
      const reader = spawn(process.execPath, ['-e', readerSrc, target, stopFile, readyFile], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      reader.stdout.on('data', (chunk) => {
        out += chunk;
      });

      // spawn() forks at call time, so this sync handshake wait is safe.
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(readyFile) && Date.now() < deadline) {
        /* busy-wait for reader startup */
      }
      assert.ok(fs.existsSync(readyFile), 'reader child failed to start in time');

      for (let i = 0; i < 3000; i += 1) {
        writeFileAtomic(target, i % 2 === 0 ? payloadB : payloadA);
      }
      fs.writeFileSync(stopFile, '');

      const code = await new Promise((resolve) => reader.on('close', resolve));
      assert.equal(code, 0, `reader exited ${code}: ${out}`);
      const stats = JSON.parse(out);
      assert.ok(stats.reads >= 2000, `reader barely ran: ${out}`);
      assert.equal(stats.enoent, 0, `missing-file reads observed: ${out}`);
      assert.equal(stats.otherErr, 0, `unexpected read errors: ${out}`);
      assert.equal(stats.torn, 0, `incomplete payloads observed: ${out}`);
    });
  });

  describe('writeJsonAtomic', () => {
    it('writes pretty JSON by default and target parses cleanly after overwrite', () => {
      const p = path.join(dir, 'state.json');
      writeJsonAtomic(p, { first: true });
      writeJsonAtomic(p, { second: [1, 2, 3] });
      const raw = fs.readFileSync(p, 'utf8');
      assert.equal(raw, JSON.stringify({ second: [1, 2, 3] }, null, 2));
      assert.deepEqual(JSON.parse(raw), { second: [1, 2, 3] });
      assert.deepEqual(tmpResidue(dir), []);
    });

    it('writes compact JSON when opts.compact === true', () => {
      const p = path.join(dir, 'state.json');
      writeJsonAtomic(p, { a: 1, b: [2] }, { compact: true });
      assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1,"b":[2]}');
    });

    it('applies the default mode 0o600', { skip: isWindows }, () => {
      const p = path.join(dir, 'state.json');
      writeJsonAtomic(p, {});
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    });

    it('forwards opts.mode', { skip: isWindows }, () => {
      const p = path.join(dir, 'state.json');
      writeJsonAtomic(p, {}, { mode: 0o644 });
      assert.equal(fs.statSync(p).mode & 0o777, 0o644 & ~process.umask());
    });

    it('throws TypeError on a missing path', () => {
      assert.throws(() => writeJsonAtomic(undefined, {}), new TypeError('safeIO: missing "path"'));
    });
  });

  describe('index re-export', () => {
    it('exposes the same four functions', () => {
      const idx = require('../index');
      assert.deepEqual(Object.keys(idx).sort(), [
        'readFileSafe',
        'readJsonSafe',
        'writeFileAtomic',
        'writeJsonAtomic',
      ]);
      assert.equal(idx.writeFileAtomic, writeFileAtomic);
    });
  });
});
