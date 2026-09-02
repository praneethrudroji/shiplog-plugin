#!/usr/bin/env node
// Fails a pull request that changes the plugin without bumping its version.
//
// Claude Code only offers an update to an already-installed plugin when the
// version changes, so shipping a fix without a bump means nobody who installed
// the plugin ever receives it. That failure is completely silent: the repository
// looks updated, CI is green, and every existing user stays on the old code. This
// check exists to make that loud at the only point it can still be fixed cheaply.
//
// Repository tooling, deliberately outside plugins/shiplog/: it is not part of what
// users install.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const PLUGIN_MANIFEST = 'plugins/shiplog/.claude-plugin/plugin.json';

/**
 * Parses a semver-ish "x.y.z" into comparable numbers. Returns null for anything
 * that isn't three numeric parts, so a malformed version is reported as malformed
 * rather than silently sorting as 0.0.0 and comparing as "not bumped".
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('.');
  if (parts.length !== 3) return null;

  const numbers = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}

/** Standard semver ordering: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The whole decision, as a pure function of the two manifest texts, so every branch
 * is testable without a git repository or a network. `baseText` is null when the
 * manifest does not exist on the base branch, which is the case for a brand new
 * plugin and must not be treated as a failure.
 */
export function checkVersionBump({ baseText, headText }) {
  let head;
  try {
    head = JSON.parse(headText);
  } catch (err) {
    return { ok: false, reason: `${PLUGIN_MANIFEST} is not valid JSON: ${err.message}` };
  }

  const headVersion = parseVersion(head.version);
  if (!headVersion) {
    return { ok: false, reason: `${PLUGIN_MANIFEST} has no usable "version" (found ${JSON.stringify(head.version)}); expected "x.y.z"` };
  }

  if (baseText === null) {
    return { ok: true, reason: `new plugin manifest at version ${head.version}`, headVersion: head.version };
  }

  let base;
  try {
    base = JSON.parse(baseText);
  } catch {
    // A corrupt manifest on the base branch is not this PR's fault, and blocking on
    // it would leave no way to merge the fix. Treat the head version as sufficient.
    return { ok: true, reason: 'base manifest is unreadable, accepting the head version', headVersion: head.version };
  }

  const baseVersion = parseVersion(base.version);
  if (!baseVersion) {
    return { ok: true, reason: 'base version is unparseable, accepting the head version', headVersion: head.version };
  }

  const order = compareVersions(headVersion, baseVersion);
  if (order === 0) {
    return {
      ok: false,
      baseVersion: base.version,
      headVersion: head.version,
      reason: `plugin files changed but the version is still ${base.version}. `
        + 'Claude Code only offers an update when the version changes, so this would reach nobody '
        + `who already installed it. Bump "version" in ${PLUGIN_MANIFEST}.`,
    };
  }
  if (order < 0) {
    return {
      ok: false,
      baseVersion: base.version,
      headVersion: head.version,
      reason: `the version went backwards, from ${base.version} to ${head.version}.`,
    };
  }

  return { ok: true, baseVersion: base.version, headVersion: head.version, reason: `${base.version} to ${head.version}` };
}

/** Reads the manifest as it exists on the base branch, or null if it does not. */
export function readBaseManifest(baseRef, exec = execFileSync) {
  try {
    return exec('git', ['show', `${baseRef}:${PLUGIN_MANIFEST}`], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

export const PLUGIN_DIR = 'plugins/shiplog/';

/**
 * Whether this pull request touches the shipped plugin at all. A docs or CI change
 * needs no version bump, because nothing users install has changed.
 *
 * This is decided here rather than with a workflow `paths:` filter on purpose. A
 * filtered job does not run at all on an unmatched PR, and a required status check
 * that never reports leaves the PR waiting on it forever. Running always and
 * deciding internally means the check can actually be required.
 */
export function pluginFilesChanged(baseRef, exec = execFileSync) {
  const out = exec('git', ['diff', '--name-only', `${baseRef}...HEAD`], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
    .some((path) => path.startsWith(PLUGIN_DIR));
}

function main() {
  const baseRef = process.argv[2];
  if (!baseRef) {
    process.stderr.write('usage: check-version-bump.mjs <base-ref>\n');
    process.exitCode = 1;
    return;
  }

  if (!pluginFilesChanged(baseRef)) {
    process.stdout.write('Version check skipped: this pull request changes no plugin files.\n');
    return;
  }

  const result = checkVersionBump({
    baseText: readBaseManifest(baseRef),
    headText: readFileSync(PLUGIN_MANIFEST, 'utf8'),
  });

  if (!result.ok) {
    process.stderr.write(`Version check failed: ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Version check passed: ${result.reason}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
