import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shellQuote, escapeXml, buildWrapperScript, buildPlist, launchAgentPath,
  installScheduler, uninstallScheduler, loadAgent, agentStatus, LABEL,
} from '../lib/scheduler.mjs';
import { parseArgs } from '../bin/install-scheduler.mjs';

function tempHome(t, prefix = 'shiplog-sched-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('flags parse, and an unknown flag is rejected', () => {
  assert.deepEqual(parseArgs(['--install', '--hour', '7', '--minute', '30']), { action: 'install', hour: 7, minute: 30 });
  assert.equal(parseArgs(['--status']).action, 'status');
  assert.throws(() => parseArgs(['--wat']), /unknown flag/);
});

test('shellQuote survives spaces and embedded quotes', () => {
  assert.equal(shellQuote('/plain/path'), `'/plain/path'`);
  assert.equal(shellQuote('/has space/x'), `'/has space/x'`);
  // A path containing a single quote must not break out of the quoting. The POSIX
  // idiom is to close the quote, emit an escaped quote, and reopen: '...'\''...'
  assert.equal(shellQuote(`/it's/here`), `'/it'\\''s/here'`);
});

test('shellQuote output is actually safe when a real shell evaluates it', () => {
  // Verified by execution rather than by reading the escaping and hoping.
  const nasty = `/tmp/a'; touch /tmp/shiplog-pwned; echo '`;
  const out = execFileSync('/bin/bash', ['-c', `printf %s ${shellQuote(nasty)}`], { encoding: 'utf8' });
  assert.equal(out, nasty, 'the shell must treat the whole thing as one literal string');
  assert.equal(existsSync('/tmp/shiplog-pwned'), false, 'no injected command should have run');
});

test('escapeXml escapes every character that would break a plist', () => {
  assert.equal(escapeXml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
});

test('the wrapper script sources secrets and uses absolute paths', () => {
  const script = buildWrapperScript({
    nodePath: '/usr/local/bin/node', syncPath: '/plugins/shiplog/bin/sync.mjs', shiplogHome: '/Users/x/.shiplog',
  });
  assert.match(script, /^#!\/bin\/bash/);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /secrets\.env/, 'launchd does not read a shell profile, so secrets must be sourced here');
  assert.match(script, /'\/usr\/local\/bin\/node' '\/plugins\/shiplog\/bin\/sync\.mjs'/);
  assert.ok(!script.includes('${CLAUDE_PLUGIN_ROOT}'), 'launchd expands nothing; paths must be baked in');
});

test('a plugin path with a space is still a valid single command', () => {
  const script = buildWrapperScript({
    nodePath: '/usr/local/bin/node', syncPath: '/My Plugins/shiplog/bin/sync.mjs', shiplogHome: '/Users/x/.shiplog',
  });
  assert.match(script, /'\/My Plugins\/shiplog\/bin\/sync\.mjs'/);
});

test('the plist schedules a calendar interval and does not run at load', () => {
  const plist = buildPlist({ wrapperPath: '/Users/x/.shiplog/run_sync.sh', hour: 2, minute: 5, shiplogHome: '/Users/x/.shiplog' });
  assert.match(plist, /<key>Label<\/key><string>com\.shiplog\.sync<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>2<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>5<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key><false\/>/, 'installing should not immediately fire a sync');
  assert.match(plist, /StartCalendarInterval/, 'a missed run should catch up on wake, which StartInterval would not do');
});

test('hour and minute are coerced to numbers, so nothing user-supplied lands in the XML verbatim', () => {
  const plist = buildPlist({ wrapperPath: '/w/run.sh', hour: '3', minute: '07', shiplogHome: '/w' });
  assert.match(plist, /<key>Hour<\/key><integer>3<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>7<\/integer>/);
});

test('--print produces both files without writing or loading anything', (t) => {
  const home = tempHome(t);
  const result = installScheduler({
    shiplogHome: home, pluginRoot: '/plugins/shiplog', hour: 2, minute: 0, dryRun: true,
    load: () => { throw new Error('must not load during a dry run'); },
  });
  assert.equal(result.dryRun, true);
  assert.ok(result.wrapper.includes('sync.mjs'));
  assert.ok(result.plist.includes('com.shiplog.sync'));
  assert.equal(existsSync(join(home, 'run_sync.sh')), false, 'nothing should be written');
});

test('install writes the wrapper 0700 and the plist, then loads it', { skip: process.platform !== 'darwin' }, (t) => {
  const shiplog = tempHome(t);
  const fakeHome = tempHome(t, 'shiplog-fakehome-');
  let loadedWith = null;

  const result = installScheduler({
    shiplogHome: shiplog, pluginRoot: '/plugins/shiplog', hour: 6, minute: 15, home: fakeHome,
    load: (p) => { loadedWith = p; return { loaded: true, detail: 'registered' }; },
  });

  const wrapperMode = statSync(result.wrapperPath).mode & 0o777;
  assert.equal(wrapperMode, 0o700, 'the wrapper sources secrets, so it must not be group/world readable');
  assert.ok(readFileSync(result.plistPath, 'utf8').includes('<integer>6</integer>'));
  assert.equal(loadedWith, result.plistPath);
  assert.equal(result.loaded, true);
});

test('a non-macOS platform fails with actionable guidance rather than silently doing nothing', (t) => {
  const home = tempHome(t);
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', original));

  assert.throws(
    () => installScheduler({ shiplogHome: home, pluginRoot: '/p', hour: 2, minute: 0 }),
    /only implemented for macOS.*cron entry manually/s,
  );
});

test('loadAgent falls back from bootstrap to load, and verifies rather than assuming', () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'bootstrap') return { ok: false, out: 'bootstrap refused' };
    if (args[0] === 'print') return { ok: true, out: 'next fire date = Tue Sep  1 02:00:00 2026' };
    return { ok: true, out: '' };
  };

  const result = loadAgent('/tmp/x.plist', { exec, uid: 501 });
  assert.deepEqual(calls, ['bootout', 'bootstrap', 'load', 'print']);
  assert.equal(result.loaded, true);
});

test('a refused registration is reported as not loaded, with the reason', () => {
  const exec = (cmd, args) => (args[0] === 'print'
    ? { ok: false, out: 'Could not find service' }
    : { ok: false, out: 'Operation not permitted' });

  const result = loadAgent('/tmp/x.plist', { exec, uid: 501 });
  assert.equal(result.loaded, false);
  assert.match(result.detail, /not permitted|Could not find/);
});

test('agentStatus reports the next fire date when registered', () => {
  const exec = () => ({ ok: true, out: 'state = waiting\n\tnext fire date = Tue Sep  1 02:00:00 2026\n' });
  assert.deepEqual(agentStatus({ exec, uid: 501 }), { installed: true, nextRun: 'Tue Sep  1 02:00:00 2026' });
});

test('agentStatus reports not-installed cleanly', () => {
  assert.deepEqual(agentStatus({ exec: () => ({ ok: false, out: 'not found' }), uid: 501 }), { installed: false });
});

test('uninstall removes the plist and the wrapper', (t) => {
  const shiplog = tempHome(t);
  const fakeHome = tempHome(t, 'shiplog-fakehome-');
  installScheduler({
    shiplogHome: shiplog, pluginRoot: '/p', hour: 2, minute: 0, home: fakeHome,
    load: () => ({ loaded: true, detail: 'registered' }),
  });
  assert.equal(existsSync(join(shiplog, 'run_sync.sh')), true);

  uninstallScheduler({ home: fakeHome, shiplogHome: shiplog, unload: () => ({ ok: true }) });
  assert.equal(existsSync(launchAgentPath(fakeHome)), false);
  assert.equal(existsSync(join(shiplog, 'run_sync.sh')), false);
});

test('uninstalling when nothing is installed is harmless', (t) => {
  const fakeHome = tempHome(t, 'shiplog-fakehome-');
  assert.doesNotThrow(() => uninstallScheduler({ home: fakeHome, unload: () => ({ ok: true }) }));
});

test('the label is stable, since it is the handle used to unload and inspect the job', () => {
  assert.equal(LABEL, 'com.shiplog.sync');
});
