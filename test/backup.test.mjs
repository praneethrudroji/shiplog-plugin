import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, createReadStream, createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, upsertEvent } from '../lib/db.mjs';
import { snapshot, listSnapshots, prune } from '../lib/backup.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'worklog-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sample = (id) => ({
  source: 'github', event_type: 'pr_opened', external_id: id,
  title: 'x', occurred_at: '2026-08-31T09:00:00.000Z',
  raw_json: {}, synced_at: '2026-08-31T22:00:00.000Z',
});

test('a snapshot is gzipped and restores to a readable database', async (t) => {
  const dir = tempDir(t);
  const db = openDatabase(join(dir, 'worklog.db'));
  upsertEvent(db, sample('a'));
  upsertEvent(db, sample('b'));

  const backups = join(dir, 'backups');
  const { path, bytes } = await snapshot(db, backups, { now: new Date('2026-08-31T22:00:00Z') });
  db.close();

  assert.match(path, /worklog-2026-08-31T22-00-00Z\.db\.gz$/);
  assert.ok(bytes > 0);
  assert.deepEqual(readdirSync(backups), ['worklog-2026-08-31T22-00-00Z.db.gz'], 'no staging file left behind');

  const restored = join(dir, 'restored.db');
  await pipeline(createReadStream(path), createGunzip(), createWriteStream(restored));
  const check = openDatabase(restored, { readOnly: true });
  t.after(() => check.close());
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
});

test('snapshots are listed newest first', (t) => {
  const dir = tempDir(t);
  for (const name of [
    'worklog-2026-08-29T02-00-00Z.db.gz',
    'worklog-2026-08-31T02-00-00Z.db.gz',
    'worklog-2026-08-30T02-00-00Z.db.gz',
    'not-a-backup.txt',
    'worklog-garbage.db.gz',
  ]) writeFileSync(join(dir, name), 'x');

  const found = listSnapshots(dir);
  assert.equal(found.length, 3, 'unrecognized filenames are ignored');
  assert.deepEqual(found.map((s) => s.name.slice(8, 18)), ['2026-08-31', '2026-08-30', '2026-08-29']);
});

test('listing a directory that does not exist yet returns empty', () => {
  assert.deepEqual(listSnapshots('/nonexistent/worklog/backups'), []);
});

test('snapshots past the retention window are pruned', (t) => {
  const dir = tempDir(t);
  for (const day of ['2026-06-01', '2026-07-15', '2026-08-25', '2026-08-30']) {
    writeFileSync(join(dir, `worklog-${day}T02-00-00Z.db.gz`), 'x');
  }

  const removed = prune(dir, { retentionDays: 30, now: new Date('2026-08-31T02:00:00Z') });
  assert.deepEqual(removed.sort(), [
    'worklog-2026-06-01T02-00-00Z.db.gz',
    'worklog-2026-07-15T02-00-00Z.db.gz',
  ]);
  assert.equal(listSnapshots(dir).length, 2);
});

test('the newest snapshot is kept even when it is past the retention window', (t) => {
  const dir = tempDir(t);
  // A machine left off for months: everything is stale, but discarding the only
  // backup would leave the user with none at all.
  for (const day of ['2026-01-01', '2026-02-01']) {
    writeFileSync(join(dir, `worklog-${day}T02-00-00Z.db.gz`), 'x');
  }

  const removed = prune(dir, { retentionDays: 30, now: new Date('2026-08-31T02:00:00Z') });
  assert.deepEqual(removed, ['worklog-2026-01-01T02-00-00Z.db.gz']);
  assert.deepEqual(listSnapshots(dir).map((s) => s.name), ['worklog-2026-02-01T02-00-00Z.db.gz']);
});

test('pruning an empty directory is harmless', (t) => {
  assert.deepEqual(prune(tempDir(t), { retentionDays: 30 }), []);
});
