'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

/* ================= 结构探测 ================= */

function hasTable(d, name) {
  return !!d.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function hasIndex(d, name) {
  return !!d.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

function hasColumn(d, table, column) {
  return d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/* ================= 版本化迁移定义 =================
 *
 * 每个迁移按 version 严格递增顺序执行：
 * - isApplied：识别既有结构（旧库首次升级时按实际结构登记，不重建、不丢数据）；
 * - up：幂等的结构变更（逐语句判定），与版本登记在同一事务内提交（见 migrate）。
 * 新建空库依次执行全部迁移后达到当前结构；已具备当前结构的库只做登记。
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-tables',
    isApplied: (d) =>
      ['videos', 'segments', 'speakers', 'publications', 'translations', 'qc_rules', 'qc_waivers']
        .every((t) => hasTable(d, t)) &&
      ['idx_segments_video', 'idx_speakers_video', 'idx_publications_video',
        'idx_translations_video', 'idx_qc_waivers_video']
        .every((i) => hasIndex(d, i)),
    up: (d) => d.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        title         TEXT    NOT NULL,
        storage_name  TEXT    NOT NULL,
        original_name TEXT    NOT NULL,
        mime_type     TEXT,
        size_bytes    INTEGER NOT NULL,
        duration_ms   INTEGER NOT NULL CHECK (duration_ms > 0),
        translation_lang TEXT,
        speakers_revision INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS segments (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        start_ms   INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms     INTEGER NOT NULL CHECK (end_ms > start_ms),
        text       TEXT    NOT NULL DEFAULT '',
        reviewed   INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
        revision   INTEGER NOT NULL DEFAULT 1,
        speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (video_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_id, start_ms);

      -- 说话人名单：每个视频独立维护；名称去首尾空白后非空、不换行且同视频唯一（精确比较）。
      -- videos.speakers_revision 为名单的乐观锁：任何增删改都必须携带所见名单修订号。
      -- 仍被草稿片段引用的说话人不得删除（应用层在事务内先查引用，引用计数见 segments.speaker_id）。
      CREATE TABLE IF NOT EXISTS speakers (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        name       TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (video_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_speakers_video ON speakers(video_id, id);

      CREATE TABLE IF NOT EXISTS publications (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id     INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        version      INTEGER NOT NULL,
        snapshot     TEXT    NOT NULL,
        translation_snapshot TEXT,
        translation_lang     TEXT,
        qc_rules_snapshot    TEXT,
        qc_report_snapshot   TEXT,
        speaker_snapshot     TEXT,
        segment_count INTEGER NOT NULL,
        published_at INTEGER NOT NULL,
        UNIQUE (video_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_publications_video ON publications(video_id, version);

      -- 译文轨道：每段草稿原文至多一条译文（单语言轨道）；
      -- source_* 记录译文录入/更新时对应的原文内容，用于判定「原文变更 -> 译文失效」；
      -- 片段被删除（含整稿替换、区间恢复）时级联删除译文，新片段不沿用旧译文
      CREATE TABLE IF NOT EXISTS translations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id        INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        segment_id      INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        text            TEXT    NOT NULL DEFAULT '',
        reviewed        INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
        revision        INTEGER NOT NULL DEFAULT 1,
        source_start_ms INTEGER NOT NULL,
        source_end_ms   INTEGER NOT NULL,
        source_text     TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        UNIQUE (video_id, segment_id)
      );

      CREATE INDEX IF NOT EXISTS idx_translations_video ON translations(video_id);

      -- 质检规则：每个视频至多一行；四个阈值均可空（未配置该项，不阻断发布）。
      -- revision 为规则乐观锁：并发修改必须携带所见修订号，过期拒绝并返回当前状态。
      CREATE TABLE IF NOT EXISTS qc_rules (
        video_id                  INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
        source_max_cps            REAL,
        source_max_line_chars     INTEGER,
        translation_max_cps       REAL,
        translation_max_line_chars INTEGER,
        revision                  INTEGER NOT NULL DEFAULT 1,
        updated_at                INTEGER NOT NULL
      );

      -- 质检放行（豁免）：对单项违规填写理由放行；
      -- 绑定放行时的片段时间、文本、轨道语言与当时阈值（规则修订号），任一变化后失效；
      -- active 锁存：失效时置 0 但行保留（保留历史理由）。
      CREATE TABLE IF NOT EXISTS qc_waivers (
        id                            INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id                      INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        segment_id                    INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        track                         TEXT    NOT NULL CHECK (track IN ('source', 'translation')),
        rule                          TEXT    NOT NULL CHECK (rule IN ('max_cps', 'max_line_chars')),
        language                      TEXT,
        reason                        TEXT    NOT NULL,
        active                        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        bound_start_ms                INTEGER NOT NULL,
        bound_end_ms                  INTEGER NOT NULL,
        bound_text                    TEXT    NOT NULL,
        bound_rules_revision          INTEGER NOT NULL,
        bound_source_max_cps          REAL,
        bound_source_max_line_chars   INTEGER,
        bound_translation_max_cps     REAL,
        bound_translation_max_line_chars INTEGER,
        created_at                    INTEGER NOT NULL,
        revoked_at                    INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_qc_waivers_video ON qc_waivers(video_id, segment_id);
    `),
  },
  {
    // 译文轨道：视频级语言标记 + 发布版本的译文快照列
    version: 2,
    name: 'translation-track-columns',
    isApplied: (d) =>
      hasColumn(d, 'videos', 'translation_lang') &&
      hasColumn(d, 'publications', 'translation_snapshot') &&
      hasColumn(d, 'publications', 'translation_lang'),
    up: (d) => {
      if (!hasColumn(d, 'videos', 'translation_lang')) {
        d.exec('ALTER TABLE videos ADD COLUMN translation_lang TEXT');
      }
      if (!hasColumn(d, 'publications', 'translation_snapshot')) {
        d.exec('ALTER TABLE publications ADD COLUMN translation_snapshot TEXT');
      }
      if (!hasColumn(d, 'publications', 'translation_lang')) {
        d.exec('ALTER TABLE publications ADD COLUMN translation_lang TEXT');
      }
    },
  },
  {
    // 质检：发布版本固定当时规则与结果的快照列
    version: 3,
    name: 'qc-snapshot-columns',
    isApplied: (d) =>
      hasColumn(d, 'publications', 'qc_rules_snapshot') &&
      hasColumn(d, 'publications', 'qc_report_snapshot'),
    up: (d) => {
      if (!hasColumn(d, 'publications', 'qc_rules_snapshot')) {
        d.exec('ALTER TABLE publications ADD COLUMN qc_rules_snapshot TEXT');
      }
      if (!hasColumn(d, 'publications', 'qc_report_snapshot')) {
        d.exec('ALTER TABLE publications ADD COLUMN qc_report_snapshot TEXT');
      }
    },
  },
  {
    // 说话人：名单乐观锁、片段归属列与归属索引、发布版本的说话人快照列
    version: 4,
    name: 'speaker-columns',
    isApplied: (d) =>
      hasColumn(d, 'videos', 'speakers_revision') &&
      hasColumn(d, 'segments', 'speaker_id') &&
      hasColumn(d, 'publications', 'speaker_snapshot') &&
      hasIndex(d, 'idx_segments_speaker'),
    up: (d) => {
      if (!hasColumn(d, 'videos', 'speakers_revision')) {
        d.exec('ALTER TABLE videos ADD COLUMN speakers_revision INTEGER NOT NULL DEFAULT 0');
      }
      if (!hasColumn(d, 'segments', 'speaker_id')) {
        // speakers 表已由 v1 建好；旧片段默认未归属（NULL）
        d.exec('ALTER TABLE segments ADD COLUMN speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL');
      }
      // 旧库 speaker_id 列不存在时不能提前建归属索引，须在确保列存在之后
      d.exec('CREATE INDEX IF NOT EXISTS idx_segments_speaker ON segments(speaker_id)');
      if (!hasColumn(d, 'publications', 'speaker_snapshot')) {
        d.exec('ALTER TABLE publications ADD COLUMN speaker_snapshot TEXT');
      }
    },
  },
];

/* ================= 迁移执行 ================= */

// 版本登记表：每一次升级的可追踪记录（版本、名称、登记时间）
function ensureMigrationTable(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function migrate(d) {
  ensureMigrationTable(d);

  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].version <= ordered[i - 1].version) {
      throw new Error(`迁移版本号必须严格递增：v${ordered[i].version}`);
    }
  }

  for (const m of ordered) {
    // 每个升级一个 IMMEDIATE 事务：结构变更与版本登记同事务提交，失败一并回滚；
    // BEGIN IMMEDIATE 在事务开始即取数据库写锁，多进程同时启动时彼此串行，
    // 事务内再查登记，保证同一升级只生效一次
    const run = d.transaction(() => {
      const registered = d.prepare('SELECT 1 AS x FROM schema_migrations WHERE version = ?').get(m.version);
      if (registered) return 'registered';
      const existing = m.isApplied(d);
      if (!existing) m.up(d);
      d.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, Date.now());
      return existing ? 'detected' : 'applied';
    });
    let outcome;
    try {
      outcome = run.immediate();
    } catch (err) {
      throw new Error(`数据库结构迁移 v${m.version}（${m.name}）失败，该版本已回滚：${err.message}`, { cause: err });
    }
    if (outcome === 'applied') {
      console.log(`[db] 迁移 v${m.version}（${m.name}）已应用并登记`);
    } else if (outcome === 'detected') {
      console.log(`[db] 迁移 v${m.version}（${m.name}）：识别到既有结构，已登记`);
    }
  }
}

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  // 多进程同时启动迁移时等待写锁，而非立即报 SQLITE_BUSY
  handle.pragma('busy_timeout = 5000');

  try {
    migrate(handle);
  } catch (err) {
    // 升级失败：失败版本的结构与登记已随事务回滚；关闭句柄并保持未初始化状态，
    // 阻止服务以未完成升级的数据库继续提供请求
    try { handle.close(); } catch (_) { /* 忽略关闭异常 */ }
    throw err;
  }

  db = handle;
  return db;
}

function get() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

module.exports = { init, get };
