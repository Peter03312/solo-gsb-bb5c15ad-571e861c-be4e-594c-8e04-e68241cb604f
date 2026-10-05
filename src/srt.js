'use strict';

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// 毫秒 -> SRT 时间戳：HH:MM:SS,mmm
function formatTimestamp(ms) {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3600000);
  const minutes = Math.floor((safe % 3600000) / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = safe % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

// segments: [{start_ms,end_ms,text}]，按起点排序后生成 SRT
function buildSrt(segments) {
  const ordered = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  return ordered
    .map((s, i) => {
      const text = String(s.text == null ? '' : s.text).replace(/\r\n/g, '\n').trim();
      return `${i + 1}\n${formatTimestamp(s.start_ms)} --> ${formatTimestamp(s.end_ms)}\n${text}\n`;
    })
    .join('\n');
}

/* ================= SRT 解析 =================
 *
 * 接受 UTF-8（可含 BOM）、CRLF/LF 混用、序号不连续、多行文本。
 * 解析失败时返回 {ok:false, errors:[{code,entry,seq,line,message}]}，
 * 尽量一次性列出全部结构性问题；调用方再做语义校验（负时间/起止倒置/越界/重叠）。
 */

// HH:MM:SS,mmm --> HH:MM:SS,mmm（兼容个位数与句点小数）；允许负号以便语义阶段明确报“负时间”
const TS_RE =
  /^\s*(-)?(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(-)?(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*(.*)$/;

function truncate(s, n = 60) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function tsToMs(sign, h, m, s, msStr) {
  const millis = Number(msStr.padEnd(3, '0'));
  const v = Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + millis;
  return sign === '-' ? -v : v;
}

function parseSrt(input) {
  if (typeof input !== 'string') {
    return { ok: false, errors: [{ code: 'not_text', entry: null, seq: null, line: 1, message: 'SRT 内容必须为 UTF-8 文本' }] };
  }

  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rawLines = text.split('\n');
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const isBlank = (l) => /^[ \t]*$/.test(l);

  // 按空行切块，保留行号
  const blocks = [];
  for (let i = 0; i < rawLines.length; ) {
    if (isBlank(rawLines[i])) { i++; continue; }
    const startLineNo = i + 1;
    const lines = [];
    while (i < rawLines.length && !isBlank(rawLines[i])) {
      lines.push({ no: i + 1, text: rawLines[i] });
      i++;
    }
    blocks.push({ startLineNo, lines });
  }

  if (blocks.length === 0) {
    return {
      ok: false,
      errors: [
        { code: 'empty_srt', entry: null, seq: null, line: 1, message: 'SRT 文件为空（或只含空白字符），未解析到任何字幕条目' },
      ],
    };
  }

  const errors = [];
  const entries = [];

  blocks.forEach((block, idx) => {
    const entryNo = idx + 1;
    const lines = block.lines;
    const where = (tail) => `第 ${entryNo} 个条目（第 ${block.startLineNo} 行起）${tail}`;
    const pushError = (code, line, message, seq = null) =>
      errors.push({ code, entry: entryNo, seq, line, message });

    let seq = null;
    let cursor = 0;
    const first = lines[0].text.trim();
    if (/^\d+$/.test(first)) {
      seq = Number(first);
      if (seq < 1) {
        pushError('bad_index', lines[0].no, where(`：序号必须为正整数，读到 "${first}"`));
        return;
      }
      cursor = 1;
    } else {
      pushError(
        'bad_index',
        lines[0].no,
        where(`：首行应为数字序号，实际读到 "${truncate(first)}"；已继续在本块内查找时间戳`)
      );
      // 不 return：尝试继续找时间戳，顺便把该块的其它问题一起报出
    }

    let tsIdx = -1;
    for (let j = cursor; j < lines.length; j++) {
      if (lines[j].text.includes('-->')) { tsIdx = j; break; }
    }
    if (tsIdx === -1) {
      // 首行序号解析失败且整块都没有时间戳时，bad_index 已足以定位问题
      if (seq !== null || lines.length > 1) {
        pushError('missing_timestamp', lines[cursor] ? lines[cursor].no : block.startLineNo,
          where('：缺少时间戳行，格式应为 HH:MM:SS,mmm --> HH:MM:SS,mmm'), seq);
      }
      return;
    }
    for (let j = cursor; j < tsIdx; j++) {
      pushError('unexpected_line', lines[j].no,
        `${where('：序号与时间戳之间存在多余的第 ' + lines[j].no + ' 行："' + truncate(lines[j].text) + '"')}`, seq);
    }

    const tsLine = lines[tsIdx];
    const m = TS_RE.exec(tsLine.text);
    if (!m) {
      pushError('bad_timestamp', tsLine.no,
        where(`：时间戳格式错误："${truncate(tsLine.text)}"，应为 HH:MM:SS,mmm --> HH:MM:SS,mmm`), seq);
      return;
    }

    // 分/秒必须在 00-59（小时不做上限）
    const componentPairs = [
      ['起点分钟', m[3]], ['起点秒', m[4]], ['终点分钟', m[8]], ['终点秒', m[9]],
    ];
    for (const [label, val] of componentPairs) {
      if (Number(val) > 59) {
        pushError('bad_time_component', tsLine.no,
          where(`：${label}必须在 00-59 之间，读到 "${val}"（时间戳第 ${tsLine.no} 行）`), seq);
        return;
      }
    }

    const start_ms = tsToMs(m[1], m[2], m[3], m[4], m[5]);
    const end_ms = tsToMs(m[6], m[7], m[8], m[9], m[10]);
    // 时间戳允许尾随空白与排版扩展（如 X1:/position: 信息），其余逐字保留
    const text = lines
      .slice(tsIdx + 1)
      .map((l) => l.text.replace(/[ \t]+$/g, ''))
      .join('\n');

    entries.push({ entry: entryNo, seq, line: lines[0].no, time_line: tsLine.no, start_ms, end_ms, text });
  });

  if (errors.length) return { ok: false, errors, entries: [] };
  return { ok: true, entries };
}

module.exports = { formatTimestamp, buildSrt, parseSrt };
