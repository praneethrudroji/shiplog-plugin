// Nothing in the functional suites exercises the plugin manifests themselves, only
// the scripts they point at. This caught a real bug: hooks/hooks.json used the flat
// settings-format shape instead of the plugin-format {"hooks": {...}} wrapper, which
// left the plugin reporting "couldn't be loaded" even though skills and the MCP
// server (discovered independently) loaded fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The two manifests deliberately live at different levels. plugin.json belongs to
// the plugin and travels with it under plugins/shiplog/; marketplace.json describes
// the repository as a marketplace and so stays at the repository root, two levels up.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(join(PLUGIN_ROOT, rel), 'utf8'));
const readRepoJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));

test('plugin.json has the required name field and a matching directory identity', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'shiplog');
  assert.match(manifest.name, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be valid kebab-case per the plugin schema');
});

test('marketplace.json points at a plugin entry with the same name as plugin.json', () => {
  const marketplace = readRepoJson('.claude-plugin/marketplace.json');
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.match(marketplace.plugins[0].source, /^\.\//, 'a relative source must start with ./');
});

// Regression: the source and the actual directory are two independent strings, and
// nothing else would notice them drifting apart. A wrong source is invisible
// locally (the CLI can install from a git clone regardless) and only shows up as an
// install failure for someone else.
test('marketplace.json\'s source resolves to the directory the plugin actually lives in', () => {
  const marketplace = readRepoJson('.claude-plugin/marketplace.json');
  const source = marketplace.plugins[0].source;
  assert.equal(source, './plugins/shiplog');

  const resolved = join(REPO_ROOT, source, '.claude-plugin', 'plugin.json');
  assert.doesNotThrow(
    () => readFileSync(resolved, 'utf8'),
    `marketplace source "${source}" must contain a .claude-plugin/plugin.json`,
  );
});

test('hooks.json uses the plugin wrapper format, not the flat settings format', () => {
  const hooks = readJson('hooks/hooks.json');
  assert.ok(hooks.hooks, 'plugin hooks.json requires a top-level "hooks" wrapper key');
  assert.ok(hooks.hooks.SessionStart, 'the SessionStart event belongs under the wrapper, not at top level');
  assert.equal(hooks.SessionStart, undefined, 'the event must not sit directly at the top level (that is the settings.json format, not the plugin format)');
});

test('the SessionStart hook only matches a genuine new session', () => {
  const hooks = readJson('hooks/hooks.json');
  const entry = hooks.hooks.SessionStart[0];
  assert.equal(entry.matcher, 'startup', 'must not also fire on resume/clear/compact/fork');
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/, 'must use the portable path variable, not an absolute path');
});

test('.mcp.json declares the server with a portable command path', () => {
  const mcp = readJson('.mcp.json');
  assert.ok(mcp.shiplog, 'expected a "shiplog" server entry');
  assert.equal(mcp.shiplog.command, 'node');
  assert.match(mcp.shiplog.args[0], /\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/server\.mjs$/);
});

test('every skill file has valid frontmatter with a name matching its directory', () => {
  const skills = ['shiplog-query', 'shiplog-setup', 'shiplog-status', 'shiplog-sync', 'shiplog-standup'];
  for (const dir of skills) {
    const text = readFileSync(join(PLUGIN_ROOT, 'skills', dir, 'SKILL.md'), 'utf8');
    assert.match(text, /^---\n/, `${dir}: SKILL.md must start with frontmatter`);
    const nameMatch = /\nname:\s*(\S+)/.exec(text);
    assert.ok(nameMatch, `${dir}: missing a name: field`);
    assert.equal(nameMatch[1], dir, `${dir}: frontmatter name must match its directory`);
  }
});
