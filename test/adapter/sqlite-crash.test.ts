import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHILD = `
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
const [path, marker, mode] = process.argv.slice(1);
const db = new Database(path, { strict: true });
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = FULL');
db.exec('CREATE TABLE IF NOT EXISTS crash_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
if (mode === 'commit') db.exec("BEGIN IMMEDIATE; INSERT INTO crash_probe (value) VALUES ('committed'); COMMIT");
else db.exec("BEGIN IMMEDIATE; INSERT INTO crash_probe (value) VALUES ('pending')");
writeFileSync(marker, 'ready');
await new Promise(() => {});
`;
const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function crash(mode: 'rollback' | 'commit'): Promise<{ path: string; values: string[]; integrity: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'typehtml-crash-'));
  temporary.push(directory);
  const path = join(directory, 'crash.sqlite');
  const marker = join(directory, 'ready');
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', CHILD, path, marker, mode],
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error('child did not reach the crash point');
      if ((await Promise.race([child.exited, Bun.sleep(20).then(() => null)])) !== null) {
        throw new Error('child exited before the crash point: ' + (await new Response(child.stderr).text()));
      }
    }
    child.kill('SIGKILL');
    await child.exited;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const db = new Database(path, { strict: true });
  const integrity = (db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  const rows = db.query('SELECT value FROM crash_probe ORDER BY id').all() as { value: string }[];
  db.close();
  return { path, values: rows.map((row) => row.value), integrity };
}

describe('SQLite process-kill recovery', () => {
  it('discards an uncommitted transaction after SIGKILL', async () => {
    const result = await crash('rollback');
    expect(result.integrity).toBe('ok');
    expect(result.values).toEqual([]);
  });

  it('keeps a committed transaction after SIGKILL', async () => {
    const result = await crash('commit');
    expect(result.integrity).toBe('ok');
    expect(result.values).toEqual(['committed']);
  });
});
