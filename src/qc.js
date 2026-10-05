'use strict';

/* ================= 质检（QC）纯计算模块 =================
 *
 * 规则：每个视频可分别为「原文」与「已启用译文」轨道配置
 *   - max_cps：最大每秒字符数（字符按 Unicode 码点计数，换行不计入速度，
 *     速度 = 非换行字符数 / 片段时长（秒），片段时长 = end_ms - start_ms）；
 *   - max_line_chars：最大单行字符数（按换行切分后最长一行的码点数）。
 * 阈值为 null 表示该轨道未配置该项，不产生违规、不阻断发布。
 */

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// 按 Unicode 码点计数（代理对组成的 emoji 等算 1 个；组合记号按码点各算 1 个）
function codePointLength(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of s) n++;
  return n;
}

// 测量一段文本：speed_chars 不计换行；max_line_chars 取最长一行的码点数
function measureText(text) {
  const t = normalizeText(text);
  const lines = t.split('\n');
  let maxLineChars = 0;
  let longestLineIndex = 0;
  lines.forEach((line, i) => {
    const n = codePointLength(line);
    if (n > maxLineChars) {
      maxLineChars = n;
      longestLineIndex = i;
    }
  });
  return {
    speed_chars: codePointLength(t.replace(/\n/g, '')),
    max_line_chars: maxLineChars,
    longest_line_index: longestLineIndex,
    line_count: lines.length,
  };
}

function cpsFor(speedChars, durationMs) {
  return durationMs > 0 ? (speedChars * 1000) / durationMs : 0;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

// 未配置规则时的空规则形态（revision 0 表示从未配置）
function emptyRules() {
  return {
    revision: 0,
    source: { max_cps: null, max_line_chars: null },
    translation: { max_cps: null, max_line_chars: null },
  };
}

function mapQcRules(row) {
  if (!row) return emptyRules();
  return {
    revision: row.revision,
    source: {
      max_cps: row.source_max_cps == null ? null : row.source_max_cps,
      max_line_chars: row.source_max_line_chars == null ? null : row.source_max_line_chars,
    },
    translation: {
      max_cps: row.translation_max_cps == null ? null : row.translation_max_cps,
      max_line_chars: row.translation_max_line_chars == null ? null : row.translation_max_line_chars,
    },
  };
}

function serializeWaiver(w) {
  return {
    id: w.id,
    segment_id: w.segment_id,
    track: w.track,
    rule: w.rule,
    language: w.language == null ? null : w.language,
    reason: w.reason,
    active: w.active === 1,
    bound_start_ms: w.bound_start_ms,
    bound_end_ms: w.bound_end_ms,
    bound_text: w.bound_text,
    bound_rules_revision: w.bound_rules_revision,
    bound_thresholds: {
      source_max_cps: w.bound_source_max_cps,
      source_max_line_chars: w.bound_source_max_line_chars,
      translation_max_cps: w.bound_translation_max_cps,
      translation_max_line_chars: w.bound_translation_max_line_chars,
    },
    created_at: w.created_at,
    revoked_at: w.revoked_at == null ? null : w.revoked_at,
  };
}

// 放行在当前状态下是否仍然成立：时间、文本、轨道语言、当时阈值（规则修订号）任一变化即失效
function waiverStillValid(w, ctx) {
  if (w.bound_rules_revision !== ctx.rulesRevision) return false;
  if (w.bound_start_ms !== ctx.seg.start_ms || w.bound_end_ms !== ctx.seg.end_ms) return false;
  if (w.track === 'source') {
    return w.bound_text === ctx.seg.text && (w.language == null);
  }
  // 译文轨道
  if (w.language !== ctx.language) return false;
  return w.bound_text === ctx.translationText;
}

const RULE_LABEL = { max_cps: '每秒字符数', max_line_chars: '最大单行字符数' };

function violationMessage({ trackName, segmentId, rule, value, threshold, extra }) {
  if (rule === 'max_cps') {
    return `${trackName}片段 #${segmentId}：每秒字符数 ${round3(value)} 超过阈值 ${threshold}（${extra.chars} 个字符 / ${(extra.duration_ms / 1000).toFixed(3)} 秒）`;
  }
  return `${trackName}片段 #${segmentId}：第 ${extra.line_index} 行 ${extra.line_chars} 个字符，超过单行阈值 ${threshold}`;
}

// 计算一个轨道在某片段上的质检项（仅输出已配置阈值的项）
function trackItems({ track, segmentId, text, durationMs, limits, activeWaiverForKey, trackName }) {
  const m = measureText(text);
  const items = [];

  if (limits.max_cps != null) {
    const value = cpsFor(m.speed_chars, durationMs);
    const violation = value > limits.max_cps;
    const w = violation ? activeWaiverForKey(track, 'max_cps') : null;
    items.push({
      rule: 'max_cps',
      threshold: limits.max_cps,
      value: round3(value),
      chars: m.speed_chars,
      duration_ms: durationMs,
      violation,
      waived: violation && !!w,
      waiver: w ? serializeWaiver(w) : null,
    });
  }

  if (limits.max_line_chars != null) {
    const value = m.max_line_chars;
    const violation = value > limits.max_line_chars;
    const w = violation ? activeWaiverForKey(track, 'max_line_chars') : null;
    items.push({
      rule: 'max_line_chars',
      threshold: limits.max_line_chars,
      value,
      line_index: m.longest_line_index + 1,
      line_chars: value,
      line_count: m.line_count,
      violation,
      waived: violation && !!w,
      waiver: w ? serializeWaiver(w) : null,
    });
  }

  const violations = [];
  for (const it of items) {
    if (!it.violation) continue;
    violations.push({
      segment_id: segmentId,
      start_ms: null, // 由调用方补齐
      end_ms: null,
      duration_ms: durationMs,
      track,
      rule: it.rule,
      threshold: it.threshold,
      value: it.value,
      waived: it.waived,
      waiver: it.waiver,
      detail:
        it.rule === 'max_cps'
          ? { chars: it.chars, duration_ms: it.duration_ms }
          : { line_index: it.line_index, line_chars: it.line_chars, line_count: it.line_count },
    });
  }
  return { items, violations };
}

/* 构建完整质检报告（草稿实时计算 / 发布时复用）。
 * 参数：
 *   language：译文轨道语言（null 表示未启用，此时只检查原文）
 *   segments：草稿原文片段 [{id,start_ms,end_ms,text}]
 *   translationBySegment：Map(segment_id -> 译文行 {text,stale})
 *   rulesRow：qc_rules 数据库行（可能为空）
 *   waiverRows：qc_waivers 数据库行（全部，含历史）
 */
function buildQcReport({ language, segments, translationBySegment, rulesRow, waiverRows }) {
  const rules0 = mapQcRules(rulesRow);
  const rules = {
    revision: rules0.revision,
    source: { ...rules0.source },
    translation: language
      ? { language, ...rules0.translation }
      : null,
  };
  const trackEnabled = {
    source: true, // 译文未启用时只检查原文；原文始终检查
    translation: !!language,
  };

  const validWaivers = [];
  const invalidWaivers = [];
  // 仅 active=1 且当前仍成立的放行才能抵消违规；active 锁存任一变化
  const activeKey = new Map();
  for (const w of waiverRows || []) {
    const seg = segments.find((s) => s.id === w.segment_id);
    let valid = false;
    if (w.active === 1 && seg) {
      const ctx = {
        rulesRevision: rules0.revision,
        seg,
        language,
        translationText: null,
      };
      if (w.track === 'translation') {
        const tr = language ? translationBySegment.get(w.segment_id) : null;
        if (tr) ctx.translationText = tr.text;
      }
      valid = trackEnabled[w.track] && waiverStillValid(w, ctx);
    }
    if (valid) {
      validWaivers.push(w);
      activeKey.set(`${w.segment_id}:${w.track}:${w.rule}`, w);
    } else {
      invalidWaivers.push(w);
    }
  }
  const waiverForKey = (segmentId) => (track, rule) => activeKey.get(`${segmentId}:${track}:${rule}`) || null;

  const segResults = [];
  const violations = [];

  for (const s of segments) {
    const durationMs = s.end_ms - s.start_ms;
    const getWaiver = waiverForKey(s.id);
    const sourceCalc = trackItems({
      track: 'source',
      segmentId: s.id,
      text: s.text,
      durationMs,
      limits: rules0.source,
      activeWaiverForKey: getWaiver,
      trackName: '原文',
    });

    let translationResult = null;
    const tr = language ? translationBySegment.get(s.id) : null;
    if (language) {
      if (tr) {
        const calc = trackItems({
          track: 'translation',
          segmentId: s.id,
          text: tr.text,
          durationMs,
          limits: rules0.translation,
          activeWaiverForKey: getWaiver,
          trackName: `译文（${language}）`,
        });
        translationResult = { present: true, stale: !!tr.stale, language, items: calc.items };
        for (const v of calc.violations) v.language = language;
        violations.push(...calc.violations);
      } else {
        translationResult = { present: false, stale: false, language, items: [] };
      }
    }

    for (const v of sourceCalc.violations) v.language = null;
    violations.push(...sourceCalc.violations);

    segResults.push({
      segment_id: s.id,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      duration_ms: durationMs,
      source: { items: sourceCalc.items },
      translation: translationResult,
    });
  }

  // 补齐违规的片段时间、语言与中文描述
  const segById = new Map(segments.map((s) => [s.id, s]));
  for (const v of violations) {
    const seg = segById.get(v.segment_id);
    v.start_ms = seg.start_ms;
    v.end_ms = seg.end_ms;
    const trackName = v.track === 'source' ? '原文' : `译文（${v.language || language}）`;
    v.message = violationMessage({
      trackName,
      segmentId: v.segment_id,
      rule: v.rule,
      value: v.value,
      threshold: v.threshold,
      extra: v.detail,
    });
  }

  const blocking = violations.filter((v) => !v.waived);
  const configured =
    rules0.source.max_cps != null || rules0.source.max_line_chars != null ||
    rules0.translation.max_cps != null || rules0.translation.max_line_chars != null;

  return {
    rules,
    tracks: language ? ['source', 'translation'] : ['source'],
    configured,
    segments: segResults,
    violations,
    blocking_violations: blocking,
    waivers: [...validWaivers, ...invalidWaivers].map(serializeWaiver),
    valid_waivers: validWaivers.map(serializeWaiver),
    active_waiver_count: validWaivers.length,
    inactive_waiver_count: invalidWaivers.length,
    violation_count: violations.length,
    blocking_count: blocking.length,
    can_publish: blocking.length === 0,
  };
}

module.exports = {
  codePointLength,
  measureText,
  cpsFor,
  round3,
  emptyRules,
  mapQcRules,
  buildQcReport,
  serializeWaiver,
  RULE_LABEL,
};
