'use strict';

// 版本化数据库结构升级（有序）。
//
// 约定：
// - 数组顺序即升级顺序，version 从 1 开始连续递增，一经发布不得改写或删除。
// - 每次升级由 runner 包在独立事务中执行：up 的结构变更与版本登记同事务提交或回滚。
// - up 必须幂等：旧库补列历史上无版本登记，runner 检测到无 schema_migrations 表的
//   旧库时，会对「结构已具备该版本特征」的版本只登记不执行；对处于中间形态的库则
//   调用 up 补齐。因此 up 内的每条结构变更都需先判断是否已存在（见 addColumnIfMissing）。
// - predicate 用于旧库识别：返回 true 表示当前结构已经满足该版本最终形态（只登记即可）。
// - 新版本一律在数组末尾追加，并保持 up 幂等。

// 某列不存在时才 ADD COLUMN；用于无版本登记的旧库幂等补列。
function addColumnIfMissing(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// 索引名存在性判断（SQLite 内模式名全局唯一，按库查询即可）
function indexExists(db, indexName) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName) != null;
}

function createIndexIfMissing(db, indexName, ddl) {
  if (!indexExists(db, indexName)) db.exec(ddl);
}

const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    description: '初始结构：视频、片段、发布快照',
    predicate: (db) => {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
      );
      return ['videos', 'segments', 'publications'].every((t) => tables.has(t));
    },
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS videos (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          title         TEXT    NOT NULL,
          storage_name  TEXT    NOT NULL,
          original_name TEXT    NOT NULL,
          mime_type     TEXT,
          size_bytes    INTEGER NOT NULL,
          duration_ms   INTEGER NOT NULL CHECK (duration_ms > 0),
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
          updated_at INTEGER NOT NULL,
          UNIQUE (video_id, id)
        );

        CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_id, start_ms);

        CREATE TABLE IF NOT EXISTS publications (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id     INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          version      INTEGER NOT NULL,
          snapshot     TEXT    NOT NULL,
          segment_count INTEGER NOT NULL,
          published_at INTEGER NOT NULL,
          UNIQUE (video_id, version)
        );

        CREATE INDEX IF NOT EXISTS idx_publications_video ON publications(video_id, version);
      `);
    },
  },
  {
    version: 2,
    name: 'translation_track',
    description: '译文轨道：视频译文语言列与 translations 表',
    predicate: (db) => {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
      );
      if (!tables.has('translations')) return false;
      const videoCols = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name);
      return videoCols.includes('translation_lang');
    },
    up: (db) => {
      addColumnIfMissing(db, 'videos', 'translation_lang', 'TEXT');
      db.exec(`
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
      `);
      createIndexIfMissing(db, 'idx_translations_video',
        'CREATE INDEX idx_translations_video ON translations(video_id)');
    },
  },
  {
    version: 3,
    name: 'quality_control',
    description: '质检：每视频规则表与单项放行（豁免）表',
    predicate: (db) => {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
      );
      return tables.has('qc_rules') && tables.has('qc_waivers');
    },
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS qc_rules (
          video_id                  INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
          source_max_cps            REAL,
          source_max_line_chars     INTEGER,
          translation_max_cps       REAL,
          translation_max_line_chars INTEGER,
          revision                  INTEGER NOT NULL DEFAULT 1,
          updated_at                INTEGER NOT NULL
        );

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
      `);
      createIndexIfMissing(db, 'idx_qc_waivers_video',
        'CREATE INDEX idx_qc_waivers_video ON qc_waivers(video_id, segment_id)');
    },
  },
  {
    version: 4,
    name: 'speakers_and_publish_snapshots',
    description: '说话人名单、片段归属列，发布快照补充译文/质检/说话人列',
    predicate: (db) => {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
      );
      if (!tables.has('speakers')) return false;
      const segCols = db.prepare('PRAGMA table_info(segments)').all().map((c) => c.name);
      const videoCols = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name);
      const pubCols = db.prepare('PRAGMA table_info(publications)').all().map((c) => c.name);
      return segCols.includes('speaker_id')
        && videoCols.includes('speakers_revision')
        && ['translation_snapshot', 'translation_lang', 'qc_rules_snapshot', 'qc_report_snapshot', 'speaker_snapshot']
          .every((c) => pubCols.includes(c));
    },
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS speakers (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (video_id, name)
        );
      `);
      createIndexIfMissing(db, 'idx_speakers_video',
        'CREATE INDEX idx_speakers_video ON speakers(video_id, id)');
      addColumnIfMissing(db, 'segments', 'speaker_id',
        'INTEGER REFERENCES speakers(id) ON DELETE SET NULL');
      createIndexIfMissing(db, 'idx_segments_speaker',
        'CREATE INDEX idx_segments_speaker ON segments(speaker_id)');
      addColumnIfMissing(db, 'videos', 'speakers_revision', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'publications', 'translation_snapshot', 'TEXT');
      addColumnIfMissing(db, 'publications', 'translation_lang', 'TEXT');
      addColumnIfMissing(db, 'publications', 'qc_rules_snapshot', 'TEXT');
      addColumnIfMissing(db, 'publications', 'qc_report_snapshot', 'TEXT');
      addColumnIfMissing(db, 'publications', 'speaker_snapshot', 'TEXT');
    },
  },
];

module.exports = { migrations };
