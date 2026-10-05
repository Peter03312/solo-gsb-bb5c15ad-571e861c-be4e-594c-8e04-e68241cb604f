'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { get } = require('./db');
const { ApiError, isInt, validateTimeline } = require('./validation');
const { buildSrt, parseSrt } = require('./srt');
const { buildQcReport, mapQcRules } = require('./qc');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'videos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024 },
});

// SRT 文件较小，仅在内存中解析，不落盘
const MAX_SRT_BYTES = Number(process.env.MAX_SRT_KB || 10240) * 1024;
const srtUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SRT_BYTES },
});

// 预览令牌签名密钥：随进程生成；服务重启后旧预览令牌失效（要求重新预览，符合语义）
const TOKEN_SECRET = crypto.randomBytes(32);

const router = express.Router();

const now = () => Date.now();

function mapSegment(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    text: row.text,
    reviewed: row.reviewed === 1,
    revision: row.revision,
    speaker_id: row.speaker_id == null ? null : row.speaker_id,
    speaker_name: row.speaker_name == null ? null : row.speaker_name,
    updated_at: row.updated_at,
  };
}

// 片段查询：LEFT JOIN 说话人，一并带出当前名称（改名后草稿片段立即显示新名；
// 发布快照另存当时名称，不受后续改名影响）
const SEGMENT_SELECT = `
  SELECT s.*, sp.name AS speaker_name
  FROM segments s
  LEFT JOIN speakers sp ON sp.id = s.speaker_id`;

function loadVideo(videoId) {
  const video = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
  return video;
}

function listSegments(videoId) {
  return get()
    .prepare(`${SEGMENT_SELECT} WHERE s.video_id = ? ORDER BY s.start_ms, s.id`)
    .all(videoId)
    .map(mapSegment);
}

/* ---------------- 说话人名单 ---------------- */

function mapSpeaker(row, usageCount) {
  const count = usageCount != null
    ? usageCount
    : (row.usage_count != null
      ? row.usage_count
      : get().prepare('SELECT COUNT(*) AS n FROM segments WHERE speaker_id = ?').get(row.id).n);
  return {
    id: row.id,
    video_id: row.video_id,
    name: row.name,
    usage_count: count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 名单（带每个说话人被多少个草稿片段引用）；未归属片段不影响名单本身
function listSpeakers(videoId) {
  return get()
    .prepare(
      `SELECT sp.*,
              (SELECT COUNT(*) FROM segments s WHERE s.speaker_id = sp.id) AS usage_count
       FROM speakers sp WHERE sp.video_id = ? ORDER BY sp.id`
    )
    .all(videoId)
    .map((row) => mapSpeaker(row, row.usage_count));
}

function unassignedSegmentIds(videoId) {
  return get()
    .prepare('SELECT id FROM segments WHERE video_id = ? AND speaker_id IS NULL ORDER BY start_ms, id')
    .all(videoId)
    .map((r) => r.id);
}

function rosterCurrent(videoId) {
  const video = get().prepare('SELECT speakers_revision FROM videos WHERE id = ?').get(videoId);
  return { list_revision: video ? video.speakers_revision : 0, speakers: listSpeakers(videoId) };
}

// 名单写操作（增/改/删）携带所见名单修订号；首次新增时传 0
function parseListRevision(body) {
  const n = Number(body && body.list_revision);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(422, 'missing_revision', '请携带所见名单修订号 list_revision（首次修改传 0）');
  }
  return n;
}

function normalizeSpeakerName(value) {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'invalid_speaker_name', '说话人名称 name 必须为字符串');
  }
  const name = value.trim();
  if (!name) throw new ApiError(422, 'invalid_speaker_name', '说话人名称去首尾空白后不能为空');
  if (/[\r\n]/.test(name)) throw new ApiError(422, 'invalid_speaker_name', '说话人名称不能包含换行');
  if (name.length > 100) throw new ApiError(422, 'invalid_speaker_name', '说话人名称不能超过 100 个字符');
  return name;
}

function loadSpeakerRow(videoId, speakerId) {
  return get()
    .prepare('SELECT * FROM speakers WHERE id = ? AND video_id = ?')
    .get(speakerId, videoId);
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'invalid_text', '字幕文本必须为字符串');
  }
  if (value.length > 10000) {
    throw new ApiError(422, 'invalid_text', '字幕文本过长（上限 10000 字符）');
  }
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseRevision(body) {
  const rev = Number(body && body.revision);
  if (!Number.isInteger(rev) || rev < 1) {
    throw new ApiError(422, 'missing_revision', '请携带所见修订号 revision（正整数）');
  }
  return rev;
}

function mapPublication(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    version: row.version,
    segment_count: row.segment_count,
    has_translation: row.translation_snapshot != null,
    translation_lang: row.translation_lang != null ? row.translation_lang : null,
    has_qc: row.qc_rules_snapshot != null,
    has_speakers: row.speaker_snapshot != null,
    published_at: row.published_at,
  };
}

/* ---------------- 译文轨道 ---------------- */

// 译文是否失效：译文录入/更新时绑定的原文内容（时间与文字）与当前原文不一致即失效；
// 仅切换原文审校状态不影响（不参与比较）
function isTranslationStale(trRow, segRow) {
  return (
    trRow.source_start_ms !== segRow.start_ms ||
    trRow.source_end_ms !== segRow.end_ms ||
    trRow.source_text !== segRow.text
  );
}

function mapTranslationJoined(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    segment_id: row.segment_id,
    text: row.text,
    reviewed: row.reviewed === 1,
    revision: row.revision,
    stale: isTranslationStale(row, { start_ms: row.seg_start, end_ms: row.seg_end, text: row.seg_text }),
    source_start_ms: row.source_start_ms,
    source_end_ms: row.source_end_ms,
    source_text: row.source_text,
    updated_at: row.updated_at,
  };
}

const TRANSLATION_JOIN = `
  SELECT t.*, s.start_ms AS seg_start, s.end_ms AS seg_end, s.text AS seg_text
  FROM translations t
  JOIN segments s ON s.id = t.segment_id AND s.video_id = t.video_id`;

function listTranslations(videoId) {
  return get()
    .prepare(`${TRANSLATION_JOIN} WHERE t.video_id = ? ORDER BY s.start_ms, s.id`)
    .all(videoId)
    .map(mapTranslationJoined);
}

function getTranslationRow(videoId, segmentId) {
  return get()
    .prepare(`${TRANSLATION_JOIN} WHERE t.video_id = ? AND t.segment_id = ?`)
    .get(videoId, segmentId);
}

// 译文写操作（录入/修改/审校）必须携带「所见原文修订号 + 所见译文修订号」；
// 过期一律 409 并返回当前原文与译文状态，绝不覆盖他人修改
function requireTrack(video) {
  if (!video.translation_lang) {
    throw new ApiError(422, 'no_translation_track', `视频 #${video.id} 尚未启用译文轨道，请先启用指定语言的译文轨道`);
  }
}

function parseSegmentRevision(body) {
  const rev = Number(body && body.segment_revision);
  if (!Number.isInteger(rev) || rev < 1) {
    throw new ApiError(422, 'missing_revision', '请携带所见原文修订号 segment_revision（正整数）');
  }
  return rev;
}

function conflictCurrent(videoId, segmentId) {
  const seg = get()
    .prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`)
    .get(segmentId, videoId);
  const tr = getTranslationRow(videoId, segmentId);
  return { segment: seg ? mapSegment(seg) : null, translation: tr ? mapTranslationJoined(tr) : null };
}

// 启用译文轨道（同一视频仅可启用一个指定语言；换语言须先停用）
router.put('/videos/:id(\\d+)/translation/track', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const language = typeof req.body.language === 'string' ? req.body.language.trim() : '';
    if (!language || language.length > 40 || /[\r\n]/.test(language)) {
      throw new ApiError(422, 'invalid_language', '请指定译文语言 language（1–40 个字符、不含换行，如 en / zh-Hans / 日语）');
    }
    if (video.translation_lang === language) {
      res.json({ ok: true, translation_lang: video.translation_lang, already_enabled: true });
      return;
    }
    if (video.translation_lang) {
      throw new ApiError(422, 'track_exists',
        `该视频已启用「${video.translation_lang}」译文轨道；同一视频仅支持一个指定语言，如需更换请先停用当前轨道（将删除全部译文）`);
    }
    get().prepare('UPDATE videos SET translation_lang = ? WHERE id = ?').run(language, video.id);
    res.status(201).json({ ok: true, translation_lang: language, already_enabled: false });
  } catch (err) {
    next(err);
  }
});

// 停用译文轨道：删除该视频全部译文（发布版本快照不受影响）
router.delete('/videos/:id(\\d+)/translation/track', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    if (!video.translation_lang) {
      throw new ApiError(404, 'no_translation_track', `视频 #${video.id} 未启用译文轨道`);
    }
    get().transaction(() => {
      get().prepare('DELETE FROM translations WHERE video_id = ?').run(video.id);
      // 译文轨道停用：译文放行随轨道语言失效（行保留为历史）；原文放行不受影响
      get().prepare(
        `UPDATE qc_waivers SET active = 0, revoked_at = ? WHERE video_id = ? AND track = 'translation' AND active = 1`
      ).run(now(), video.id);
      get().prepare('UPDATE videos SET translation_lang = NULL WHERE id = ?').run(video.id);
    })();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 录入 / 修改译文：{text, segment_revision, revision?（已存在译文时必填）}
// 修改译文（文字变化或原文已变化需重新绑定）会撤销其审校状态
router.put('/videos/:id(\\d+)/segments/:sid(\\d+)/translation', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    requireTrack(video);
    const text = normalizeText(req.body.text != null ? req.body.text : '');
    const segRev = parseSegmentRevision(req.body);
    const segmentId = Number(req.params.sid);

    const result = get().transaction(() => {
      const seg = get().prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`).get(segmentId, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${segmentId} 不存在`);
      if (seg.revision !== segRev) {
        throw new ApiError(409, 'revision_conflict',
          '原文修订号已过期：该片段已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
          { current: conflictCurrent(video.id, segmentId) });
      }
      const existing = getTranslationRow(video.id, segmentId);
      if (existing) {
        const rev = parseRevision(req.body);
        if (existing.revision !== rev) {
          throw new ApiError(409, 'revision_conflict',
            '译文修订号已过期：该译文已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
            { current: conflictCurrent(video.id, segmentId) });
        }
        // 文字被修改，或原文已变化（译文失效）需重新绑定当前原文 -> 撤销译文审校
        const changed = existing.text !== text || isTranslationStale(existing, seg);
        get().prepare(
          `UPDATE translations
           SET text = ?, reviewed = ?, revision = revision + 1,
               source_start_ms = ?, source_end_ms = ?, source_text = ?, updated_at = ?
           WHERE id = ?`
        ).run(text, changed ? 0 : existing.reviewed, seg.start_ms, seg.end_ms, seg.text, now(), existing.id);
        // 译文文本被修改：该片段的译文质检放行按「当时文本」绑定，立即失效并保留历史；
        // 若仅为原文已变（stale）后的重新绑定，原文修改事务内已吊销过该片段放行，此处幂等
        if (existing.text !== text) deactivateTranslationQcWaivers(get(), segmentId, now());
        return { created: false, translation: mapTranslationJoined(getTranslationRow(video.id, segmentId)) };
      }
      const ts = now();
      const info = get().prepare(
        `INSERT INTO translations (video_id, segment_id, text, reviewed, revision,
                                   source_start_ms, source_end_ms, source_text, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`
      ).run(video.id, segmentId, text, seg.start_ms, seg.end_ms, seg.text, ts, ts);
      return { created: true, translation: mapTranslationJoined(getTranslationRow(video.id, segmentId)) };
    })();

    res.status(result.created ? 201 : 200).json({
      translation: result.translation,
      translations: listTranslations(video.id),
    });
  } catch (err) {
    next(err);
  }
});

// 审校 / 取消审校译文：{reviewed, segment_revision, revision}
// 已失效译文（原文已变更）不能标记已审，需先按当前原文重新校对译文
router.post('/videos/:id(\\d+)/segments/:sid(\\d+)/translation/review', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    requireTrack(video);
    const segRev = parseSegmentRevision(req.body);
    const rev = parseRevision(req.body);
    const reviewed = req.body.reviewed === true || req.body.reviewed === false ? req.body.reviewed : null;
    if (reviewed == null) throw new ApiError(422, 'invalid_reviewed', '请提交 reviewed: true/false');
    const segmentId = Number(req.params.sid);

    const translation = get().transaction(() => {
      const seg = get().prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`).get(segmentId, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${segmentId} 不存在`);
      if (seg.revision !== segRev) {
        throw new ApiError(409, 'revision_conflict',
          '原文修订号已过期：该片段已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
          { current: conflictCurrent(video.id, segmentId) });
      }
      const tr = getTranslationRow(video.id, segmentId);
      if (!tr) throw new ApiError(404, 'translation_not_found', `片段 #${segmentId} 尚无译文，请先录入译文`);
      if (tr.revision !== rev) {
        throw new ApiError(409, 'revision_conflict',
          '译文修订号已过期：该译文已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
          { current: conflictCurrent(video.id, segmentId) });
      }
      if (reviewed && isTranslationStale(tr, seg)) {
        throw new ApiError(422, 'translation_stale',
          '译文已失效：原文的文字或时间已变化，请先按当前原文重新校对译文，再标记审校',
          { current: conflictCurrent(video.id, segmentId) });
      }
      get().prepare('UPDATE translations SET reviewed = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(reviewed ? 1 : 0, now(), tr.id);
      return mapTranslationJoined(getTranslationRow(video.id, segmentId));
    })();

    res.json({ translation, translations: listTranslations(video.id) });
  } catch (err) {
    next(err);
  }
});


/* ---------------- 质检（QC）规则与放行 ---------------- */

function loadQcRulesRow(videoId) {
  return get().prepare('SELECT * FROM qc_rules WHERE video_id = ?').get(videoId);
}

// 解析单个阈值：省略/undefined -> undefined（不更新）；null -> null（清除配置）；
// 否则必须为正数（max_line_chars 还须为整数）。返回 { value, set, clear }。
function parseThreshold(body, key, { integer }) {
  const raw = body[key];
  if (raw === undefined) return undefined; // 未提交：不改动
  if (raw === null) return null; // 显式清除
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    throw new ApiError(422, 'invalid_qc_threshold',
      `质检阈值 ${key} 必须为正数（或 null 表示不配置该项）`);
  }
  if (integer && !Number.isInteger(num)) {
    throw new ApiError(422, 'invalid_qc_threshold',
      `质检阈值 ${key}（最大单行字符数）必须为正整数`);
  }
  return num;
}

// 读 PUT 规则体：只接受已知字段；任何已提交字段非法都 422（整次不写入）
function readQcRulesBody(body) {
  if (!body || typeof body !== 'object') {
    throw new ApiError(422, 'invalid_qc_rules', '请提交 JSON 规则体');
  }
  const keys = ['source_max_cps', 'source_max_line_chars', 'translation_max_cps', 'translation_max_line_chars'];
  if (!keys.some((k) => body[k] !== undefined)) {
    throw new ApiError(422, 'invalid_qc_rules',
      '请至少提交一个阈值字段（null 清除；正数配置）：' + keys.join(' / '));
  }
  return {
    source_max_cps: parseThreshold(body, 'source_max_cps', { integer: false }),
    source_max_line_chars: parseThreshold(body, 'source_max_line_chars', { integer: true }),
    translation_max_cps: parseThreshold(body, 'translation_max_cps', { integer: false }),
    translation_max_line_chars: parseThreshold(body, 'translation_max_line_chars', { integer: true }),
  };
}

function parseQcRulesRevision(body) {
  if (!(body && Number.isInteger(body.rules_revision)) && !(body && typeof body.rules_revision === 'number')) {
    const n = Number(body && body.rules_revision);
    if (!Number.isInteger(n) || n < 0) {
      throw new ApiError(422, 'missing_revision', '请携带所见规则修订号 rules_revision（首次配置传 0）');
    }
    return n;
  }
  const n = Number(body.rules_revision);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(422, 'missing_revision', '规则修订号 rules_revision 必须为非负整数');
  }
  return n;
}

function listQcWaiverRows(videoId) {
  return get()
    .prepare('SELECT * FROM qc_waivers WHERE video_id = ? ORDER BY id')
    .all(videoId);
}

function loadLiveQc(video) {
  const segments = listSegments(video.id);
  const translations = video.translation_lang ? listTranslations(video.id) : [];
  const bySeg = new Map(translations.map((t) => [t.segment_id, t]));
  const rulesRow = loadQcRulesRow(video.id);
  const waiverRows = listQcWaiverRows(video.id);
  return buildQcReport({
    language: video.translation_lang != null ? video.translation_lang : null,
    segments,
    translationBySegment: bySeg,
    rulesRow,
    waiverRows,
  });
}

// 规则变化后：全部仍有效的放行按「当时阈值」绑定规则修订号，整体失效（行保留为历史）
function deactivateAllQcWaivers(dbx, videoId, ts) {
  dbx.prepare(
    `UPDATE qc_waivers SET active = 0, revoked_at = ? WHERE video_id = ? AND active = 1`
  ).run(ts, videoId);
}

// 原文片段的时间或文本变化：该片段所有放行失效（仅切换审校状态不调用）
function deactivateSegmentQcWaivers(dbx, segmentId, ts) {
  dbx.prepare(
    `UPDATE qc_waivers SET active = 0, revoked_at = ? WHERE segment_id = ? AND active = 1`
  ).run(ts, segmentId);
}

// 译文文本变化（重新保存即重新校对）：该片段的译文放行失效
function deactivateTranslationQcWaivers(dbx, segmentId, ts) {
  dbx.prepare(
    `UPDATE qc_waivers SET active = 0, revoked_at = ? WHERE segment_id = ? AND track = 'translation' AND active = 1`
  ).run(ts, segmentId);
}

// GET 当前草稿质检结果（逐段列出轨道、实测值、阈值与违规项；含全部放行历史）
router.get('/videos/:id(\\d+)/qc', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const report = loadLiveQc(video);
    res.json({
      video_id: video.id,
      translation_lang: video.translation_lang != null ? video.translation_lang : null,
      duration_ms: video.duration_ms,
      ...report,
    });
  } catch (err) {
    next(err);
  }
});

// PUT 配置/修改质检阈值（乐观锁 rules_revision；首次传 0）。
// 规则变化使全部有效放行失效，但历史放行行保留。
router.put('/videos/:id(\\d+)/qc/rules', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const incoming = readQcRulesBody(req.body);
    const expectedRev = parseQcRulesRevision(req.body);

    const result = get().transaction(() => {
      const video = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!video) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      const existing = get().prepare('SELECT * FROM qc_rules WHERE video_id = ?').get(videoId);
      const currentRev = existing ? existing.revision : 0;
      if (currentRev !== expectedRev) {
        throw new ApiError(409, 'revision_conflict',
          '规则修订号已过期：质检规则已被他人修改，已返回当前规则，请基于当前规则重试',
          { current_rules: mapQcRules(existing), rules_revision: currentRev });
      }
      // 以当前值为底，按提交字段覆盖
      const next = {
        source_max_cps: existing ? existing.source_max_cps : null,
        source_max_line_chars: existing ? existing.source_max_line_chars : null,
        translation_max_cps: existing ? existing.translation_max_cps : null,
        translation_max_line_chars: existing ? existing.translation_max_line_chars : null,
      };
      for (const k of Object.keys(next)) {
        if (incoming[k] !== undefined) next[k] = incoming[k];
      }
      const ts = now();
      if (existing) {
        get().prepare(
          `UPDATE qc_rules SET source_max_cps = ?, source_max_line_chars = ?,
             translation_max_cps = ?, translation_max_line_chars = ?,
             revision = revision + 1, updated_at = ? WHERE video_id = ?`
        ).run(next.source_max_cps, next.source_max_line_chars,
          next.translation_max_cps, next.translation_max_line_chars, ts, videoId);
        // 阈值（规则修订号）变化 -> 既有放行全部失效并保留历史
        deactivateAllQcWaivers(get(), videoId, ts);
      } else {
        get().prepare(
          `INSERT INTO qc_rules (video_id, source_max_cps, source_max_line_chars,
             translation_max_cps, translation_max_line_chars, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`
        ).run(videoId, next.source_max_cps, next.source_max_line_chars,
          next.translation_max_cps, next.translation_max_line_chars, ts);
      }
      return get().prepare('SELECT * FROM qc_rules WHERE video_id = ?').get(videoId);
    })();

    res.json({ ok: true, rules: mapQcRules(result), rules_revision: result.revision });
  } catch (err) {
    next(err);
  }
});

// PUT 对单项违规填写理由放行：
// { track, rule, reason, segment_revision, revision?（译文放行时=译文修订号）}
// 放行绑定片段时间、文本、轨道语言与当时阈值；并发修改用修订号拒绝过期提交并返回当前状态。
router.put('/videos/:id(\\d+)/segments/:sid(\\d+)/qc/waiver', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const segmentId = Number(req.params.sid);
    const track = req.body && req.body.track === 'translation' ? 'translation'
      : req.body && req.body.track === 'source' ? 'source' : null;
    if (!track) throw new ApiError(422, 'invalid_qc_track', '请指定放行轨道 track：source（原文）或 translation（译文）');
    const rule = req.body && (req.body.rule === 'max_cps' || req.body.rule === 'max_line_chars')
      ? req.body.rule : null;
    if (!rule) throw new ApiError(422, 'invalid_qc_rule', '请指定违规项 rule：max_cps 或 max_line_chars');
    const reason = typeof (req.body && req.body.reason) === 'string' ? req.body.reason.trim() : '';
    if (!reason) throw new ApiError(422, 'invalid_waiver_reason', '请填写放行理由 reason（不能为空）');
    if (reason.length > 500) throw new ApiError(422, 'invalid_waiver_reason', '放行理由不能超过 500 个字符');

    const result = get().transaction(() => {
      const video = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!video) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      const seg = get().prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`).get(segmentId, videoId);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${segmentId} 不存在`);
      const segRev = parseSegmentRevision(req.body);
      if (seg.revision !== segRev) {
        throw new ApiError(409, 'revision_conflict',
          '原文修订号已过期：该片段已被他人修改，请基于当前内容重新质检后再放行',
          { current: conflictCurrent(videoId, segmentId) });
      }

      let tr = null;
      if (track === 'translation') {
        if (!video.translation_lang) {
          throw new ApiError(422, 'no_translation_track', `视频 #${videoId} 尚未启用译文轨道，不能对译文违规放行`);
        }
        tr = getTranslationRow(videoId, segmentId);
        if (!tr) throw new ApiError(404, 'translation_not_found', `片段 #${segmentId} 尚无译文，不能对译文违规放行`);
        const trRev = parseRevision(req.body);
        if (tr.revision !== trRev) {
          throw new ApiError(409, 'revision_conflict',
            '译文修订号已过期：该译文已被他人修改，请基于当前内容重新质检后再放行',
            { current: conflictCurrent(videoId, segmentId) });
        }
      }

      // 放行必须针对「当前确实存在、未被放行」的违规，且对应阈值已配置
      const rulesRow = loadQcRulesRow(videoId);
      const live = loadLiveQc(video);
      const segResult = live.segments.find((x) => x.segment_id === segmentId);
      const item = segResult && segResult[track === 'source' ? 'source' : 'translation'];
      const found = item && item.items.find((it) =>
        it.rule === rule && it.violation);
      if (!found) {
        throw new ApiError(422, 'no_such_violation',
          `当前片段 #${segmentId} 的${track === 'source' ? '原文' : '译文'}不存在「${rule}」违规（可能阈值未配置或内容已修改），无需放行`,
          { current_qc: live });
      }
      if (found.waived) {
        throw new ApiError(422, 'waiver_exists',
          `该违规已有有效放行（理由：${found.waiver.reason}）；绑定的内容或阈值变化后旧放行才会失效`,
          { current_qc: live, waiver: found.waiver });
      }

      const ts = now();
      const info = get().prepare(
        `INSERT INTO qc_waivers (video_id, segment_id, track, rule, language, reason, active,
           bound_start_ms, bound_end_ms, bound_text, bound_rules_revision,
           bound_source_max_cps, bound_source_max_line_chars,
           bound_translation_max_cps, bound_translation_max_line_chars, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(
        videoId, segmentId, track, rule,
        track === 'translation' ? video.translation_lang : null,
        reason,
        seg.start_ms, seg.end_ms,
        track === 'translation' ? tr.text : seg.text,
        rulesRow ? rulesRow.revision : 0,
        rulesRow ? rulesRow.source_max_cps : null,
        rulesRow ? rulesRow.source_max_line_chars : null,
        rulesRow ? rulesRow.translation_max_cps : null,
        rulesRow ? rulesRow.translation_max_line_chars : null,
        ts
      );
      return get().prepare('SELECT * FROM qc_waivers WHERE id = ?').get(info.lastInsertRowid);
    })();

    const video = loadVideo(videoId);
    const report = loadLiveQc(video);
    res.status(201).json({ waiver: result, qc: report });
  } catch (err) {
    next(err);
  }
});


/* ---------------- 视频 ---------------- */

router.get('/videos', (req, res) => {
  const rows = get()
    .prepare(
      `SELECT v.*,
              (SELECT COUNT(*) FROM segments s WHERE s.video_id = v.id) AS segment_count,
              (SELECT COUNT(*) FROM segments s WHERE s.video_id = v.id AND s.reviewed = 1) AS reviewed_count,
              (SELECT MAX(p.version) FROM publications p WHERE p.video_id = v.id) AS latest_version
       FROM videos v ORDER BY v.created_at DESC`
    )
    .all();
  res.json({ videos: rows });
});

router.post('/videos', upload.single('video'), (req, res, next) => {
  let savedPath = null;
  try {
    const title = (req.body.title || '').trim();
    const durationMs = Number(req.body.duration_ms);
    if (!title) throw new ApiError(422, 'invalid_title', '请填写视频标题');
    if (!req.file) throw new ApiError(422, 'missing_file', '请上传视频文件（字段名 video）');
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new ApiError(422, 'invalid_duration', '请由浏览器读取并提交正整数形式的视频时长 duration_ms（毫秒）');
    }

    savedPath = req.file.path;
    const info = get()
      .prepare(
        `INSERT INTO videos (title, storage_name, original_name, mime_type, size_bytes, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, durationMs, now());

    const video = loadVideo(info.lastInsertRowid);
    res.status(201).json({ video, segments: [], publications: [] });
  } catch (err) {
    if (savedPath) fs.promises.unlink(savedPath).catch(() => {});
    next(err);
  }
});

router.get('/videos/:id(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const qcReport = loadLiveQc(video);
    const speakers = listSpeakers(video.id);
    const unassignedIds = unassignedSegmentIds(video.id);
    res.json({
      video,
      segments: listSegments(video.id),
      speakers,
      list_revision: video.speakers_revision,
      unassigned_segment_ids: unassignedIds,
      translation_lang: video.translation_lang != null ? video.translation_lang : null,
      translations: video.translation_lang ? listTranslations(video.id) : [],
      qc_rules: mapQcRules(loadQcRulesRow(video.id)),
      qc: {
        configured: qcReport.configured,
        violation_count: qcReport.violation_count,
        blocking_count: qcReport.blocking_count,
        active_waiver_count: qcReport.active_waiver_count,
        inactive_waiver_count: qcReport.inactive_waiver_count,
      },
      publications: get()
        .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC')
        .all(video.id)
        .map(mapPublication),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/videos/:id(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const tx = get().transaction(() => {
      get().prepare('DELETE FROM segments WHERE video_id = ?').run(video.id);
      get().prepare('DELETE FROM publications WHERE video_id = ?').run(video.id);
      get().prepare('DELETE FROM videos WHERE id = ?').run(video.id);
    });
    tx();
    fs.promises.unlink(path.join(UPLOAD_DIR, video.storage_name)).catch(() => {});
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 视频流（支持 Range 拖动播放）
router.get('/videos/:id(\\d+)/media', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const filePath = path.join(UPLOAD_DIR, video.storage_name);
    if (!fs.existsSync(filePath)) throw new ApiError(404, 'file_missing', '视频文件在服务器上缺失');

    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size) {
        res.status(416).set({ 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': video.mime_type || 'application/octet-stream',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.set({
        'Accept-Ranges': 'bytes',
        'Content-Length': stat.size,
        'Content-Type': video.mime_type || 'application/octet-stream',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    next(err);
  }
});

/* ---------------- 字幕片段 ---------------- */

// 事务内基于库内最新全量片段做校验；冲突/非法均不改动任何数据
function mutateSegment(videoId, existingId, candidate, expectedRevision) {
  const dbx = get();
  return dbx.transaction(() => {
    const video = dbx.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);

    let existing = null;
    if (existingId != null) {
      existing = dbx
        .prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`)
        .get(existingId, videoId);
      if (!existing) throw new ApiError(404, 'segment_not_found', `片段 #${existingId} 不存在`);
      if (existing.revision !== expectedRevision) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，已为你加载最新内容，请基于当前内容重试', {
          current: mapSegment(existing),
        });
      }
    }

    const all = dbx.prepare('SELECT * FROM segments WHERE video_id = ?').all(videoId);
    const timeline = all.map((row) =>
      row.id === existingId ? { id: row.id, start_ms: candidate.start_ms, end_ms: candidate.end_ms } : row
    );
    if (existingId == null) {
      timeline.push({ id: '(new)', start_ms: candidate.start_ms, end_ms: candidate.end_ms });
    }

    const check = validateTimeline(timeline, video.duration_ms);
    if (!check.ok) {
      throw new ApiError(422, 'invalid_timeline', check.reason, existing ? { current: mapSegment(existing) } : {});
    }

    if (existingId == null) {
      const info = dbx
        .prepare(
          `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, speaker_id, updated_at)
           VALUES (?, ?, ?, ?, 0, 1, NULL, ?)`
        )
        .run(videoId, candidate.start_ms, candidate.end_ms, candidate.text, now());
      return mapSegment(
        dbx.prepare(`${SEGMENT_SELECT} WHERE s.id = ?`).get(info.lastInsertRowid)
      );
    }

    // 内容（时间或文本）被修改 -> 撤销审校状态；仅切换审校不走此接口
    const contentChanged =
      existing.start_ms !== candidate.start_ms ||
      existing.end_ms !== candidate.end_ms ||
      existing.text !== candidate.text;

    const nextReviewed = contentChanged ? 0 : existing.reviewed;
    dbx
      .prepare(
        `UPDATE segments SET start_ms = ?, end_ms = ?, text = ?, reviewed = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(candidate.start_ms, candidate.end_ms, candidate.text, nextReviewed, now(), existingId);
    // 原文时间或文字变化：该片段全部质检放行失效（仅切换审校状态不走这里）；历史行保留
    if (contentChanged) deactivateSegmentQcWaivers(dbx, existingId, now());

    return mapSegment(
      dbx.prepare(`${SEGMENT_SELECT} WHERE s.id = ?`).get(existingId)
    );
  })();
}

function readCandidate(body, fallback) {
  if (body.start_ms == null || body.end_ms == null) {
    throw new ApiError(422, 'missing_fields', '请同时提供 start_ms 与 end_ms（毫秒）');
  }
  const startMs = Number(body.start_ms);
  const endMs = Number(body.end_ms);
  if (!isInt(startMs) || !isInt(endMs)) {
    throw new ApiError(422, 'invalid_time', '起止时间必须为整数毫秒');
  }
  const text = normalizeText(body.text != null ? body.text : fallback != null ? fallback.text : '');
  return { start_ms: startMs, end_ms: endMs, text };
}

router.post('/videos/:id(\\d+)/segments', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const candidate = readCandidate(req.body, null);
    const created = mutateSegment(video.id, null, candidate, null);
    res.status(201).json({ segment: created, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

router.put('/videos/:id(\\d+)/segments/:sid(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    const existing = get()
      .prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`)
      .get(req.params.sid, video.id);
    if (!existing) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
    const merged = {
      start_ms: req.body.start_ms != null ? Number(req.body.start_ms) : existing.start_ms,
      end_ms: req.body.end_ms != null ? Number(req.body.end_ms) : existing.end_ms,
      text: req.body.text != null ? normalizeText(req.body.text) : existing.text,
    };
    if (!isInt(merged.start_ms) || !isInt(merged.end_ms)) {
      throw new ApiError(422, 'invalid_time', '起止时间必须为整数毫秒', { current: mapSegment(existing) });
    }
    const updated = mutateSegment(video.id, existing.id, merged, expected);
    res.json({ segment: updated, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

// 审校 / 取消审校；修改已审片段的内容会由 PUT 自动撤销审校
router.post('/videos/:id(\\d+)/segments/:sid(\\d+)/review', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    const reviewed = req.body.reviewed === true || req.body.reviewed === false ? req.body.reviewed : null;
    if (reviewed == null) throw new ApiError(422, 'invalid_reviewed', '请提交 reviewed: true/false');

    const result = get().transaction(() => {
      const seg = get()
        .prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`)
        .get(req.params.sid, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
      if (seg.revision !== expected) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，已为你加载最新内容，请基于当前内容重试', {
          current: mapSegment(seg),
        });
      }
      // 审校前再次确认时间合法，避免对非法草稿盖章
      const timeline = get()
        .prepare('SELECT id, start_ms, end_ms FROM segments WHERE video_id = ?')
        .all(video.id);
      const check = validateTimeline(timeline, video.duration_ms);
      if (!check.ok) throw new ApiError(422, 'invalid_timeline', `无法标记审校：${check.reason}`, { current: mapSegment(seg) });

      get()
        .prepare('UPDATE segments SET reviewed = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(reviewed ? 1 : 0, now(), seg.id);
      return mapSegment(
        get().prepare(`${SEGMENT_SELECT} WHERE s.id = ?`).get(seg.id)
      );
    })();

    res.json({ segment: result, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/videos/:id(\\d+)/segments/:sid(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    get().transaction(() => {
      const seg = get()
        .prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`)
        .get(req.params.sid, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
      if (seg.revision !== expected) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，请刷新后再删除', {
          current: mapSegment(seg),
        });
      }
      get().prepare('DELETE FROM segments WHERE id = ?').run(seg.id);
    })();
    res.json({ ok: true, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

/* ---------------- 说话人名单与片段归属 ---------------- */

// 查看名单（含每个说话人的草稿引用计数）与未归属片段清单
router.get('/videos/:id(\\d+)/speakers', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    res.json({
      video_id: video.id,
      list_revision: video.speakers_revision,
      speakers: listSpeakers(video.id),
      unassigned_segment_ids: unassignedSegmentIds(video.id),
    });
  } catch (err) {
    next(err);
  }
});

// 新增说话人：{name, list_revision}；名称 trim 后非空、不换行、同视频唯一
router.post('/videos/:id(\\d+)/speakers', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const name = normalizeSpeakerName(req.body && req.body.name);
    const expected = parseListRevision(req.body);

    const speaker = get().transaction(() => {
      const locked = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!locked) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      if (locked.speakers_revision !== expected) {
        throw new ApiError(409, 'revision_conflict',
          '名单修订号已过期：说话人名单已被他人修改，已返回当前名单，请基于当前名单重试',
          rosterCurrent(videoId));
      }
      const dup = get().prepare('SELECT id FROM speakers WHERE video_id = ? AND name = ?').get(videoId, name);
      if (dup) throw new ApiError(422, 'duplicate_speaker', `已存在同名说话人「${name}」（名称去首尾空白后不得重复）`);
      const ts = now();
      const info = get()
        .prepare('INSERT INTO speakers (video_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(videoId, name, ts, ts);
      get().prepare('UPDATE videos SET speakers_revision = speakers_revision + 1 WHERE id = ?').run(videoId);
      return get().prepare('SELECT * FROM speakers WHERE id = ?').get(info.lastInsertRowid);
    })();

    res.status(201).json({
      ok: true,
      speaker: mapSpeaker(speaker, 0),
      ...rosterCurrent(videoId),
    });
  } catch (err) {
    next(err);
  }
});

// 修改说话人名称：{name, list_revision}；仅固定当时名称的历史发布快照不受影响
router.put('/videos/:id(\\d+)/speakers/:spid(\\d+)', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const speakerId = Number(req.params.spid);
    const name = normalizeSpeakerName(req.body && req.body.name);
    const expected = parseListRevision(req.body);

    const speaker = get().transaction(() => {
      const locked = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!locked) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      if (locked.speakers_revision !== expected) {
        throw new ApiError(409, 'revision_conflict',
          '名单修订号已过期：说话人名单已被他人修改，已返回当前名单，请基于当前名单重试',
          rosterCurrent(videoId));
      }
      const sp = get().prepare('SELECT * FROM speakers WHERE id = ? AND video_id = ?').get(speakerId, videoId);
      if (!sp) throw new ApiError(404, 'speaker_not_found', `说话人 #${speakerId} 不存在`);
      if (sp.name === name) return sp; // 名称未变：幂等返回（不推进修订号）
      const dup = get()
        .prepare('SELECT id FROM speakers WHERE video_id = ? AND name = ? AND id <> ?')
        .get(videoId, name, speakerId);
      if (dup) throw new ApiError(422, 'duplicate_speaker', `已存在同名说话人「${name}」（名称去首尾空白后不得重复）`);
      get().prepare('UPDATE speakers SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), speakerId);
      get().prepare('UPDATE videos SET speakers_revision = speakers_revision + 1 WHERE id = ?').run(videoId);
      return get().prepare('SELECT * FROM speakers WHERE id = ?').get(speakerId);
    })();

    res.json({ ok: true, speaker: mapSpeaker(speaker, undefined), ...rosterCurrent(videoId) });
  } catch (err) {
    next(err);
  }
});

// 删除说话人：{list_revision}；仍被草稿片段引用时 422 拒绝（须先改片段归属）
router.delete('/videos/:id(\\d+)/speakers/:spid(\\d+)', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const speakerId = Number(req.params.spid);
    const expected = parseListRevision(req.body);

    get().transaction(() => {
      const locked = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!locked) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      if (locked.speakers_revision !== expected) {
        throw new ApiError(409, 'revision_conflict',
          '名单修订号已过期：说话人名单已被他人修改，已返回当前名单，请基于当前名单重试',
          rosterCurrent(videoId));
      }
      const sp = get().prepare('SELECT * FROM speakers WHERE id = ? AND video_id = ?').get(speakerId, videoId);
      if (!sp) throw new ApiError(404, 'speaker_not_found', `说话人 #${speakerId} 不存在`);
      const usage = get()
        .prepare('SELECT COUNT(*) AS n FROM segments WHERE speaker_id = ?')
        .get(speakerId).n;
      if (usage > 0) {
        const refs = get()
          .prepare('SELECT id, start_ms, end_ms FROM segments WHERE speaker_id = ? ORDER BY start_ms, id LIMIT 100')
          .all(speakerId);
        throw new ApiError(422, 'speaker_in_use',
          `说话人「${sp.name}」仍被 ${usage} 个草稿片段引用，请先把这些片段改归属到其他说话人或置为未归属后再删除`,
          { usage_count: usage, referenced_by: refs });
      }
      get().prepare('DELETE FROM speakers WHERE id = ?').run(speakerId);
      get().prepare('UPDATE videos SET speakers_revision = speakers_revision + 1 WHERE id = ?').run(videoId);
    })();

    res.json({ ok: true, ...rosterCurrent(videoId) });
  } catch (err) {
    next(err);
  }
});

// 修改片段归属：{speaker_id, revision}；speaker_id 为 null 表示置为未归属。
// 归属变化与文本/时间无关：原文文字与时间不变、译文不失效；片段修订号 +1 且转待审。
router.put('/videos/:id(\\d+)/segments/:sid(\\d+)/speaker', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const segmentId = Number(req.params.sid);
    const expected = parseRevision(req.body);
    const body = req.body;
    if (!body || !('speaker_id' in body)) {
      throw new ApiError(422, 'missing_speaker', '请提交 speaker_id（正整数表示归属到该说话人；null 表示未归属）');
    }
    let speakerId = body.speaker_id;
    if (speakerId !== null) {
      speakerId = Number(speakerId);
      if (!isInt(speakerId) || speakerId < 1) {
        throw new ApiError(422, 'invalid_speaker', 'speaker_id 必须为正整数，或 null 表示未归属');
      }
    }

    const result = get().transaction(() => {
      const locked = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!locked) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      const seg = get()
        .prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`)
        .get(segmentId, videoId);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${segmentId} 不存在`);
      if (seg.revision !== expected) {
        throw new ApiError(409, 'revision_conflict',
          '原文修订号已过期：该片段已被他人修改，已返回当前状态，请基于当前内容重试',
          { current: conflictCurrent(videoId, segmentId), ...rosterCurrent(videoId) });
      }
      if (speakerId !== null) {
        const sp = get().prepare('SELECT id FROM speakers WHERE id = ? AND video_id = ?').get(speakerId, videoId);
        if (!sp) throw new ApiError(422, 'speaker_not_found', `说话人 #${speakerId} 不存在于该视频，请先在名单中新增`);
      }
      if (seg.speaker_id !== speakerId) {
        // 归属变化：文字与时间不变 -> 译文不失效；片段转待审、修订号 +1
        get()
          .prepare('UPDATE segments SET speaker_id = ?, reviewed = 0, revision = revision + 1, updated_at = ? WHERE id = ?')
          .run(speakerId, now(), segmentId);
      }
      return {
        segment: mapSegment(get().prepare(`${SEGMENT_SELECT} WHERE s.id = ?`).get(segmentId)),
        changed: seg.speaker_id !== speakerId,
      };
    })();

    res.json({
      ok: true,
      changed: result.changed,
      segment: result.segment,
      segments: listSegments(videoId),
      unassigned_segment_ids: unassignedSegmentIds(videoId),
    });
  } catch (err) {
    next(err);
  }
});



// 把单个草稿片段在严格位于其起止之间的整数毫秒切点处拆成左右两段：
// 原片段 ID 保留给左段（修订号 +1），右段获新 ID（修订号从 1 开始）；两段原文均转待审。
// 启用译文轨道时必须同时提交左右两段非空译文（不能丢弃或直接复制原译文）：
// 左段译文在原译文行上更新（修订号 +1），右段译文新建；两段译文均待审并重新绑定各自新原文。
// 既有质检放行随片段时间/文本变化失效（历史理由保留可查），质检规则按新时长重新计算；
// 历史发布版本及其 SRT 不受影响。过期修订号 / 非法切点 / 空文本 / 译文缺失均零写入。
router.post('/videos/:id(\\d+)/segments/:sid(\\d+)/split', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const segmentId = Number(req.params.sid);
    const expected = parseRevision(req.body);
    const cutMs = Number(req.body && req.body.cut_ms);
    if (!isInt(cutMs)) {
      throw new ApiError(422, 'invalid_cut_point', '切点 cut_ms 必须为整数毫秒');
    }
    const leftText = normalizeText(req.body && req.body.left_text != null ? req.body.left_text : '');
    const rightText = normalizeText(req.body && req.body.right_text != null ? req.body.right_text : '');
    const track = !!video.translation_lang;
    let leftTrText = null;
    let rightTrText = null;
    if (track) {
      if (!req.body || req.body.left_translation == null || req.body.right_translation == null) {
        throw new ApiError(422, 'missing_translation',
          '已启用译文轨道：拆分时须同时提交左右两段译文 left_translation 与 right_translation（不能丢弃原译文）');
      }
      leftTrText = normalizeText(req.body.left_translation);
      rightTrText = normalizeText(req.body.right_translation);
    }

    const result = get().transaction(() => {
      const seg = get().prepare(`${SEGMENT_SELECT} WHERE s.id = ? AND s.video_id = ?`).get(segmentId, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${segmentId} 不存在`);
      if (seg.revision !== expected) {
        throw new ApiError(409, 'revision_conflict',
          '原文修订号已过期：该片段已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
          { current: conflictCurrent(video.id, segmentId) });
      }
      if (cutMs <= seg.start_ms || cutMs >= seg.end_ms) {
        throw new ApiError(422, 'invalid_cut_point',
          `切点 ${cutMs}ms 必须严格位于片段 #${segmentId} 的起止之间（${seg.start_ms}–${seg.end_ms}ms）`,
          { current: conflictCurrent(video.id, segmentId) });
      }
      if (!leftText.trim()) throw new ApiError(422, 'empty_text', '左段原文不能为空（去首尾空白后至少 1 个字符）');
      if (!rightText.trim()) throw new ApiError(422, 'empty_text', '右段原文不能为空（去首尾空白后至少 1 个字符）');

      const tr = track ? getTranslationRow(video.id, segmentId) : null;
      if (track) {
        if (!leftTrText.trim() || !rightTrText.trim()) {
          throw new ApiError(422, 'missing_translation', '左右两段译文均不能为空（去首尾空白后至少 1 个字符）');
        }
        if (tr) {
          const trRev = Number(req.body.translation_revision);
          if (!Number.isInteger(trRev) || trRev < 1) {
            throw new ApiError(422, 'missing_revision',
              '该片段已有译文：请携带所见译文修订号 translation_revision（正整数）');
          }
          if (tr.revision !== trRev) {
            throw new ApiError(409, 'revision_conflict',
              '译文修订号已过期：该译文已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
              { current: conflictCurrent(video.id, segmentId) });
          }
          if (leftTrText.trim() === tr.text.trim() || rightTrText.trim() === tr.text.trim()) {
            throw new ApiError(422, 'copied_translation',
              '左右两段译文均不得直接复制原译文，请按拆分后的左右原文重新翻译');
          }
        }
      }

      // 拆分后的全量时间线必须仍然合法（防御性复算；切点严格位于片段内部时天然端点相接）
      const all = get().prepare('SELECT * FROM segments WHERE video_id = ?').all(video.id);
      const timeline = all.flatMap((row) => (row.id === segmentId
        ? [{ id: row.id, start_ms: row.start_ms, end_ms: cutMs },
          { id: '(new)', start_ms: cutMs, end_ms: row.end_ms }]
        : [row]));
      const check = validateTimeline(timeline, video.duration_ms);
      if (!check.ok) {
        throw new ApiError(422, 'invalid_timeline', `拆分后时间线不合法，未写入任何内容：${check.reason}`);
      }

      const ts = now();
      // 左段沿用原片段 ID：终点收到切点、文本更新、修订号 +1、转待审
      get().prepare(
        'UPDATE segments SET end_ms = ?, text = ?, reviewed = 0, revision = revision + 1, updated_at = ? WHERE id = ?'
      ).run(cutMs, leftText, ts, segmentId);
      // 右段获新 ID：自切点到原终点，待审，修订号从 1 开始；沿用原归属（拆分为同一人连续发言）
      const rightId = get().prepare(
        `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, speaker_id, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, ?, ?)`
      ).run(video.id, cutMs, seg.end_ms, rightText, seg.speaker_id, ts).lastInsertRowid;
      // 片段时间与文本均变化：该片段全部既有质检放行失效（行保留为历史，理由可查）
      deactivateSegmentQcWaivers(get(), segmentId, ts);

      if (track) {
        if (tr) {
          // 原译文行保留给左段：文本更新、修订号 +1、转待审并重新绑定左段原文（不失效）
          get().prepare(
            `UPDATE translations
             SET text = ?, reviewed = 0, revision = revision + 1,
                 source_start_ms = ?, source_end_ms = ?, source_text = ?, updated_at = ?
             WHERE id = ?`
          ).run(leftTrText, seg.start_ms, cutMs, leftText, ts, tr.id);
        } else {
          get().prepare(
            `INSERT INTO translations (video_id, segment_id, text, reviewed, revision,
                                       source_start_ms, source_end_ms, source_text, created_at, updated_at)
             VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`
          ).run(video.id, segmentId, leftTrText, seg.start_ms, cutMs, leftText, ts, ts);
        }
        // 右段译文新建：待审、修订号从 1 开始、绑定右段原文
        get().prepare(
          `INSERT INTO translations (video_id, segment_id, text, reviewed, revision,
                                     source_start_ms, source_end_ms, source_text, created_at, updated_at)
           VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`
        ).run(video.id, rightId, rightTrText, cutMs, seg.end_ms, rightText, ts, ts);
      }

      return {
        left: mapSegment(get().prepare(`${SEGMENT_SELECT} WHERE s.id = ?`).get(segmentId)),
        right: mapSegment(get().prepare(`${SEGMENT_SELECT} WHERE s.id = ?`).get(rightId)),
      };
    })();

    res.status(201).json({
      ok: true,
      cut_ms: cutMs,
      left: result.left,
      right: result.right,
      segments: listSegments(video.id),
      translations: listTranslations(video.id),
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- 发布与导出 ---------------- */

// 发布门禁：原文全部已审且时间合法；启用译文轨道时还要求每段译文齐备、
// 已审且对应当前原文内容（未失效）；存在说话人名单时每段都必须归属。pending 逐段列出待处理问题，供工作台定位。
function publicationStatus(video, segments, translations, speakers) {
  const problems = [];
  const pending = [];
  if (segments.length === 0) problems.push('至少需要一个字幕片段才能发布');
  if (segments.some((s) => !s.reviewed)) problems.push('仍有片段未通过审校');
  const check = validateTimeline(segments, video.duration_ms);
  if (!check.ok) problems.push(check.reason);

  const speakerCount = speakers ? speakers.length : 0;
  let unassignedCount = 0;
  if (speakerCount > 0) {
    for (const s of segments) {
      if (s.speaker_id == null) unassignedCount++;
    }
    if (unassignedCount) problems.push(`说话人：${unassignedCount} 个片段尚未归属说话人`);
  }

  for (const s of segments) {
    const reasons = [];
    if (!s.reviewed) reasons.push('segment_unreviewed');
    if (speakerCount > 0 && s.speaker_id == null) reasons.push('speaker_unassigned');
    if (video.translation_lang) {
      const tr = translations.find((t) => t.segment_id === s.id);
      if (!tr) reasons.push('translation_missing');
      else {
        if (tr.stale) reasons.push('translation_stale');
        if (!tr.reviewed) reasons.push('translation_unreviewed');
      }
    }
    if (reasons.length) {
      pending.push({ segment_id: s.id, start_ms: s.start_ms, end_ms: s.end_ms, reasons });
    }
  }

  let translation = null;
  if (video.translation_lang) {
    const missing = pending.filter((p) => p.reasons.includes('translation_missing')).length;
    const stale = pending.filter((p) => p.reasons.includes('translation_stale')).length;
    const unreviewed = pending.filter((p) => p.reasons.includes('translation_unreviewed')).length;
    translation = {
      language: video.translation_lang,
      total: segments.length,
      translated: translations.length,
      reviewed: translations.filter((t) => t.reviewed && !t.stale).length,
      missing,
      stale,
      unreviewed,
    };
    const parts = [];
    if (missing) parts.push(`${missing} 段缺少译文`);
    if (stale) parts.push(`${stale} 段译文已失效（原文已变更，需重新校对）`);
    if (unreviewed) parts.push(`${unreviewed} 段译文待审校`);
    if (parts.length) problems.push(`译文轨道（${video.translation_lang}）：${parts.join('、')}`);
  }

  const speakersSummary = {
    enabled: speakerCount > 0,
    total: speakerCount,
    unassigned: unassignedCount,
    assigned: segments.length - unassignedCount,
  };

  return { canPublish: problems.length === 0, problems, pending, translation, speakers: speakersSummary };
}

router.get('/videos/:id(\\d+)/status', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const segments = listSegments(video.id);
    const translations = video.translation_lang ? listTranslations(video.id) : [];
    const speakers = listSpeakers(video.id);
    const status = publicationStatus(video, segments, translations, speakers);
    const qc = loadLiveQc(video);
    res.json({
      ...status,
      duration_ms: video.duration_ms,
      qc: {
        configured: qc.configured,
        rules_revision: qc.rules.revision,
        violation_count: qc.violation_count,
        blocking_count: qc.blocking_count,
        active_waiver_count: qc.active_waiver_count,
        inactive_waiver_count: qc.inactive_waiver_count,
        can_publish: qc.can_publish,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id(\\d+)/publish', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const pub = get().transaction(() => {
      const locked = get().prepare('SELECT * FROM videos WHERE id = ?').get(video.id);
      if (!locked) throw new ApiError(404, 'not_found', `视频 #${video.id} 不存在`);
      const segments = listSegments(video.id);
      const translations = locked.translation_lang ? listTranslations(video.id) : [];
      const speakers = listSpeakers(video.id);
      const status = publicationStatus(locked, segments, translations, speakers);
      if (!status.canPublish) {
        // 不生成部分版本：事务在此抛出，无任何写入
        throw new ApiError(422, 'not_publishable', `当前草稿不能发布：${status.problems.join('；')}`,
          { pending: status.pending, translation: status.translation, speakers: status.speakers });
      }

      // 发布前重新质检：未放行的违规阻止发布并返回完整清单（不产生版本）
      const qcRulesRow = get().prepare('SELECT * FROM qc_rules WHERE video_id = ?').get(video.id);
      const qcWaiverRows = get().prepare('SELECT * FROM qc_waivers WHERE video_id = ?').all(video.id);
      const qcReport = buildQcReport({
        language: locked.translation_lang != null ? locked.translation_lang : null,
        segments,
        translationBySegment: new Map(translations.map((t) => [t.segment_id, t])),
        rulesRow: qcRulesRow,
        waiverRows: qcWaiverRows,
      });
      if (!qcReport.can_publish) {
        throw new ApiError(422, 'qc_blocked',
          `质检未通过：${qcReport.blocking_count} 项违规尚未放行，已阻止发布且未生成版本`,
          {
            qc_violations: qcReport.blocking_violations,
            qc: {
              rules: qcReport.rules,
              violation_count: qcReport.violation_count,
              blocking_count: qcReport.blocking_count,
              active_waiver_count: qcReport.active_waiver_count,
            },
          });
      }

      const maxRow = get()
        .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM publications WHERE video_id = ?')
        .get(video.id);
      const version = maxRow.v + 1;
      // 发布快照固定两轨内容：原文快照结构不变；启用译文轨道时另存译文快照
      const snapshot = JSON.stringify(
        segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: s.text }))
      );
      let translationSnapshot = null;
      if (locked.translation_lang) {
        const bySeg = new Map(translations.map((t) => [t.segment_id, t]));
        translationSnapshot = JSON.stringify(
          segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: bySeg.get(s.id).text }))
        );
      }
      // 说话人快照：仅当存在说话人名单时才固定当时的名单（id/名称）与逐段归属
      // （segment_id -> speaker_id）。名单为空时写 NULL —— 与旧发布版本形态完全一致；
      // 之后改名、增删说话人或改草稿归属都不影响该历史版本。
      const speakerSnapshot = speakers.length
        ? JSON.stringify({
          list_revision: locked.speakers_revision,
          speakers: speakers.map((sp) => ({ id: sp.id, name: sp.name })),
          assignments: segments.map((s) => ({ segment_id: s.id, speaker_id: s.speaker_id })),
        })
        : null;
      // 固定本次发布所用的质检规则、质检结果与有效放行；
      // 从未配置过质检规则（qc_rules 行不存在）时两列均为 NULL —— 与旧发布版本形态完全一致
      const qcRulesSnapshot = qcRulesRow ? JSON.stringify(mapQcRules(qcRulesRow)) : null;
      const qcReportSnapshot = qcRulesRow
        ? JSON.stringify({
          rules: qcReport.rules,
          tracks: qcReport.tracks,
          configured: qcReport.configured,
          segments: qcReport.segments,
          violations: qcReport.violations,
          valid_waivers: qcReport.valid_waivers,
        })
        : null;
      const info = get()
        .prepare(
          `INSERT INTO publications (video_id, version, snapshot, translation_snapshot, translation_lang,
             qc_rules_snapshot, qc_report_snapshot, speaker_snapshot, segment_count, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(video.id, version, snapshot, translationSnapshot, locked.translation_lang,
          qcRulesSnapshot, qcReportSnapshot, speakerSnapshot, segments.length, now());
      return get().prepare('SELECT * FROM publications WHERE id = ?').get(info.lastInsertRowid);
    })();
    res.status(201).json({ publication: mapPublication(pub) });
  } catch (err) {
    next(err);
  }
});

router.get('/videos/:id(\\d+)/publications', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const pubs = get()
      .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC')
      .all(video.id)
      .map(mapPublication);
    res.json({ publications: pubs });
  } catch (err) {
    next(err);
  }
});

// 查询某个已发布版本发布时固定的质检规则、质检结果与有效放行
router.get('/videos/:id(\\d+)/publications/:version/qc', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(422, 'invalid_version', 'version 必须为正整数版本号');
    }
    const row = get()
      .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
      .get(video.id, version);
    if (!row) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
    if (row.qc_report_snapshot == null) {
      // 旧发布版本（发布时尚无质检功能/未配置任何阈值）保持原行为
      throw new ApiError(422, 'qc_unavailable',
        `发布版本 v${version} 不含质检快照（发布时未配置质检阈值）；旧发布版本与 SRT 导出行为保持不变`);
    }
    const report = JSON.parse(row.qc_report_snapshot);
    const rules = row.qc_rules_snapshot != null ? JSON.parse(row.qc_rules_snapshot) : null;
    res.json({
      video_id: video.id,
      version: row.version,
      published_at: row.published_at,
      snapshot: true,
      translation_lang: row.translation_lang != null ? row.translation_lang : null,
      rules_snapshot: rules,
      ...report,
    });
  } catch (err) {
    next(err);
  }
});

// 查询某个已发布版本发布时固定的说话人名单与逐段归属
router.get('/videos/:id(\\d+)/publications/:version/speakers', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(422, 'invalid_version', 'version 必须为正整数版本号');
    }
    const row = get()
      .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
      .get(video.id, version);
    if (!row) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
    if (row.speaker_snapshot == null) {
      // 旧发布版本（发布时尚无说话人功能）保持原行为
      throw new ApiError(422, 'speakers_unavailable',
        `发布版本 v${version} 不含说话人快照（发布时尚无说话人名单）；旧发布版本与 SRT 导出行为保持不变`);
    }
    const snapshot = JSON.parse(row.speaker_snapshot);
    res.json({
      video_id: video.id,
      version: row.version,
      published_at: row.published_at,
      snapshot: true,
      ...snapshot,
    });
  } catch (err) {
    next(err);
  }
});

function resolveSnapshot(video, versionParam) {
  if (!versionParam || versionParam === 'draft') {
    return { segments: listSegments(video.id), label: 'draft', displayName: '草稿' };
  }
  if (versionParam === 'published') {
    const row = get()
      .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC LIMIT 1')
      .get(video.id);
    if (!row) throw new ApiError(404, 'no_publication', '该视频尚无已发布版本');
    return { segments: JSON.parse(row.snapshot), label: `v${row.version}`, displayName: `已发布 v${row.version}`, version: row.version };
  }
  const version = Number(versionParam);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError(422, 'invalid_version', 'version 取值：draft、published 或正整数版本号');
  }
  const row = get()
    .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
    .get(video.id, version);
  if (!row) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
  return { segments: JSON.parse(row.snapshot), label: `v${row.version}`, displayName: `已发布 v${row.version}`, version: row.version };
}

router.get('/videos/:id(\\d+)/srt', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { segments, displayName, label } = resolveSnapshot(video, req.query.version);
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(video.title)}-${label}.srt`);
    res.setHeader('X-Subtitle-Desc', encodeURIComponent(displayName));
    res.send(buildSrt(segments));
  } catch (err) {
    next(err);
  }
});

// 译文 SRT 导出：草稿（?version=draft，默认）或含译文的发布版本（published / 版本号）。
// 草稿在译文缺失或失效时拒绝并逐段指出；旧发布版本（无译文快照）拒绝。
router.get('/videos/:id(\\d+)/srt/translation', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const versionParam = req.query.version;

    if (!versionParam || versionParam === 'draft') {
      requireTrack(video);
      const segments = listSegments(video.id);
      const translations = listTranslations(video.id);
      const bySeg = new Map(translations.map((t) => [t.segment_id, t]));
      const pending = [];
      for (const s of segments) {
        const tr = bySeg.get(s.id);
        if (!tr) {
          pending.push({ segment_id: s.id, start_ms: s.start_ms, end_ms: s.end_ms, reason: 'translation_missing',
            message: `片段 #${s.id}（${s.start_ms}–${s.end_ms}ms）缺少译文` });
        } else if (tr.stale) {
          pending.push({ segment_id: s.id, start_ms: s.start_ms, end_ms: s.end_ms, reason: 'translation_stale',
            message: `片段 #${s.id}（${s.start_ms}–${s.end_ms}ms）的译文已失效：原文已变更，需重新校对` });
        }
      }
      if (pending.length) {
        throw new ApiError(422, 'translation_incomplete',
          `草稿译文不完整，无法导出译文 SRT（${pending.length} 段待处理）：\n${pending[0].message}`,
          { pending, translation_lang: video.translation_lang });
      }
      const entries = segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: bySeg.get(s.id).text }));
      sendTranslationSrt(res, video, entries, 'draft', video.translation_lang, '译文草稿');
      return;
    }

    let row;
    let label;
    if (versionParam === 'published') {
      row = get()
        .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC LIMIT 1')
        .get(video.id);
      if (!row) throw new ApiError(404, 'no_publication', '该视频尚无已发布版本');
      label = `v${row.version}`;
    } else {
      const version = Number(versionParam);
      if (!Number.isInteger(version) || version < 1) {
        throw new ApiError(422, 'invalid_version', 'version 取值：draft、published 或正整数版本号');
      }
      row = get()
        .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
        .get(video.id, version);
      if (!row) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
      label = `v${version}`;
    }
    if (row.translation_snapshot == null) {
      throw new ApiError(422, 'translation_unavailable',
        `发布版本 ${label} 不含译文轨道（发布时未启用译文轨道），无法导出译文 SRT`);
    }
    sendTranslationSrt(res, video, JSON.parse(row.translation_snapshot), label,
      row.translation_lang, `译文 · 已发布 ${label}`);
  } catch (err) {
    next(err);
  }
});

function sendTranslationSrt(res, video, entries, label, lang, displayName) {
  const suffix = lang ? `.${lang}` : '';
  res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(video.title)}-${label}${encodeURIComponent(suffix)}.srt`);
  res.setHeader('X-Subtitle-Desc', encodeURIComponent(displayName));
  res.send(buildSrt(entries));
}

/* ---------------- SRT 导入（预览 -> 确认追加/替换草稿） ---------------- */

function entryLabel(e) {
  return `导入条目「序号 ${e.seq == null ? '(缺)' : e.seq}」（原文件第 ${e.line} 行）`;
}
function existingLabel(s) {
  return `现有草稿片段 #${s.id}`;
}

// 语义校验：负时间 / 起止倒置 / 越过视频时长 / 导入条目之间重叠；文本过长
// 返回 { errors, validEntries }，其中重叠只在各项基础时间合法时检查
function evaluateImportedEntries(entries, durationMs) {
  const errors = [];
  const valid = [];
  entries.forEach((e) => {
    let selfOk = true;
    if (e.start_ms < 0 || e.end_ms < 0) {
      errors.push({ code: 'negative_time', entry: e.entry, seq: e.seq, line: e.line,
        message: `${entryLabel(e)}：时间不能为负数（起点 ${e.start_ms}ms / 终点 ${e.end_ms}ms）` });
      selfOk = false;
    }
    if (e.start_ms >= 0 && e.end_ms >= 0 && e.start_ms >= e.end_ms) {
      errors.push({ code: 'reversed_time', entry: e.entry, seq: e.seq, line: e.line,
        message: `${entryLabel(e)}：起点（${e.start_ms}ms）必须早于终点（${e.end_ms}ms）` });
      selfOk = false;
    }
    if (e.end_ms > durationMs) {
      errors.push({ code: 'beyond_duration', entry: e.entry, seq: e.seq, line: e.line,
        message: `${entryLabel(e)}：终点 ${e.end_ms}ms 越过视频时长 ${durationMs}ms` });
      selfOk = false;
    }
    if (e.text.length > 10000) {
      errors.push({ code: 'text_too_long', entry: e.entry, seq: e.seq, line: e.line,
        message: `${entryLabel(e)}：字幕文本 ${e.text.length} 字符，超过单条 10000 字符上限` });
      selfOk = false;
    }
    if (selfOk) valid.push(e);
  });

  const ordered = [...valid].sort((a, b) => a.start_ms - b.start_ms || a.entry - b.entry);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.start_ms < prev.end_ms) {
      errors.push({ code: 'imported_overlap', entry: cur.entry, seq: cur.seq, line: cur.line,
        message: `${entryLabel(prev)} 与 ${entryLabel(cur)} 时间重叠（${cur.start_ms}ms 早于 ${prev.end_ms}ms，端点相接允许）` });
    }
  }
  return { errors, validEntries: errors.length ? [] : valid };
}

// 追加模式：逐条给出与现有草稿的冲突（仅信息性；存在冲突时禁止确认追加）
function draftConflicts(existing, entries) {
  const conflicts = [];
  entries.forEach((e) => {
    for (const s of existing) {
      if (e.start_ms < s.end_ms && s.start_ms < e.end_ms) {
        conflicts.push({
          entry: e.entry,
          seq: e.seq,
          line: e.line,
          segment_id: s.id,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          message: `${entryLabel(e)}（${e.start_ms}–${e.end_ms}ms）与${existingLabel(s)}（${s.start_ms}–${s.end_ms}ms）时间冲突`,
        });
      }
    }
  });
  return conflicts;
}

// 草稿快照指纹：任何修改（增删改、审校）都会改变结果
function draftFingerprint(segments) {
  const payload = segments
    .map((s) => [s.id, s.start_ms, s.end_ms, s.text, s.reviewed, s.revision].join('|'))
    .join('\n');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}
function srtHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
function makePreviewToken({ videoId, mode, draftHash, contentHash, extra }) {
  const payload = JSON.stringify({ v: videoId, m: mode, d: draftHash, c: contentHash, ...(extra || {}) });
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}
function readPreviewToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// 从 multipart（字段 srt）或 JSON（字段 content，UTF-8 字符串）读取待导入文本
function readSrtInput(req) {
  if (req.file) {
    return { content: req.file.buffer.toString('utf8'), filename: req.file.originalname || 'import.srt' };
  }
  if (req.body && typeof req.body.content === 'string') {
    return { content: req.body.content, filename: req.body.filename || 'inline.srt' };
  }
  throw new ApiError(422, 'missing_srt', '请上传 SRT 文件（multipart 字段名 srt）或在 JSON 体中提供 content 字段（UTF-8 文本）');
}

function invalidSrtError(message, errors) {
  return new ApiError(422, 'invalid_srt', message, { errors });
}

// 解析 + 语义校验；任何错误都抛 422 invalid_srt，绝不写入
function parseAndEvaluate(content, video) {
  const parsed = parseSrt(content);
  if (!parsed.ok) {
    throw invalidSrtError(`SRT 解析失败，共 ${parsed.errors.length} 处格式问题，未写入任何内容：\n${parsed.errors[0].message}`,
      parsed.errors);
  }
  const { errors, validEntries } = evaluateImportedEntries(parsed.entries, video.duration_ms);
  if (errors.length) {
    throw invalidSrtError(`SRT 时间校验失败，共 ${errors.length} 处问题，未写入任何内容：\n${errors[0].message}`, errors);
  }
  return validEntries;
}

// 仅在 multipart 请求时解析 SRT 上传；JSON（content 字段）请求直接放行
function srtUploadOptional(req, res, next) {
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();
  srtUpload.single('srt')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      next(new ApiError(422, 'srt_too_large', `SRT 文件超过大小上限（MAX_SRT_KB，当前上限 ${Math.round(MAX_SRT_BYTES / 1024)} KB）`));
      return;
    }
    next(err);
  });
}

router.post('/videos/:id(\\d+)/srt/preview', srtUploadOptional, (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { content, filename } = readSrtInput(req);
    const entries = parseAndEvaluate(content, video);
    const existing = listSegments(video.id);
    const conflicts = draftConflicts(existing, entries);

    const draftHash = draftFingerprint(existing);
    const contentHash = srtHash(content);
    const token = makePreviewToken({
      videoId: video.id, mode: 'preview', draftHash, contentHash,
    });

    res.json({
      filename,
      duration_ms: video.duration_ms,
      draft_count: existing.length,
      imported_count: entries.length,
      entries: entries.map((e) => ({
        entry: e.entry,
        seq: e.seq,
        line: e.line,
        time_line: e.time_line,
        start_ms: e.start_ms,
        end_ms: e.end_ms,
        text: e.text,
      })),
      conflicts,
      append_blocked: conflicts.length > 0,
      token,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id(\\d+)/srt/import', srtUploadOptional, (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const video = loadVideo(videoId);
    const mode = req.body && req.body.mode === 'replace' ? 'replace' : req.body && req.body.mode === 'append' ? 'append' : null;
    if (!mode) throw new ApiError(422, 'invalid_mode', '请指定写入方式 mode：append（追加到草稿）或 replace（替换整个草稿）');
    const token = readPreviewToken(req.body && req.body.token);
    if (!token) {
      throw new ApiError(409, 'preview_required', '缺少有效的预览令牌：请先调用预览接口，再以预览返回的 token 确认');
    }

    const { content } = readSrtInput(req);
    const currentSegments = listSegments(video.id);
    const currentDraftHash = draftFingerprint(currentSegments);
    if (token.v !== video.id || token.m !== 'preview' || token.d !== currentDraftHash) {
      throw new ApiError(409, 'draft_changed',
        '预览之后草稿已被修改（可能是他人操作）。为避免覆盖更改，请重新预览后再确认；本次未写入任何内容',
        { current_segments: currentSegments });
    }
    if (token.c !== srtHash(content)) {
      throw new ApiError(422, 'srt_changed', '确认时提交的 SRT 内容与预览时不一致，请重新预览后再确认；本次未写入任何内容');
    }

    // 重新解析与全量校验（不信任预览结果），并在同一事务内整批写入
    const result = get().transaction(() => {
      const lockedVideo = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!lockedVideo) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);

      const entries = parseAndEvaluate(content, lockedVideo);

      if (mode === 'append') {
        const existingRows = get().prepare('SELECT * FROM segments WHERE video_id = ?').all(videoId);
        const conflicts = draftConflicts(existingRows, entries);
        if (conflicts.length) {
          throw invalidSrtError(
            `追加被阻止：导入条目与当前草稿存在 ${conflicts.length} 处时间冲突，请先调整草稿或改用替换；本次未写入任何内容：\n${conflicts[0].message}`,
            conflicts.map((c) => ({ code: 'draft_conflict', ...c })));
        }
      }

      const ts = now();
      const insert = get().prepare(
        `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
      );
      if (mode === 'replace') {
        get().prepare('DELETE FROM segments WHERE video_id = ?').run(videoId);
      }
      for (const e of entries) {
        insert.run(videoId, e.start_ms, e.end_ms, e.text, ts);
      }
      return { mode, imported_count: entries.length };
    })();

    res.status(201).json({
      ok: true,
      mode: result.mode,
      imported_count: result.imported_count,
      segments: listSegments(video.id),
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- 历史版本区间恢复（预览 -> 确认整体替换） ---------------- */

// 解析并校验恢复请求：版本号为正整数；区间为整数毫秒、起点早于终点、均在视频时长内
function readRestoreRange(body, video) {
  const version = Number(body && body.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError(422, 'invalid_version', '请指定要恢复的历史发布版本号 version（正整数）');
  }
  if (!body || body.start_ms == null || body.end_ms == null) {
    throw new ApiError(422, 'invalid_range', '请同时提供区间起点 start_ms 与终点 end_ms（整数毫秒）');
  }
  const startMs = Number(body.start_ms);
  const endMs = Number(body.end_ms);
  if (!isInt(startMs) || !isInt(endMs)) {
    throw new ApiError(422, 'invalid_range', '区间起点 start_ms 与终点 end_ms 必须为整数毫秒');
  }
  if (startMs < 0) {
    throw new ApiError(422, 'invalid_range', `区间起点不能为负数（收到 ${startMs}ms）`);
  }
  if (startMs >= endMs) {
    throw new ApiError(422, 'invalid_range', `区间起点（${startMs}ms）必须早于终点（${endMs}ms）`);
  }
  if (endMs > video.duration_ms) {
    throw new ApiError(422, 'invalid_range', `区间终点 ${endMs}ms 越过视频时长 ${video.duration_ms}ms`);
  }
  return { version, startMs, endMs };
}

function loadPublication(videoId, version) {
  const pub = get()
    .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
    .get(videoId, version);
  if (!pub) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
  return pub;
}

// 计算恢复计划：边界不得穿过任一侧片段；区间内以历史片段整体替换；替换后时间线必须合法。
// 任何不合法都抛错，调用方保证不写入。
function planRestore(video, snapshotEntries, draftSegments, startMs, endMs) {
  const crossings = [];
  const collectCrossings = (side, seg, label, extra) => {
    for (const [boundary, at] of [['start', startMs], ['end', endMs]]) {
      if (seg.start_ms < at && at < seg.end_ms) {
        const sideName = side === 'draft' ? '当前草稿片段' : '发布快照';
        const boundaryName = boundary === 'start' ? '起点' : '终点';
        crossings.push({
          side,
          boundary,
          at,
          ...extra,
          start_ms: seg.start_ms,
          end_ms: seg.end_ms,
          message: `区间${boundaryName} ${at}ms 穿过${sideName}${label}（${seg.start_ms}–${seg.end_ms}ms）`,
        });
      }
    }
  };
  draftSegments.forEach((s) => collectCrossings('draft', s, ` #${s.id}`, { segment_id: s.id }));
  snapshotEntries.forEach((e, i) => collectCrossings('published', e, `第 ${i + 1} 条`, { snapshot_index: i + 1 }));
  if (crossings.length) {
    throw new ApiError(422, 'range_crosses_segment',
      `区间边界穿过 ${crossings.length} 个片段，请把起点/终点调整到片段间隙（端点相接允许）：\n${crossings[0].message}`,
      { crossings });
  }

  // 边界不穿过后，与区间相交的片段必然整体落在区间内
  const inRange = (s) => s.start_ms >= startMs && s.end_ms <= endMs;
  const toRemove = draftSegments.filter(inRange);
  const toRestore = snapshotEntries
    .map((e, i) => ({
      snapshot_index: i + 1,
      start_ms: e.start_ms,
      end_ms: e.end_ms,
      text: e.text == null ? '' : String(e.text),
    }))
    .filter(inRange);

  // 替换后的完整时间线必须仍然合法（不信任快照内容，合并后全量校验）
  const removeIds = new Set(toRemove.map((s) => s.id));
  const merged = [
    ...draftSegments.filter((s) => !removeIds.has(s.id)),
    ...toRestore.map((e) => ({ id: `(恢复条目${e.snapshot_index})`, start_ms: e.start_ms, end_ms: e.end_ms })),
  ];
  const check = validateTimeline(merged, video.duration_ms);
  if (!check.ok) {
    throw new ApiError(422, 'invalid_timeline', `按该区间恢复后时间线不合法，未写入任何内容：${check.reason}`);
  }
  return { toRemove, toRestore };
}

router.post('/videos/:id(\\d+)/restore/preview', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { version, startMs, endMs } = readRestoreRange(req.body, video);
    const pub = loadPublication(video.id, version);
    const snapshot = JSON.parse(pub.snapshot);
    const draft = listSegments(video.id);
    const plan = planRestore(video, snapshot, draft, startMs, endMs);

    const token = makePreviewToken({
      videoId: video.id,
      mode: 'restore',
      draftHash: draftFingerprint(draft),
      extra: { ver: version, s: startMs, e: endMs },
    });

    res.json({
      version,
      start_ms: startMs,
      end_ms: endMs,
      duration_ms: video.duration_ms,
      // 并列对照：发布快照在区间内的片段（确认后恢复）vs 当前草稿在区间内的片段（确认后移除）
      to_restore: plan.toRestore,
      to_remove: plan.toRemove,
      token,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id(\\d+)/restore/confirm', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const video = loadVideo(videoId);
    const { version, startMs, endMs } = readRestoreRange(req.body, video);

    const token = readPreviewToken(req.body && req.body.token);
    if (!token || token.v !== video.id || token.m !== 'restore') {
      throw new ApiError(409, 'preview_required', '缺少有效的恢复预览令牌：请先调用恢复预览接口，再以预览返回的 token 确认');
    }
    if (token.ver !== version || token.s !== startMs || token.e !== endMs) {
      throw new ApiError(422, 'restore_params_changed',
        '确认的版本或区间与预览不一致，请按预览时的版本与区间确认，或重新预览；本次未写入任何内容');
    }
    const currentSegments = listSegments(video.id);
    if (token.d !== draftFingerprint(currentSegments)) {
      throw new ApiError(409, 'draft_changed',
        '预览之后草稿已被修改（可能是他人操作）。为避免覆盖更改，请重新预览后再确认；本次未写入任何内容',
        { current_segments: currentSegments });
    }

    // 事务内重新加载并完整复算恢复计划（不信任预览结果），整批原子写入
    const result = get().transaction(() => {
      const lockedVideo = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!lockedVideo) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      const pub = get()
        .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
        .get(videoId, version);
      if (!pub) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
      const snapshot = JSON.parse(pub.snapshot);
      const draftRows = get()
        .prepare('SELECT * FROM segments WHERE video_id = ? ORDER BY start_ms, id')
        .all(videoId)
        .map(mapSegment);
      const plan = planRestore(lockedVideo, snapshot, draftRows, startMs, endMs);

      const ts = now();
      const del = get().prepare('DELETE FROM segments WHERE id = ? AND video_id = ?');
      for (const s of plan.toRemove) del.run(s.id, videoId);
      // 恢复片段作为新草稿片段写入：一律待审、修订号从 1 开始；区间外片段及其修订号不变
      const insert = get().prepare(
        `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
      );
      const restored = plan.toRestore.map((e) => {
        const info = insert.run(videoId, e.start_ms, e.end_ms, e.text, ts);
        return mapSegment(get().prepare(`${SEGMENT_SELECT} WHERE s.id = ?`).get(info.lastInsertRowid));
      });
      return { removed: plan.toRemove, restored };
    })();

    res.status(201).json({
      ok: true,
      version,
      start_ms: startMs,
      end_ms: endMs,
      removed_count: result.removed.length,
      restored_count: result.restored.length,
      removed: result.removed,
      restored: result.restored,
      segments: listSegments(video.id),
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- 多片段整体平移（预览 -> 确认一次性应用） ---------------- */

// 校验片段 ID 列表：必须为非空正整数数组且不得重复；是否属于该视频由调用方对照草稿检查
function readShiftIds(body) {
  const raw = body && body.segment_ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(422, 'invalid_segment_ids', '请提交非空片段 ID 列表 segment_ids（正整数数组）');
  }
  const ids = [];
  for (const item of raw) {
    if (typeof item !== 'number' || !isInt(item) || item < 1) {
      throw new ApiError(422, 'invalid_segment_ids', 'segment_ids 必须全部为正整数片段 ID');
    }
    ids.push(item);
  }
  const seen = new Set();
  const duplicateIds = [];
  for (const id of ids) {
    if (seen.has(id)) {
      if (!duplicateIds.includes(id)) duplicateIds.push(id);
    } else {
      seen.add(id);
    }
  }
  if (duplicateIds.length) {
    throw new ApiError(422, 'duplicate_segment_ids',
      `片段 ID 列表中存在重复 ID：${duplicateIds.join('、')}；每个片段至多出现一次`,
      { duplicate_ids: duplicateIds });
  }
  return ids;
}

// 校验偏移：非零整数毫秒（正数延后，负数提前）
function readShiftOffset(body) {
  if (!body || body.offset_ms == null) {
    throw new ApiError(422, 'invalid_offset', '请提交非零整数毫秒偏移 offset_ms（正数延后、负数提前）');
  }
  if (typeof body.offset_ms !== 'number' || !Number.isFinite(body.offset_ms)) {
    throw new ApiError(422, 'invalid_offset', '偏移 offset_ms 必须为非零整数毫秒');
  }
  const offset = body.offset_ms;
  if (!isInt(offset)) {
    throw new ApiError(422, 'invalid_offset', '偏移 offset_ms 必须为整数毫秒');
  }
  if (offset === 0) {
    throw new ApiError(422, 'invalid_offset', '偏移 offset_ms 不能为 0（无变化无需平移）');
  }
  return offset;
}

function missingSegmentIds(segments, ids) {
  const exist = new Set(segments.map((s) => s.id));
  return ids.filter((id) => !exist.has(id));
}

// 计算平移计划：所选片段统一加上 offset（相对间距天然不变）；
// 逐段检查平移后是否越过视频边界，并与每个未选片段检查时间重叠（端点相接允许）。
// 纯计算、不写入；blocked 为真时确认必须拒绝。
function planShift(segments, selectedIds, offsetMs, durationMs) {
  const selectedSet = new Set(selectedIds);
  const selected = segments
    .filter((s) => selectedSet.has(s.id))
    .sort((a, b) => a.start_ms - b.start_ms || a.id - b.id);
  const others = segments.filter((s) => !selectedSet.has(s.id));

  const moved = selected.map((s) => ({
    segment_id: s.id,
    before_start_ms: s.start_ms,
    before_end_ms: s.end_ms,
    after_start_ms: s.start_ms + offsetMs,
    after_end_ms: s.end_ms + offsetMs,
  }));

  const boundaryIssues = [];
  for (const m of moved) {
    if (m.after_start_ms < 0) {
      boundaryIssues.push({
        segment_id: m.segment_id, kind: 'before_start', at: m.after_start_ms,
        message: `所选片段 #${m.segment_id} 平移后起点 ${m.after_start_ms}ms 早于视频起点 0ms`,
      });
    }
    if (m.after_end_ms > durationMs) {
      boundaryIssues.push({
        segment_id: m.segment_id, kind: 'beyond_duration', at: m.after_end_ms,
        message: `所选片段 #${m.segment_id} 平移后终点 ${m.after_end_ms}ms 超过视频时长 ${durationMs}ms`,
      });
    }
  }

  const conflicts = [];
  for (const m of moved) {
    for (const u of others) {
      if (m.after_start_ms < u.end_ms && u.start_ms < m.after_end_ms) {
        conflicts.push({
          segment_id: m.segment_id,
          other_segment_id: u.id,
          after_start_ms: m.after_start_ms,
          after_end_ms: m.after_end_ms,
          other_start_ms: u.start_ms,
          other_end_ms: u.end_ms,
          message: `所选片段 #${m.segment_id} 平移后（${m.after_start_ms}–${m.after_end_ms}ms）`
            + `与未选片段 #${u.id}（${u.start_ms}–${u.end_ms}ms）时间重叠（端点相接允许）`,
        });
      }
    }
  }

  return {
    moved,
    boundary_issues: boundaryIssues,
    conflicts,
    blocked: boundaryIssues.length > 0 || conflicts.length > 0,
  };
}

function shiftPreviewPayload(video, segments, ids, offsetMs) {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const plan = planShift(segments, ids, offsetMs, video.duration_ms);
  // 令牌绑定「片段选择 + 偏移 + 草稿指纹」；确认时选择顺序不同但集合相同视为一致
  const token = makePreviewToken({
    videoId: video.id,
    mode: 'shift',
    draftHash: draftFingerprint(segments),
    extra: { off: offsetMs, ids: [...ids].sort((a, b) => a - b) },
  });
  return {
    offset_ms: offsetMs,
    duration_ms: video.duration_ms,
    selected_count: ids.length,
    unselected_count: segments.length - ids.length,
    moved: plan.moved.map((m) => {
      const seg = byId.get(m.segment_id);
      return {
        segment_id: m.segment_id,
        text: seg.text,
        reviewed: seg.reviewed,
        revision: seg.revision,
        before_start_ms: m.before_start_ms,
        before_end_ms: m.before_end_ms,
        after_start_ms: m.after_start_ms,
        after_end_ms: m.after_end_ms,
      };
    }),
    boundary_issues: plan.boundary_issues,
    conflicts: plan.conflicts,
    blocked: plan.blocked,
    token,
  };
}

// 预览：即使平移会被阻止（越界/重叠）也返回 200 与逐条原因 + 令牌（令牌确认时仍会被拒）
router.post('/videos/:id(\\d+)/segments/shift/preview', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const ids = readShiftIds(req.body);
    const offsetMs = readShiftOffset(req.body);
    const segments = listSegments(video.id);
    const missing = missingSegmentIds(segments, ids);
    if (missing.length) {
      throw new ApiError(422, 'unknown_segments',
        `以下片段 ID 不存在于该视频：${missing.join('、')}`, { missing_ids: missing });
    }
    res.json(shiftPreviewPayload(video, segments, ids, offsetMs));
  } catch (err) {
    next(err);
  }
});

// 确认：与预览相同的选择（集合）与偏移 + 预览令牌；事务内重算，整批原子写入或完全不变
router.post('/videos/:id(\\d+)/segments/shift/confirm', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const video = loadVideo(videoId);
    const ids = readShiftIds(req.body);
    const offsetMs = readShiftOffset(req.body);

    const token = readPreviewToken(req.body && req.body.token);
    if (!token || token.v !== videoId || token.m !== 'shift') {
      throw new ApiError(409, 'preview_required',
        '缺少有效的平移预览令牌：请先调用平移预览接口，再以预览返回的 token 确认');
    }
    const wantIds = [...ids].sort((a, b) => a - b);
    if (token.off !== offsetMs || JSON.stringify(token.ids) !== JSON.stringify(wantIds)) {
      throw new ApiError(422, 'shift_params_changed',
        '确认的片段选择或偏移与预览不一致，请按预览时的选择与偏移确认，或重新预览；本次未写入任何内容');
    }
    const currentSegments = listSegments(video.id);
    if (token.d !== draftFingerprint(currentSegments)) {
      throw new ApiError(409, 'draft_changed',
        '预览之后草稿已被修改（片段增删改或审校变化）。为避免覆盖更改，请重新预览后再确认；本次未写入任何内容',
        { current_segments: currentSegments });
    }

    const moved = get().transaction(() => {
      const lockedVideo = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!lockedVideo) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      const rows = get().prepare('SELECT * FROM segments WHERE video_id = ?').all(videoId);
      const missing = missingSegmentIds(rows, ids);
      if (missing.length) {
        throw new ApiError(422, 'unknown_segments',
          `以下片段 ID 不存在于该视频：${missing.join('、')}`, { missing_ids: missing });
      }
      const plan = planShift(rows.map(mapSegment), ids, offsetMs, lockedVideo.duration_ms);
      if (plan.blocked) {
        const first = plan.boundary_issues[0] || plan.conflicts[0];
        throw new ApiError(422, 'shift_blocked',
          `平移被阻止（${plan.boundary_issues.length + plan.conflicts.length} 处问题）：`
          + '任一片段越过视频边界或与未选片段重叠都会拒绝；请调整选择或偏移，本次未写入任何内容：\n'
          + first.message,
          { boundary_issues: plan.boundary_issues, conflicts: plan.conflicts });
      }
      const ts = now();
      // 仅移动所选原文片段：时间整体加上偏移、修订号逐段 +1、撤销原文审校；文字不变。
      // 译文行不动（文字保留），其 source_* 仍指向旧时间 -> 列表中自动标记 stale，须重新校对。
      const update = get().prepare(
        `UPDATE segments
         SET start_ms = ?, end_ms = ?, reviewed = 0, revision = revision + 1, updated_at = ?
         WHERE id = ? AND video_id = ?`
      );
      return plan.moved.map((m) => {
        update.run(m.after_start_ms, m.after_end_ms, ts, m.segment_id, videoId);
        // 片段时间整体变化：该片段原文/译文质检放行都绑定了片段时间，全部失效并保留历史
        deactivateSegmentQcWaivers(get(), m.segment_id, ts);
        const row = get().prepare('SELECT * FROM segments WHERE id = ?').get(m.segment_id);
        return {
          segment_id: m.segment_id,
          before_start_ms: m.before_start_ms,
          before_end_ms: m.before_end_ms,
          after_start_ms: row.start_ms,
          after_end_ms: row.end_ms,
          reviewed: false,
          revision: row.revision,
        };
      });
    })();

    res.status(201).json({
      ok: true,
      offset_ms: offsetMs,
      moved_count: moved.length,
      moved,
      segments: listSegments(video.id),
      translations: listTranslations(video.id),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
