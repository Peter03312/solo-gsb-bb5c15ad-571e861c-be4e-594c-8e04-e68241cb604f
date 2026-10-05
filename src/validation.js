'use strict';

// 业务校验错误：携带 HTTP 状态码与可直接展示给用户的原因
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

// 按起始时间排序后检查：同一片段起止合法、片段之间不得时间重叠（端点相接允许）
function validateTimeline(segments, durationMs) {
  for (const s of segments) {
    if (!isInt(s.start_ms) || !isInt(s.end_ms)) {
      return { ok: false, reason: `片段 #${s.id} 的起止时间必须为整数毫秒` };
    }
    if (s.start_ms < 0) {
      return { ok: false, reason: `片段 #${s.id} 的起点不能为负数` };
    }
    if (s.start_ms >= s.end_ms) {
      return { ok: false, reason: `片段 #${s.id} 的起点必须早于终点` };
    }
    if (s.end_ms > durationMs) {
      return {
        ok: false,
        reason: `片段 #${s.id} 的终点 ${s.end_ms}ms 超过视频时长 ${durationMs}ms`,
      };
    }
  }

  const ordered = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.start_ms < prev.end_ms) {
      return {
        ok: false,
        reason: `片段 #${prev.id} 与片段 #${cur.id} 时间重叠（${cur.start_ms}ms 早于 ${prev.end_ms}ms），请先调整已有片段`,
      };
    }
  }
  return { ok: true };
}

module.exports = { ApiError, isInt, validateTimeline };
