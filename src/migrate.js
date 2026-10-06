'use strict';

// 版本化结构升级执行器。
//
// 设计要点（见 README「数据库升级」）：
// 1. 新建空库：从第 1 版起顺序执行全部升级，结束后结构与当前版本一致。
// 2. 无 schema_migrations 登记表的旧库：按版本 predicate 识别其已有结构并登记，
//    只对尚未具备的版本执行 up；不重建数据库、不触碰任何业务数据。
// 3. 每个版本在独立的 IMMEDIATE 事务内完成「结构变更 + 版本登记」，同提交同回滚。
// 4. 多进程同时启动时，先通过 withMigrationLock 以 O_EXCL 锁文件串行化：
//    只有持锁进程打开并升级数据库（这也避开了多进程同时创建新库文件时
//    SQLite 的 WAL 恢复竞争 SQLITE_BUSY）；其余进程等待锁后重入，全部版本
//    已登记则直接跳过。事务内仍会复查登记版本，保证同一升级只生效一次。
// 5. 任一升级失败则该版本结构变更与登记一并回滚，锁随 finally 释放，错误向上
//    抛出使服务启动中止，服务不会监听端口、不会以半成品数据库对外提供请求。

const fs = require('fs');

const REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version      INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    applied_kind TEXT    NOT NULL CHECK (applied_kind IN ('up', 'baseline')),
    applied_at   INTEGER NOT NULL
  );
`;

function sleepSync(ms) {
  // 不引入额外依赖的同步等待（better-sqlite3 的升级流程本身是同步的）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

// 跨进程升级锁：以 O_EXCL 原子创建 <db>.migrate.lock。
// 持锁进程崩溃会留下锁文件；超过 staleMs 视为崩溃残留并抢占
// （所有升级均为秒级完成的结构语句，正常持锁远短于该阈值）。
function withMigrationLock(dbPath, fn, options = {}) {
  const lockPath = `${dbPath}.migrate.lock`;
  const waitMs = options.lockWaitMs != null ? options.lockWaitMs : 60000;
  const staleMs = options.lockStaleMs != null ? options.lockStaleMs : 10 * 60 * 1000;
  const deadline = Date.now() + waitMs;

  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o644);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_) { /* 锁可能刚被释放 */ }
      if (age > staleMs) {
        // 持锁进程疑似崩溃：删除残留锁后重试创建（多个等待者竞争时未抢到者回到等待）
        try { fs.unlinkSync(lockPath); } catch (_) { /* 已被他人处理 */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`等待数据库升级锁超时（${lockPath}）：其他进程的升级长时间未完成`);
      }
      sleepSync(50);
    }
  }

  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  } catch (_) { /* 锁内容仅用于排障，写失败不影响互斥 */ }

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* 忽略 */ }
    try { fs.unlinkSync(lockPath); } catch (_) { /* 忽略 */ }
  }
}

function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function appliedVersions(db) {
  return new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );
}

// 执行（或识别登记）单个版本。整体处于一个 IMMEDIATE 事务中。
function applyOne(db, migration, legacy, nowMs) {
  const apply = db.transaction(() => {
    // 登记表在首个版本事务内创建：与该版本同锁同事务，避免独立 autocommit DDL
    // 在多进程并发下与写锁竞争（CREATE TABLE 即便 IF NOT EXISTS 也需写锁）。
    if (migration.version === 1) {
      db.exec(REGISTRY_DDL);
    }
    const applied = appliedVersions(db);
    if (applied.has(migration.version)) return 'skipped';

    let kind = 'up';
    if (legacy && migration.predicate(db)) {
      // 旧库已具备该版本结构：只登记，不执行结构变更
      kind = 'baseline';
    } else {
      migration.up(db);
    }
    db.prepare('INSERT INTO schema_migrations (version, name, applied_kind, applied_at) VALUES (?, ?, ?, ?)')
      .run(migration.version, migration.name, kind, nowMs);
    return kind;
  }, { immediate: true });

  return apply();
}

function migrate(db, migrations, options = {}) {
  const nowMs = options.now || Date.now();
  const lockWaitMs = options.lockWaitMs != null ? options.lockWaitMs : 30000;

  // 多进程抢写锁时等待上限，超时由调用方按失败处理（不带着未完成升级启动）
  db.pragma(`busy_timeout = ${lockWaitMs}`);

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].version !== i + 1) {
      throw new Error(`数据库升级版本不连续：期望 ${i + 1}，实际 ${ordered[i].version}`);
    }
  }

  // 登记表是否存在是「旧库（从未纳入版本管理）」的唯一判据。
  // 仅做只读探测；登记表本身由首个版本事务创建（见 applyOne）。
  const legacy = !tableExists(db, 'schema_migrations');

  const results = [];
  for (const migration of ordered) {
    const outcome = applyOne(db, migration, legacy, nowMs);
    if (outcome !== 'skipped') {
      results.push({ version: migration.version, name: migration.name, kind: outcome });
    }
  }

  // 收尾校验：登记必须与升级清单完全一致，防止以未完成/超前数据库启动
  const registered = appliedVersions(db);
  const missing = ordered.filter((m) => !registered.has(m.version)).map((m) => m.version);
  const unknown = [...registered].filter((v) => !ordered.some((m) => m.version === v));
  if (missing.length || unknown.length) {
    throw new Error(`数据库版本登记不一致：缺失 ${JSON.stringify(missing)}，未知 ${JSON.stringify(unknown)}`);
  }

  // 结构校验：每个已登记版本都必须真正具备其最终结构。
  // 这能拦住「登记已写入但结构缺失」的半成品/损坏库（例如手工篡改登记、
  // 历史异常遗留），使服务拒绝以未完成升级的数据库启动。
  for (const migration of ordered) {
    if (typeof migration.predicate === 'function' && !migration.predicate(db)) {
      throw new Error(
        `数据库升级不完整：v${migration.version}（${migration.name}）已登记但缺少对应结构，`
        + '请恢复数据库备份后重新启动',
      );
    }
  }

  return {
    legacy,
    currentVersion: ordered.length ? ordered[ordered.length - 1].version : 0,
    applied: results,
  };
}

module.exports = { migrate, withMigrationLock, REGISTRY_DDL };
