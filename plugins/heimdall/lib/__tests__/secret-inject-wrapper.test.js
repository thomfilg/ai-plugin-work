// Unit tests for the Heimdall CLI command-injection wrapper.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/secret-inject-wrapper.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WRAPPER = path.resolve(__dirname, '..', '..', 'scripts', 'secret-inject-wrapper.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-inject-'));
}

// Run the wrapper with the owner-check skipped (the map is a tmp file, not root).
function run(name, args, commandsJson, extraEnv = {}) {
  return spawnSync('node', [WRAPPER, name, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HEIMDALL_TEST_SKIP_OWNER_CHECK: '1',
      HEIMDALL_COMMANDS_JSON: commandsJson,
      ...extraEnv,
    },
  });
}

// Write a stub "command" that echoes its args + selected env vars.
function stubCommand(dir, body) {
  const exec = path.join(dir, 'cmd.sh');
  fs.writeFileSync(exec, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(exec, 0o755);
  return exec;
}

describe('secret-inject-wrapper', () => {
  it('runs the mapped command with the secret in env + forwarded args', () => {
    const dir = tmp();
    const exec = stubCommand(dir, 'echo "ARGS:$*"; echo "KEY:$MY_SECRET"');
    const secrets = path.join(dir, '.secrets');
    fs.writeFileSync(secrets, '# a comment\nexport MY_SECRET=s3cr3t\nOTHER="q u o t e d"\n');
    const map = path.join(dir, 'commands.json');
    fs.writeFileSync(map, JSON.stringify({ myc: { exec, secretsFile: secrets } }));

    const res = run('myc', ['--task=x', 'ATTEMPTS=2'], map);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ARGS:--task=x ATTEMPTS=2/);
    assert.match(res.stdout, /KEY:s3cr3t/);
  });

  it('strips quotes from secret values', () => {
    const dir = tmp();
    const exec = stubCommand(dir, 'echo "V:[$OTHER]"');
    const secrets = path.join(dir, '.secrets');
    fs.writeFileSync(secrets, 'OTHER="hello world"\n');
    const map = path.join(dir, 'commands.json');
    fs.writeFileSync(map, JSON.stringify({ c: { exec, secretsFile: secrets } }));
    const res = run('c', [], map);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /V:\[hello world\]/);
  });

  it('passes the broker HEIMDALL_CALLER_UID through to the command', () => {
    const dir = tmp();
    const exec = stubCommand(dir, 'echo "UID:$HEIMDALL_CALLER_UID"');
    const secrets = path.join(dir, '.secrets');
    fs.writeFileSync(secrets, 'K=v\n');
    const map = path.join(dir, 'commands.json');
    fs.writeFileSync(map, JSON.stringify({ c: { exec, secretsFile: secrets } }));
    const res = run('c', [], map, { HEIMDALL_CALLER_UID: '4242' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /UID:4242/);
  });

  it('broker env wins over a secrets file forging HEIMDALL_CALLER_UID', () => {
    const dir = tmp();
    const exec = stubCommand(dir, 'echo "UID:$HEIMDALL_CALLER_UID"; echo "SECRET:$MY_KEY"');
    const secrets = path.join(dir, '.secrets');
    // A hostile secrets file tries to forge the trusted caller identity.
    fs.writeFileSync(secrets, 'HEIMDALL_CALLER_UID=0\nMY_KEY=real\n');
    const map = path.join(dir, 'commands.json');
    fs.writeFileSync(map, JSON.stringify({ c: { exec, secretsFile: secrets } }));
    const res = run('c', [], map, { HEIMDALL_CALLER_UID: '4242' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /UID:4242/); // broker value, NOT the forged 0
    assert.match(res.stdout, /SECRET:real/); // legit secret still injected
  });

  it('propagates the command exit code', () => {
    const dir = tmp();
    const exec = stubCommand(dir, 'exit 7');
    const secrets = path.join(dir, '.secrets');
    fs.writeFileSync(secrets, 'K=v\n');
    const map = path.join(dir, 'commands.json');
    fs.writeFileSync(map, JSON.stringify({ c: { exec, secretsFile: secrets } }));
    assert.equal(run('c', [], map).status, 7);
  });

  it('rejects an unknown command name (the agent cannot run arbitrary execs)', () => {
    const dir = tmp();
    const map = path.join(dir, 'commands.json');
    fs.writeFileSync(
      map,
      JSON.stringify({ known: { exec: '/bin/true', secretsFile: '/dev/null' } })
    );
    const res = run('nope', [], map);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown command 'nope'/);
  });

  it('requires a name', () => {
    const dir = tmp();
    const map = path.join(dir, 'commands.json');
    fs.writeFileSync(map, JSON.stringify({}));
    const res = spawnSync('node', [WRAPPER], {
      encoding: 'utf8',
      env: { ...process.env, HEIMDALL_TEST_SKIP_OWNER_CHECK: '1', HEIMDALL_COMMANDS_JSON: map },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage/);
  });

  // Owner check only meaningful when NOT already root (root owns the tmp file).
  it('refuses a non-root-owned commands map', {
    skip: process.getuid && process.getuid() === 0,
  }, () => {
    const dir = tmp();
    const map = path.join(dir, 'commands.json');
    fs.writeFileSync(map, JSON.stringify({ c: { exec: '/bin/true', secretsFile: '/dev/null' } }));
    const res = spawnSync('node', [WRAPPER, 'c'], {
      encoding: 'utf8',
      env: { ...process.env, HEIMDALL_COMMANDS_JSON: map }, // no SKIP flag
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /must be root-owned/);
  });
});
