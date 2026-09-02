// Tests for the repository's own CI tooling, kept separate from the plugin suite
// under plugins/shiplog/test/ because this script is not part of what users install.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, compareVersions, checkVersionBump, readBaseManifest, pluginFilesChanged,
} from './check-version-bump.mjs';

const manifest = (version) => JSON.stringify({ name: 'shiplog', version });

test('parseVersion accepts three numeric parts and rejects everything else', () => {
  assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0]);
  assert.deepEqual(parseVersion('10.20.30'), [10, 20, 30]);
  assert.deepEqual(parseVersion(' 1.2.3 '), [1, 2, 3], 'surrounding whitespace should not matter');

  for (const bad of ['1.2', '1.2.3.4', '1.2.x', 'v1.2.3', '', 'abc', null, undefined, 3]) {
    assert.equal(parseVersion(bad), null, `${JSON.stringify(bad)} should not parse`);
  }
});

test('parseVersion does not accept a version that only looks numeric', () => {
  // Number('1e3') is 1000 and Number(' 2 ') is 2, so a naive Number() cast would
  // quietly accept both. Versions are compared for ordering, and a surprise here
  // would silently mis-rank a release.
  assert.equal(parseVersion('1.1e3.0'), null);
  assert.equal(parseVersion('1.+2.0'), null);
  assert.equal(parseVersion('1.0x2.0'), null);
});

test('compareVersions orders by major, then minor, then patch', () => {
  assert.equal(compareVersions([0, 1, 0], [0, 1, 0]), 0);
  assert.equal(compareVersions([0, 1, 1], [0, 1, 0]), 1);
  assert.equal(compareVersions([0, 2, 0], [0, 1, 9]), 1, 'minor outranks patch');
  assert.equal(compareVersions([1, 0, 0], [0, 9, 9]), 1, 'major outranks both');
  assert.equal(compareVersions([0, 1, 0], [0, 1, 2]), -1);
  assert.equal(compareVersions([0, 9, 0], [1, 0, 0]), -1);
});

test('an unchanged version fails, and the message says what to do about it', () => {
  const result = checkVersionBump({ baseText: manifest('0.1.0'), headText: manifest('0.1.0') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /still 0\.1\.0/);
  assert.match(result.reason, /Bump "version"/, 'the failure must name the fix, not just the problem');
  assert.match(result.reason, /only offers an update when the version changes/, 'and say why it matters');
});

test('a bumped version passes, at every level', () => {
  for (const [base, head] of [['0.1.0', '0.1.1'], ['0.1.0', '0.2.0'], ['0.9.9', '1.0.0']]) {
    const result = checkVersionBump({ baseText: manifest(base), headText: manifest(head) });
    assert.equal(result.ok, true, `${base} to ${head} should pass`);
    assert.equal(result.headVersion, head);
  }
});

test('a version that goes backwards fails, and is reported as its own case', () => {
  const result = checkVersionBump({ baseText: manifest('0.2.0'), headText: manifest('0.1.0') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /went backwards, from 0\.2\.0 to 0\.1\.0/);
});

test('a brand new manifest passes, since there is nothing to bump from', () => {
  const result = checkVersionBump({ baseText: null, headText: manifest('0.1.0') });
  assert.equal(result.ok, true);
  assert.match(result.reason, /new plugin manifest/);
});

test('a malformed head manifest fails with the parse error, not a version complaint', () => {
  const result = checkVersionBump({ baseText: manifest('0.1.0'), headText: '{ not json' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /is not valid JSON/);
});

test('a head manifest with no usable version fails, naming what it found', () => {
  for (const version of [undefined, '', 'v1.0.0', '1.0', 42]) {
    const result = checkVersionBump({
      baseText: manifest('0.1.0'),
      headText: JSON.stringify({ name: 'shiplog', version }),
    });
    assert.equal(result.ok, false, `version ${JSON.stringify(version)} should fail`);
    assert.match(result.reason, /no usable "version"/);
  }
});

// A broken manifest on the base branch is not the current PR's fault, and failing
// on it would leave no way to merge the very fix that repairs it.
test('an unreadable base manifest does not block the PR that might be fixing it', () => {
  const corrupt = checkVersionBump({ baseText: '{ corrupt', headText: manifest('0.1.0') });
  assert.equal(corrupt.ok, true);
  assert.match(corrupt.reason, /base manifest is unreadable/);

  const unparseable = checkVersionBump({
    baseText: JSON.stringify({ name: 'shiplog', version: 'nonsense' }),
    headText: manifest('0.1.0'),
  });
  assert.equal(unparseable.ok, true);
  assert.match(unparseable.reason, /base version is unparseable/);
});

test('readBaseManifest returns null rather than throwing when the file is absent', () => {
  const missing = readBaseManifest('origin/main', () => { throw new Error('path does not exist in ref'); });
  assert.equal(missing, null, 'a manifest that does not exist on the base branch is a new plugin, not an error');

  const present = readBaseManifest('origin/main', () => manifest('0.1.0'));
  assert.equal(JSON.parse(present).version, '0.1.0');
});

// This is what lets the check be a required status check at all. A workflow
// paths: filter would skip the job entirely on a docs-only PR, and a required check
// that never reports leaves the PR waiting on it forever.
test('a pull request touching no plugin files needs no version bump', () => {
  const docsOnly = () => 'README.md\ndocs/DECISIONS.md\n.github/workflows/ci.yml\n';
  assert.equal(pluginFilesChanged('origin/develop', docsOnly), false);

  const toolingOnly = () => 'scripts/check-version-bump.mjs\nscripts/check-version-bump.test.mjs\n';
  assert.equal(pluginFilesChanged('origin/develop', toolingOnly), false);

  const empty = () => '';
  assert.equal(pluginFilesChanged('origin/develop', empty), false);
});

test('a pull request touching any plugin file does need one', () => {
  const oneFile = () => 'plugins/shiplog/lib/db.mjs\n';
  assert.equal(pluginFilesChanged('origin/develop', oneFile), true);

  const mixed = () => 'README.md\nplugins/shiplog/bin/sync.mjs\ndocs/ARCHITECTURE.md\n';
  assert.equal(pluginFilesChanged('origin/develop', mixed), true, 'one plugin file among docs still counts');
});

test('a path merely starting with the same letters is not a plugin file', () => {
  // "plugins/shiplog-extras/..." shares a prefix with "plugins/shiplog" but is a
  // different directory. The trailing slash in PLUGIN_DIR is what prevents this.
  const lookalike = () => 'plugins/shiplog-extras/thing.mjs\n';
  assert.equal(pluginFilesChanged('origin/develop', lookalike), false);
});

test('pluginFilesChanged diffs against the merge base, not the raw base tip', () => {
  let calledWith = null;
  pluginFilesChanged('origin/main', (cmd, args) => { calledWith = { cmd, args }; return ''; });
  assert.equal(calledWith.cmd, 'git');
  assert.deepEqual(
    calledWith.args,
    ['diff', '--name-only', 'origin/main...HEAD'],
    'three dots: only what this branch changed, not what landed on the base since it forked',
  );
});

test('readBaseManifest asks git for the manifest at the given ref', () => {
  let calledWith = null;
  readBaseManifest('origin/develop', (cmd, args) => { calledWith = { cmd, args }; return manifest('0.1.0'); });
  assert.equal(calledWith.cmd, 'git');
  assert.deepEqual(calledWith.args, ['show', 'origin/develop:plugins/shiplog/.claude-plugin/plugin.json']);
});
