'use strict';

// 并发升级子进程：在同一个数据库文件上执行一次完整 init()。
// 用法：node test/migrate-worker.js <db_path> [--fail-at N]
// --fail-at N：注入一个在第 N 版登记后、提交前抛错的伪升级，用于验证事务回滚。
const path = require('path');
const { migrate, withMigrationLock } = require('../src/migrate');
const Database = require('better-sqlite3');

const [dbPathRaw, flag, failAtRaw] = process.argv.slice(2);
const dbPath = path.resolve(dbPathRaw);

let migrations;
if (flag === '--fail-at') {
  const base = require('../src/migrations').migrations;
  const failAt = Number(failAtRaw);
  migrations = base.map((m) => {
    if (m.version !== failAt) return m;
    const originalUp = m.up;
    return {
      ...m,
      up: (db) => {
        originalUp(db);
        throw new Error(`注入失败：v${failAt} up 中途出错`);
      },
    };
  });
} else {
  migrations = require('../src/migrations').migrations;
}

try {
  const result = withMigrationLock(dbPath, () => {
    const conn = new Database(dbPath);
    conn.pragma('busy_timeout = 30000');
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      const r = migrate(conn, migrations, { now: 1700000000000 });
      conn.close();
      return r;
    } catch (err) {
      conn.close();
      throw err;
    }
  });
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err.message }));
  process.exit(2);
}
