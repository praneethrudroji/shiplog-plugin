import { backup as sqliteBackup } from 'node:sqlite';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

const NAME = /^worklog-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.db\.gz$/;

const stamp = (d) => d.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');

/**
 * Snapshots the database using SQLite's online backup, then gzips it.
 * A plain file copy can tear under WAL - the copy would be a torn page mid-write.
 */
export async function snapshot(db, backupsDir, { now = new Date() } = {}) {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const target = join(backupsDir, `worklog-${stamp(now)}.db.gz`);
  const staging = `${target}.tmp.db`;

  try {
    await sqliteBackup(db, staging);
    // A snapshot is a full copy of the database, so it carries the same restriction.
    await pipeline(createReadStream(staging), createGzip(), createWriteStream(target, { mode: 0o600 }));
    return { path: target, bytes: statSync(target).size };
  } finally {
    rmSync(staging, { force: true });
    rmSync(`${staging}-wal`, { force: true });
    rmSync(`${staging}-shm`, { force: true });
  }
}

export function listSnapshots(backupsDir) {
  let entries;
  try {
    entries = readdirSync(backupsDir);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, match: NAME.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => ({
      name,
      path: join(backupsDir, name),
      takenAt: new Date(match[1].replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/,
        '$1-$2-$3T$4:$5:$6Z',
      )),
    }))
    .sort((a, b) => b.takenAt - a.takenAt);
}

/**
 * Drops snapshots past the retention window, but always keeps the newest one -
 * a long gap between runs should never leave the user with no backup at all.
 */
export function prune(backupsDir, { retentionDays = 30, now = new Date() } = {}) {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const snapshots = listSnapshots(backupsDir);
  const removed = [];

  for (const snap of snapshots.slice(1)) {
    if (snap.takenAt.getTime() < cutoff) {
      rmSync(snap.path, { force: true });
      removed.push(snap.name);
    }
  }
  return removed;
}
