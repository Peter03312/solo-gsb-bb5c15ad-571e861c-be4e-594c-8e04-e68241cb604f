'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { migrate, withMigrationLock } = require('./migrate');
const { migrations } = require('./migrations');

let db;
let ready = false;
let migrationInfo = null;

function init(dbPath) {
  if (db) return db;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // 打开数据库与执行升级全程持锁：多进程同时启动时只有一个进程创建/升级库，
  // 其余进程等锁后打开已就绪的库并跳过全部版本。
  return withMigrationLock(dbPath, () => {
    const conn = new Database(dbPath);
    // busy_timeout 处理同进程/升级期间可能的常规写锁等待；跨进程创建竞争由文件锁规避。
    conn.pragma('busy_timeout = 30000');
    // WAL 模式为连接级持久设置；foreign_keys 为连接级，必须在任何事务前开启。
    // 两者均不涉及用户表结构，放在版本升级之外。
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');

    let result;
    try {
      result = migrate(conn, migrations);
    } catch (err) {
      // 升级失败：该版本事务已回滚；关闭句柄并阻止本进程继续启动
      conn.close();
      throw err;
    }

    db = conn;
    ready = true;
    migrationInfo = result;
    for (const item of result.applied) {
      const label = item.kind === 'baseline' ? '识别登记' : '执行升级';
      console.log(`[db] ${label} v${item.version}（${item.name}）`);
    }
    console.log(`[db] 数据库结构版本 v${result.currentVersion}，就绪`);
    return db;
  });
}

function get() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

// 路由层防御性门禁：初始化（含全部升级）未完成时拒绝一切请求
function isReady() {
  return ready;
}

function getMigrationInfo() {
  return migrationInfo;
}

// 主要供测试关闭句柄与更换临时库；生产进程退出即释放
async function close() {
  if (db) {
    await db.close();
    db = null;
    ready = false;
    migrationInfo = null;
  }
}

module.exports = { init, get, isReady, getMigrationInfo, close };
