'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
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
  `);

  // 旧库迁移：为已存在的表补充译文轨道相关列（新库已由上方 CREATE 携带则跳过）
  const videoCols = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name);
  if (!videoCols.includes('translation_lang')) {
    db.exec('ALTER TABLE videos ADD COLUMN translation_lang TEXT');
  }
  if (!videoCols.includes('speakers_revision')) {
    db.exec('ALTER TABLE videos ADD COLUMN speakers_revision INTEGER NOT NULL DEFAULT 0');
  }
  const segCols = db.prepare('PRAGMA table_info(segments)').all().map((c) => c.name);
  if (!segCols.includes('speaker_id')) {
    // speakers 表已由上方 CREATE IF NOT EXISTS 建好；旧片段默认未归属（NULL）
    db.exec('ALTER TABLE segments ADD COLUMN speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL');
  }
  // 新库与已完成加列的旧库都确保存在归属索引（旧库 speaker_id 列不存在时不能提前建）
  db.exec('CREATE INDEX IF NOT EXISTS idx_segments_speaker ON segments(speaker_id)');
  const pubCols = db.prepare('PRAGMA table_info(publications)').all().map((c) => c.name);
  if (!pubCols.includes('translation_snapshot')) {
    db.exec('ALTER TABLE publications ADD COLUMN translation_snapshot TEXT');
  }
  if (!pubCols.includes('translation_lang')) {
    db.exec('ALTER TABLE publications ADD COLUMN translation_lang TEXT');
  }
  if (!pubCols.includes('qc_rules_snapshot')) {
    db.exec('ALTER TABLE publications ADD COLUMN qc_rules_snapshot TEXT');
  }
  if (!pubCols.includes('qc_report_snapshot')) {
    db.exec('ALTER TABLE publications ADD COLUMN qc_report_snapshot TEXT');
  }
  if (!pubCols.includes('speaker_snapshot')) {
    db.exec('ALTER TABLE publications ADD COLUMN speaker_snapshot TEXT');
  }

  return db;
}

function get() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

module.exports = { init, get };
