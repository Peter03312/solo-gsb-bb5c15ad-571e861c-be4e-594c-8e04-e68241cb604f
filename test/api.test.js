'use strict';

// 端到端业务规则测试：启动真实 HTTP 服务 + 临时 SQLite，不依赖外部框架
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-desk-test-'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function req(method, url, body, raw) {
  const opts = { method, headers: {} };
  if (raw) { opts.body = raw; }
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, json, ok: res.ok, text: json ? null : null };
}

// multipart 上传构造（避免引入额外依赖）
function multipartVideo(filePath, fields) {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="sample.mp4"\r\nContent-Type: video/mp4\r\n\r\n`));
  chunks.push(fs.readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadVideo(title, durationMs, fileSize) {
  const f = path.join(tmpDir, `v-${Math.random().toString(16).slice(2)}.mp4`);
  fs.writeFileSync(f, Buffer.alloc(fileSize, 0x78));
  const { body, contentType } = multipartVideo(f, { title, duration_ms: String(durationMs) });
  const res = await fetch(`${BASE}/videos`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  const json = await res.json();
  check('上传返回 201', res.status === 201, JSON.stringify(json));
  return json.video;
}

async function main() {
  console.log('1. 上传与基本校验');
  const v = await uploadVideo('测试视频', 10000, 256);
  eq('时长被记录', v.duration_ms, 10000);

  const badDur = await req('POST', `/videos/${v.id}/segments`, { start_ms: 0, end_ms: -1, text: '' });
  check('负数终点 -> 422', badDur.status === 422);

  {
    const f = path.join(tmpDir, 'bad.mp4');
    fs.writeFileSync(f, Buffer.alloc(16));
    const mp = multipartVideo(f, { title: '坏时长', duration_ms: '-5' });
    const res = await fetch(`${BASE}/videos`, { method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body });
    const json = await res.json();
    check('非法时长 422', res.status === 422, JSON.stringify(json));
  }

  console.log('2. 片段增删改与时间合法性');
  let r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '第一句' });
  check('新增片段 201', r.status === 201);
  const s1 = r.json.segment;
  eq('新片段默认待审', s1.reviewed, false);
  eq('初始修订号为 1', s1.revision, 1);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 3000, end_ms: 2500, text: '反了' });
  check('起点晚于终点 -> 422', r.status === 422 && /起点必须早于终点/.test(r.json.error.message), r.json && r.json.error.message);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 0, end_ms: 12000, text: '超长' });
  check('终点超过视频时长 -> 422', r.status === 422 && /超过视频时长/.test(r.json.error.message), r.json && r.json.error.message);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 1500, end_ms: 2500, text: '重叠' });
  check('时间重叠 -> 422', r.status === 422 && /重叠/.test(r.json.error.message), r.json && r.json.error.message);

  // 非法修改后原稿仍在
  let list = (await req('GET', `/videos/${v.id}`)).json.segments;
  eq('非法修改未写入，原稿保留', list.map((x) => [x.start_ms, x.end_ms, x.text]), [[1000, 2000, '第一句']]);

  // 端点相接允许
  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 2000, end_ms: 3000, text: '第二句' });
  check('端点相接不算重叠 201', r.status === 201);
  const s2 = r.json.segment;

  console.log('3. 乐观锁修订号与冲突');
  // A 先改成功，revision 1 -> 2
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '第一句(改)', revision: 1 });
  check('携带正确修订号修改成功', r.status === 200);
  eq('修订号递增', r.json.segment.revision, 2);

  // B 拿着过期 revision=1 再改
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '覆盖尝试', revision: 1 });
  check('过期修订号 -> 409 冲突', r.status === 409, r.json && r.json.error.message);
  eq('冲突返回当前内容', r.json && r.json.error.current.text, '第一句(改)');
  eq('冲突返回当前修订号', r.json && r.json.error.current.revision, 2);

  // 过期内容没有覆盖他人修改
  list = (await req('GET', `/videos/${v.id}`)).json.segments;
  eq('他人修改未被覆盖', list.find((x) => x.id === s1.id).text, '第一句(改)');

  // 缺少修订号
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '无修订号' });
  check('缺少修订号 -> 422', r.status === 422);

  // 审校操作也要修订号；过期冲突
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 1 });
  check('过期修订号审校 -> 409', r.status === 409);

  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 2 });
  check('正确修订号审校成功', r.status === 200 && r.json.segment.reviewed === true);
  eq('审校后修订号为 3', r.json.segment.revision, 3);

  console.log('4. 修改已审片段撤销审校状态');
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '第一句(再改)', revision: 3 });
  check('编辑已审片段成功', r.status === 200);
  eq('审校状态被撤销', r.json.segment.reviewed, false);
  eq('修订号递增到 4', r.json.segment.revision, 4);

  // 删除同样受修订号保护
  r = await req('DELETE', `/videos/${v.id}/segments/${s2.id}`, { revision: 999 });
  check('过期修订号删除 -> 409', r.status === 409);
  list = (await req('GET', `/videos/${v.id}`)).json.segments;
  check('冲突删除未生效', list.some((x) => x.id === s2.id));

  console.log('5. 发布门禁与不可变版本');
  // 重新审校 s1（当前 rev 4）
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 4 });
  check('s1 重新审校成功', r.status === 200);

  // s2 未审 -> 不能发布
  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('存在未审片段时不能发布 -> 422', r.status === 422 && /未通过审校/.test(r.json.error.message));

  // 空视频不能发布
  const empty = await uploadVideo('空视频', 5000, 32);
  r = await req('POST', `/videos/${empty.id}/publish`, {});
  check('无片段不能发布 -> 422', r.status === 422 && /至少需要一个/.test(r.json.error.message));

  // 审校 s2（rev 1）
  r = await req('POST', `/videos/${v.id}/segments/${s2.id}/review`, { reviewed: true, revision: 1 });
  check('s2 审校成功', r.status === 200);

  // 状态接口
  r = await req('GET', `/videos/${v.id}/status`);
  check('全部已审且时间合法时 canPublish', r.json.canPublish === true, JSON.stringify(r.json));

  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('发布成功 201', r.status === 201, JSON.stringify(r.json));
  eq('首个版本号为 1', r.json.publication.version, 1);

  // 草稿 SRT
  let srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=draft`);
  let srt = await srtRes.text();
  check('草稿 SRT 含序号与时间戳', /1\n00:00:01,000 --> 00:00:02,000/.test(srt), JSON.stringify(srt));
  check('SRT 含第二句', /2\n00:00:02,000 --> 00:00:03,000/.test(srt));

  // 已发布 SRT
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=published`);
  srt = await srtRes.text();
  check('已发布 SRT 可下载', srtRes.status === 200 && /第一句\(再改\)/.test(srt));

  // 发布后编辑只影响草稿
  const s1cur = (await req('GET', `/videos/${v.id}`)).json.segments.find((x) => x.id === s1.id);
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, {
    start_ms: 1000, end_ms: 2000, text: '发布后的草稿改动', revision: s1cur.revision,
  });
  check('发布后仍可编辑草稿', r.status === 200);
  eq('编辑草稿再次撤销审校', r.json.segment.reviewed, false);

  srt = await (await fetch(`${BASE}/videos/${v.id}/srt?version=published`)).text();
  check('已发布版本保持不可变', /第一句\(再改\)/.test(srt) && !/草稿改动/.test(srt));
  srt = await (await fetch(`${BASE}/videos/${v.id}/srt?version=draft`)).text();
  check('草稿 SRT 反映最新编辑', /草稿改动/.test(srt));

  // 指定版本号与不存在版本
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=1`);
  check('按版本号下载 v1', srtRes.status === 200);
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=99`);
  check('不存在版本 -> 404', srtRes.status === 404);
  srtRes = await fetch(`${BASE}/videos/${empty.id}/srt?version=published`);
  check('无发布版本 -> 404', srtRes.status === 404);

  // 审校状态不完整时不能发布 v2
  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('新草稿未全部审校时不能发 v2 -> 422', r.status === 422);

  // 重新审校后发布 v2
  const s1now = (await req('GET', `/videos/${v.id}`)).json.segments.find((x) => x.id === s1.id);
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: s1now.revision });
  check('s1 再审校', r.status === 200);
  r = await req('POST', `/videos/${v.id}/publish`, {});
  eq('第二个不可变版本号为 2', r.json.publication.version, 2);

  const pubs = (await req('GET', `/videos/${v.id}/publications`)).json.publications;
  eq('版本列表为 [2,1]', pubs.map((p) => p.version), [2, 1]);

  console.log('6. 视频媒体流 Range');
  const rangeRes = await fetch(`http://127.0.0.1:${PORT}/api/videos/${v.id}/media`, { headers: { Range: 'bytes=0-15' } });
  check('Range 请求返回 206', rangeRes.status === 206);
  eq('Content-Range 正确', rangeRes.headers.get('content-range'), 'bytes 0-15/256');

  await srtImportTests();
  await restoreTests();
  await translationTests();
  await shiftTests();
  await splitTests();
  await speakerRosterTests();
  await speakerAssignTests();
  await speakerPublishTests();
  await speakerNewSegmentTests();
  await speakerTranslationTests();
  await speakerIsolationTests();

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}

async function srtPreview(videoId, content, filename = 'x.srt') {
  const fd = new FormData();
  fd.append('srt', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`${BASE}/videos/${videoId}/srt/preview`, { method: 'POST', body: fd });
  const json = await res.json();
  return { status: res.status, json };
}

async function srtImport(videoId, content, mode, token) {
  const fd = new FormData();
  fd.append('srt', new Blob([content], { type: 'text/plain' }), 'x.srt');
  fd.append('mode', mode);
  fd.append('token', token);
  const res = await fetch(`${BASE}/videos/${videoId}/srt/import`, { method: 'POST', body: fd });
  const json = await res.json();
  return { status: res.status, json };
}

async function srtImportTests() {
  console.log('7. SRT 导入：解析与错误条目（不写入）');
  const w = await uploadVideo('导入测试', 10000, 64);

  // 合法 SRT：UTF-8 BOM、CRLF、序号不连续(1,5)、多行文本
  const good = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n第二行\r\n\r\n' +
               '5\r\n00:00:03.000 --> 00:00:04,000\r\n不连续序号也行\r\n';
  let p = await srtPreview(w.id, good);
  check('合法 SRT 预览 200', p.status === 200, JSON.stringify(p.json));
  eq('解析出 2 个条目', p.json.imported_count, 2);
  eq('保留原文件行号', p.json.entries.map((e) => [e.seq, e.line, e.start_ms, e.end_ms]),
    [[1, 1, 1000, 2000], [5, 6, 3000, 4000]]);
  eq('多行文本被保留', p.json.entries[0].text, '你好\n第二行');
  check('空草稿无冲突', p.json.conflicts.length === 0 && p.json.append_blocked === false);

  // 空文件
  p = await srtPreview(w.id, '');
  check('空 SRT -> 422', p.status === 422 && p.json.error.code === 'invalid_srt');
  check('空 SRT 错误码 empty_srt', p.json.error.errors[0].code === 'empty_srt');

  // 仅 BOM 与空白
  p = await srtPreview(w.id, '﻿\n  \n\r\n');
  check('仅空白 SRT -> 422 empty_srt', p.status === 422 && p.json.error.errors[0].code === 'empty_srt');

  // 坏时间戳（含 --> 但结构不符合 HH:MM:SS,mmm --> HH:MM:SS,mmm）
  p = await srtPreview(w.id, '1\n00:01,000 --> 00:02,000\n坏');
  check('坏时间戳 -> 422', p.status === 422 && p.json.error.errors.some((e) => e.code === 'bad_timestamp'),
    JSON.stringify(p.json.error));
  check('错误带行号', p.json.error.errors[0].line === 2);

  // 缺序号
  p = await srtPreview(w.id, '00:00:01,000 --> 00:00:02,000\n无序号');
  check('缺序号 -> 422 bad_index', p.status === 422 && p.json.error.errors.some((e) => e.code === 'bad_index'));

  // 缺时间戳
  p = await srtPreview(w.id, '1\n只有序号和文本');
  check('缺时间戳 -> 422', p.status === 422 && p.json.error.errors.some((e) => e.code === 'missing_timestamp'));

  // 负时间（- 号被识别后由语义校验报 negative_time）
  p = await srtPreview(w.id, '1\n-00:00:01,000 --> 00:00:02,000\n负');
  check('负时间 -> 422 negative_time', p.status === 422 && p.json.error.errors.some((e) => e.code === 'negative_time'),
    JSON.stringify(p.json.error));

  // 起止倒置
  p = await srtPreview(w.id, '1\n00:00:05,000 --> 00:00:02,000\n倒置');
  check('起止倒置 -> 422 reversed_time', p.status === 422 && p.json.error.errors.some((e) => e.code === 'reversed_time'));

  // 零时长
  p = await srtPreview(w.id, '1\n00:00:02,000 --> 00:00:02,000\n零长');
  check('起点等于终点 -> 422', p.status === 422 && p.json.error.errors.some((e) => e.code === 'reversed_time'));

  // 越过视频时长
  p = await srtPreview(w.id, '1\n00:00:09,000 --> 00:00:11,000\n超长');
  check('越过视频时长 -> 422 beyond_duration', p.status === 422 && p.json.error.errors.some((e) => e.code === 'beyond_duration'),
    JSON.stringify(p.json.error));

  // 分秒超范围
  p = await srtPreview(w.id, '1\n00:00:61,000 --> 00:00:62,000\n超秒');
  check('秒数 61 -> 422', p.status === 422 && p.json.error.errors.some((e) => e.code === 'bad_time_component'));

  // 导入条目之间重叠
  p = await srtPreview(w.id, '1\n00:00:01,000 --> 00:00:03,000\na\n\n2\n00:00:02,000 --> 00:00:04,000\nb');
  check('导入条目互相重叠 -> 422 imported_overlap',
    p.status === 422 && p.json.error.errors.some((e) => e.code === 'imported_overlap'), JSON.stringify(p.json.error));

  // 端点相接允许
  p = await srtPreview(w.id, '1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:02,000 --> 00:00:03,000\nb');
  check('导入条目端点相接预览成功', p.status === 200);

  // 所有失败预览后没有任何片段写入
  let list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('失败预览零写入', list.length, 0);

  console.log('8. SRT 追加、替换与冲突');
  // 先放一段现有草稿 0-2s
  let r = await req('POST', `/videos/${w.id}/segments`, { start_ms: 0, end_ms: 2000, text: '原稿' });
  check('准备原稿片段 201', r.status === 201);

  // 导入 2s-4s（相接）与 5s-6s：可追加
  const okSrt = '1\n00:00:02,000 --> 00:00:04,000\n导入一\n\n3\n00:00:05,000 --> 00:00:06,000\n导入二';
  p = await srtPreview(w.id, okSrt);
  check('相接片段预览成功', p.status === 200);
  eq('预览报告草稿 1 段', p.json.draft_count, 1);

  // 无令牌 / 错模式（先于成功追加验证，避免草稿指纹变化）
  r = await srtImport(w.id, okSrt, 'append', 'garbage.token');
  check('坏令牌 -> 409 preview_required', r.status === 409 && r.json.error.code === 'preview_required');
  {
    const fd = new FormData();
    fd.append('srt', new Blob([okSrt], { type: 'text/plain' }), 'x.srt');
    fd.append('mode', 'merge');
    fd.append('token', p.json.token);
    const res = await fetch(`${BASE}/videos/${w.id}/srt/import`, { method: 'POST', body: fd });
    const json = await res.json();
    check('非法 mode -> 422', res.status === 422 && json.error.code === 'invalid_mode');
  }

  // 内容与预览不一致（草稿未变，仅内容指纹不符 -> 422）
  const otherSrt = '1\n00:00:02,000 --> 00:00:03,500\n改了内容';
  r = await srtImport(w.id, otherSrt, 'append', p.json.token);
  check('内容与预览不符 -> 422 srt_changed', r.status === 422 && r.json.error.code === 'srt_changed');
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('不符内容未写入', list.some((x) => x.text === '改了内容'), false);

  r = await srtImport(w.id, okSrt, 'append', p.json.token);
  check('追加成功 201', r.status === 201, JSON.stringify(r.json));
  eq('追加后共 3 段', r.json.segments.length, 3);
  check('导入片段全部待审', r.json.segments.filter((x) => x.text.startsWith('导入')).every((x) => x.reviewed === false));
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('原稿仍在', list.some((x) => x.text === '原稿'), true);

  // 与草稿冲突的预览：追加被阻止
  const clashSrt = '1\n00:00:01,000 --> 00:00:02,500\n冲突条目';
  p = await srtPreview(w.id, clashSrt);
  check('冲突预览仍 200 且给出冲突', p.status === 200 && p.json.conflicts.length >= 1 && p.json.append_blocked === true,
    JSON.stringify(p.json));
  check('冲突带双方定位', /原稿/.test('') || /片段/.test(p.json.conflicts[0].message), p.json.conflicts[0].message);
  r = await srtImport(w.id, clashSrt, 'append', p.json.token);
  check('冲突追加 -> 422 draft_conflict', r.status === 422 && r.json.error.errors.some((e) => e.code === 'draft_conflict'));
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('冲突追加零写入', list.some((x) => x.text === '冲突条目'), false);

  // 同一冲突文件替换可以成功
  r = await srtImport(w.id, clashSrt, 'replace', p.json.token);
  check('冲突文件替换成功 201', r.status === 201, JSON.stringify(r.json));
  eq('替换后仅剩导入片段', r.json.segments.length, 1);
  eq('替换后内容为导入', r.json.segments[0].text, '冲突条目');
  eq('替换后为待审', r.json.segments[0].reviewed, false);
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('原稿已被删除', list.some((x) => x.text === '原稿'), false);

  console.log('9. SRT 导入：预览后草稿被改 -> 确认拒绝整批');
  // 再预览一份可追加内容
  const addSrt = '1\n00:00:03,000 --> 00:00:04,000\n后加的';
  p = await srtPreview(w.id, addSrt);
  check('可追加内容预览成功', p.status === 200 && p.json.append_blocked === false, JSON.stringify(p.json));
  // 模拟他人修改草稿（新增片段）
  r = await req('POST', `/videos/${w.id}/segments`, { start_ms: 2500, end_ms: 2800, text: '他人改动' });
  check('预览后他人新增片段 201', r.status === 201);
  r = await srtImport(w.id, addSrt, 'append', p.json.token);
  check('过期预览确认 -> 409 draft_changed', r.status === 409 && r.json.error.code === 'draft_changed',
    JSON.stringify(r.json));
  check('冲突返回当前片段', Array.isArray(r.json.error.current_segments) && r.json.error.current_segments.length === 2);
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('过期确认零写入，他人改动保留', list.some((x) => x.text === '他人改动') && !list.some((x) => x.text === '后加的'), true);

  // 重新预览后确认成功（事务整批写入）
  p = await srtPreview(w.id, addSrt);
  r = await srtImport(w.id, addSrt, 'append', p.json.token);
  check('重新预览后追加成功', r.status === 201 && r.json.imported_count === 1, JSON.stringify(r.json));

  // JSON content 方式也可用
  p = await req('POST', `/videos/${w.id}/srt/preview`, {
    content: '1\n00:00:06,000 --> 00:00:07,000\nJSON 通道',
  });
  check('JSON content 预览 200', p.status === 200);
  r = await req('POST', `/videos/${w.id}/srt/import`, {
    content: '1\n00:00:06,000 --> 00:00:07,000\nJSON 通道',
    mode: 'append',
    token: p.json.token,
  });
  check('JSON content 追加成功', r.status === 201 && r.json.segments.some((x) => x.text === 'JSON 通道'), JSON.stringify(r.json));

  console.log('10. SRT 导入不影响发布版本与既有功能');
  // 在另一视频上发布版本后替换草稿，已发布版本保持不变
  const pv = await uploadVideo('发布保护', 5000, 48);
  await req('POST', `/videos/${pv.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '定稿' });
  const segId = (await req('GET', `/videos/${pv.id}`)).json.segments[0].id;
  await req('POST', `/videos/${pv.id}/segments/${segId}/review`, { reviewed: true, revision: 1 });
  r = await req('POST', `/videos/${pv.id}/publish`, {});
  check('先发布 v1', r.status === 201);
  const replSrt = '2\n00:00:00,500 --> 00:00:01,500\n导入替换草稿';
  p = await srtPreview(pv.id, replSrt);
  r = await srtImport(pv.id, replSrt, 'replace', p.json.token);
  check('替换草稿成功', r.status === 201 && r.json.segments.length === 1);
  const pubSrt = await (await fetch(`${BASE}/videos/${pv.id}/srt?version=published`)).text();
  check('已发布 SRT 保持原样', /定稿/.test(pubSrt) && !/导入替换草稿/.test(pubSrt));
  const draftSrt = await (await fetch(`${BASE}/videos/${pv.id}/srt?version=draft`)).text();
  check('草稿 SRT 为导入内容', /导入替换草稿/.test(draftSrt));
  // 替换后无法直接发布（导入片段待审）
  r = await req('POST', `/videos/${pv.id}/publish`, {});
  check('待审导入片段阻止发布 -> 422', r.status === 422 && /未通过审校/.test(r.json.error.message));

  // 无文件
  {
    const fd = new FormData();
    const res = await fetch(`${BASE}/videos/${pv.id}/srt/preview`, { method: 'POST', body: fd });
    const json = await res.json();
    check('缺少 SRT 字段 -> 422', res.status === 422 && json.error.code === 'missing_srt');
  }

  // 不存在视频
  p = await srtPreview(999999, '1\n00:00:01,000 --> 00:00:02,000\nx');
  check('未知视频预览 -> 404', p.status === 404);
}

async function restoreTests() {
  console.log('11. 历史版本区间恢复：预览与边界规则');
  const rv = await uploadVideo('区间恢复', 10000, 80);
  const addSeg = async (start, end, text) =>
    (await req('POST', `/videos/${rv.id}/segments`, { start_ms: start, end_ms: end, text })).json.segment;
  const reviewSeg = (vid, seg) =>
    req('POST', `/videos/${vid}/segments/${seg.id}/review`, { reviewed: true, revision: seg.revision });
  const getSegs = async (vid) => (await req('GET', `/videos/${vid}`)).json.segments;

  // v1：甲(1000-2000) 乙(3000-4000) 丙(5000-6000)，全部已审
  const A = await addSeg(1000, 2000, '甲');
  let B = await addSeg(3000, 4000, '乙');
  const C = await addSeg(5000, 6000, '丙');
  for (const s of [A, B, C]) await reviewSeg(rv.id, s);
  let r = await req('POST', `/videos/${rv.id}/publish`, {});
  check('发布 v1', r.status === 201 && r.json.publication.version === 1);

  // 演进出 v2：改乙、删丙、新增丁(6500-7000) 戊(8000-9000)
  B = (await getSegs(rv.id)).find((x) => x.id === B.id);
  await req('PUT', `/videos/${rv.id}/segments/${B.id}`, { start_ms: 3000, end_ms: 4000, text: '乙改', revision: B.revision });
  const cNow = (await getSegs(rv.id)).find((x) => x.id === C.id);
  await req('DELETE', `/videos/${rv.id}/segments/${C.id}`, { revision: cNow.revision });
  await addSeg(6500, 7000, '丁');
  await addSeg(8000, 9000, '戊');
  for (const s of (await getSegs(rv.id)).filter((x) => !x.reviewed)) await reviewSeg(rv.id, s);
  r = await req('POST', `/videos/${rv.id}/publish`, {});
  check('发布 v2', r.status === 201 && r.json.publication.version === 2);

  // 合法预览：区间 [2000,5000]，边界与两侧片段端点相接（不穿过）
  let p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 5000 });
  check('恢复预览 200', p.status === 200, JSON.stringify(p.json));
  eq('预览待恢复 1 段（来自 v1）', p.json.to_restore.map((e) => [e.start_ms, e.end_ms, e.text]), [[3000, 4000, '乙']]);
  eq('预览待移除 1 段（当前草稿）', p.json.to_remove.map((s) => [s.id, s.text]), [[B.id, '乙改']]);
  check('预览返回确认令牌', typeof p.json.token === 'string' && p.json.token.length > 10);
  const goodToken = p.json.token;

  // 边界穿过任一侧片段 -> 422 并指出片段与时间
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 3500 });
  check('终点穿过草稿片段 -> 422', p.status === 422 && p.json.error.code === 'range_crosses_segment', JSON.stringify(p.json));
  check('指出草稿片段与时间', p.json.error.crossings.some((c) =>
    c.side === 'draft' && c.segment_id === B.id && c.boundary === 'end' && c.at === 3500), JSON.stringify(p.json.error));
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 5500 });
  check('终点穿过发布快照片段 -> 422', p.status === 422 && p.json.error.code === 'range_crosses_segment');
  check('指出快照条目与时间', p.json.error.crossings.some((c) =>
    c.side === 'published' && c.at === 5500 && /5000–6000/.test(c.message)), JSON.stringify(p.json.error));
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 1500, end_ms: 5000 });
  check('起点穿过草稿片段 -> 422', p.status === 422 && p.json.error.crossings.some((c) =>
    c.boundary === 'start' && c.at === 1500 && c.segment_id === A.id), JSON.stringify(p.json.error));

  // 区间与版本参数校验
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 5000, end_ms: 5000 });
  check('起点等于终点 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 6000, end_ms: 5000 });
  check('起点晚于终点 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: -1, end_ms: 5000 });
  check('负起点 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 10001 });
  check('终点越过视频时长 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000.5, end_ms: 5000 });
  check('非整数区间 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000 });
  check('缺少区间端点 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 99, start_ms: 2000, end_ms: 5000 });
  check('版本不存在 -> 404', p.status === 404 && p.json.error.code === 'version_not_found');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 'x', start_ms: 2000, end_ms: 5000 });
  check('非法版本号 -> 422', p.status === 422 && p.json.error.code === 'invalid_version');
  p = await req('POST', '/videos/999999/restore/preview', { version: 1, start_ms: 0, end_ms: 100 });
  check('未知视频恢复预览 -> 404', p.status === 404);

  console.log('12. 区间恢复确认：令牌、参数一致性与预览后草稿变化');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000 });
  check('无令牌确认 -> 409 preview_required', r.status === 409 && r.json.error.code === 'preview_required');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000, token: 'garbage.token' });
  check('坏令牌 -> 409 preview_required', r.status === 409 && r.json.error.code === 'preview_required');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 2, start_ms: 2000, end_ms: 5000, token: goodToken });
  check('版本与预览不一致 -> 422', r.status === 422 && r.json.error.code === 'restore_params_changed');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5001, token: goodToken });
  check('区间与预览不一致 -> 422', r.status === 422 && r.json.error.code === 'restore_params_changed');

  // 预览后新增片段 -> 确认拒绝且不写入
  const ghost = await addSeg(9000, 9500, '他人新增');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000, token: goodToken });
  check('预览后草稿新增 -> 409 draft_changed', r.status === 409 && r.json.error.code === 'draft_changed', JSON.stringify(r.json));
  check('冲突返回当前片段列表', Array.isArray(r.json.error.current_segments) && r.json.error.current_segments.length === 5);
  await req('DELETE', `/videos/${rv.id}/segments/${ghost.id}`, { revision: 1 });

  // 预览后审校状态变化 -> 同样拒绝
  let aNow = (await getSegs(rv.id)).find((x) => x.id === A.id);
  await req('POST', `/videos/${rv.id}/segments/${A.id}/review`, { reviewed: false, revision: aNow.revision });
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000, token: goodToken });
  check('预览后审校变化 -> 409 draft_changed', r.status === 409 && r.json.error.code === 'draft_changed');
  aNow = (await getSegs(rv.id)).find((x) => x.id === A.id);
  await req('POST', `/videos/${rv.id}/segments/${A.id}/review`, { reviewed: true, revision: aNow.revision });
  eq('拒绝期间草稿未被写入', (await getSegs(rv.id)).map((s) => s.text), ['甲', '乙改', '丁', '戊']);

  // 空区间（两侧均无片段）：合法且零变更
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 6000, end_ms: 6500 });
  check('空区间预览 200 且清单为空', p.status === 200 && p.json.to_restore.length === 0 && p.json.to_remove.length === 0,
    JSON.stringify(p.json));
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 6000, end_ms: 6500, token: p.json.token });
  check('空区间确认 201 零变更', r.status === 201 && r.json.removed_count === 0 && r.json.restored_count === 0, JSON.stringify(r.json));
  eq('空恢复后草稿不变', r.json.segments.map((s) => s.text), ['甲', '乙改', '丁', '戊']);

  console.log('13. 区间恢复确认：成功恢复与不变量');
  const before = await getSegs(rv.id);
  const aBefore = before.find((x) => x.id === A.id);
  const dBefore = before.find((x) => x.text === '丁');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 5000 });
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000, token: p.json.token });
  check('确认恢复 201', r.status === 201, JSON.stringify(r.json));
  eq('移除 1 段', r.json.removed_count, 1);
  eq('恢复 1 段', r.json.restored_count, 1);
  eq('被移除的是区间内草稿片段', r.json.removed[0].id, B.id);
  const restored = r.json.restored[0];
  check('恢复片段是新片段（新 id）', restored.id !== B.id);
  eq('恢复片段修订号从 1 开始', restored.revision, 1);
  eq('恢复片段为待审', restored.reviewed, false);
  eq('恢复片段内容来自 v1', [restored.start_ms, restored.end_ms, restored.text], [3000, 4000, '乙']);
  eq('恢复后共 4 段', r.json.segments.length, 4);
  const aAfter = r.json.segments.find((x) => x.id === A.id);
  eq('区间外片段修订号不变', aAfter.revision, aBefore.revision);
  eq('区间外片段审校状态不变', aAfter.reviewed, aBefore.reviewed);
  const dAfter = r.json.segments.find((x) => x.text === '丁');
  eq('区间外片段 id 与修订号不变', [dAfter.id, dAfter.revision], [dBefore.id, dBefore.revision]);

  const pubs = (await req('GET', `/videos/${rv.id}/publications`)).json.publications;
  eq('历史发布版本不变', pubs.map((x) => x.version), [2, 1]);
  const v1Srt = await (await fetch(`${BASE}/videos/${rv.id}/srt?version=1`)).text();
  check('v1 SRT 导出语义不变', /甲/.test(v1Srt) && /乙/.test(v1Srt) && /丙/.test(v1Srt));
  const draftSrt = await (await fetch(`${BASE}/videos/${rv.id}/srt?version=draft`)).text();
  check('草稿 SRT 反映恢复结果', /乙/.test(draftSrt) && !/乙改/.test(draftSrt) && !/丙/.test(draftSrt));

  // 发布门禁沿用：恢复片段待审 -> 不能发布；审校后可发布
  r = await req('POST', `/videos/${rv.id}/publish`, {});
  check('恢复片段待审阻止发布 -> 422', r.status === 422 && /未通过审校/.test(r.json.error.message));
  const restoredNow = (await getSegs(rv.id)).find((x) => x.id === restored.id);
  await reviewSeg(rv.id, restoredNow);
  r = await req('POST', `/videos/${rv.id}/publish`, {});
  check('恢复片段审校后可发布 v3', r.status === 201 && r.json.publication.version === 3, JSON.stringify(r.json));

  console.log('14. 区间恢复：版本缺失与替换后时间线不合法（零写入）');
  const rv2 = await uploadVideo('恢复保护', 5000, 48);
  const one = (await req('POST', `/videos/${rv2.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '一' })).json.segment;
  await reviewSeg(rv2.id, one);
  r = await req('POST', `/videos/${rv2.id}/publish`, {});
  check('第二个视频发布 v1', r.status === 201);
  let p2 = await req('POST', `/videos/${rv2.id}/restore/preview`, { version: 1, start_ms: 0, end_ms: 2000 });
  check('替换前预览 200', p2.status === 200, JSON.stringify(p2.json));
  const rv2Token = p2.json.token;

  // 直接改库模拟损坏快照：区间内条目互相重叠 -> 替换后时间线不合法
  const Database = require('better-sqlite3');
  const db = new Database(path.join(tmpDir, 'test.db'));
  db.prepare('UPDATE publications SET snapshot = ? WHERE video_id = ? AND version = 1')
    .run(JSON.stringify([
      { start_ms: 500, end_ms: 1500, text: 'x' },
      { start_ms: 1000, end_ms: 1800, text: 'y' },
    ]), rv2.id);
  r = await req('POST', `/videos/${rv2.id}/restore/confirm`, { version: 1, start_ms: 0, end_ms: 2000, token: rv2Token });
  check('替换后时间线不合法 -> 422', r.status === 422 && r.json.error.code === 'invalid_timeline', JSON.stringify(r.json));
  p2 = await req('POST', `/videos/${rv2.id}/restore/preview`, { version: 1, start_ms: 0, end_ms: 2000 });
  check('预览同样拒绝非法替换', p2.status === 422 && p2.json.error.code === 'invalid_timeline');
  eq('非法替换零写入', (await getSegs(rv2.id)).map((s) => [s.start_ms, s.end_ms, s.text]), [[1000, 2000, '一']]);

  // 删除发布版本 -> 预览与确认均 404，且不写入
  db.prepare('DELETE FROM publications WHERE video_id = ? AND version = 1').run(rv2.id);
  db.close();
  p2 = await req('POST', `/videos/${rv2.id}/restore/preview`, { version: 1, start_ms: 0, end_ms: 2000 });
  check('版本被删后预览 -> 404', p2.status === 404 && p2.json.error.code === 'version_not_found');
  r = await req('POST', `/videos/${rv2.id}/restore/confirm`, { version: 1, start_ms: 0, end_ms: 2000, token: rv2Token });
  check('版本被删后确认 -> 404 且不写入', r.status === 404 && r.json.error.code === 'version_not_found');
  eq('版本缺失零写入', (await getSegs(rv2.id)).length, 1);
}

async function translationTests() {
  const getDetail = async (vid) => (await req('GET', `/videos/${vid}`)).json;
  const getTr = async (vid, sid) => (await getDetail(vid)).translations.find((x) => x.segment_id === sid);

  console.log('15. 译文轨道：启用、唯一语言与未启用保护');
  const tv = await uploadVideo('译文轨道', 10000, 64);
  const t1 = (await req('POST', `/videos/${tv.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '第一句' })).json.segment;
  const t2 = (await req('POST', `/videos/${tv.id}/segments`, { start_ms: 3000, end_ms: 4000, text: '第二句' })).json.segment;

  let r = await req('PUT', `/videos/${tv.id}/translation/track`, { language: '' });
  check('空语言 -> 422', r.status === 422 && r.json.error.code === 'invalid_language');
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'Hello', segment_revision: 1 });
  check('未启用轨道录入译文 -> 422 no_translation_track', r.status === 422 && r.json.error.code === 'no_translation_track');
  let srtRes = await fetch(`${BASE}/videos/${tv.id}/srt/translation?version=draft`);
  check('未启用轨道导出译文 -> 422 no_translation_track',
    srtRes.status === 422 && (await srtRes.json()).error.code === 'no_translation_track');

  r = await req('PUT', `/videos/${tv.id}/translation/track`, { language: 'en' });
  check('启用译文轨道 201', r.status === 201 && r.json.translation_lang === 'en', JSON.stringify(r.json));
  r = await req('PUT', `/videos/${tv.id}/translation/track`, { language: 'en' });
  check('重复启用同语言幂等 200', r.status === 200 && r.json.already_enabled === true);
  r = await req('PUT', `/videos/${tv.id}/translation/track`, { language: 'ja' });
  check('已有轨道时换语言 -> 422 track_exists', r.status === 422 && r.json.error.code === 'track_exists');
  let detail = await getDetail(tv.id);
  eq('详情返回轨道语言', detail.translation_lang, 'en');
  eq('详情返回空译文列表', detail.translations, []);

  console.log('16. 译文录入/审校：双修订号、撤销审校与失效规则');
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'First', segment_revision: 999 });
  check('原文修订号过期 -> 409', r.status === 409 && r.json.error.code === 'revision_conflict');
  check('409 返回当前原文与译文状态',
    r.json.error.current && r.json.error.current.segment.id === t1.id && r.json.error.current.translation === null,
    JSON.stringify(r.json.error));
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'First' });
  check('缺原文修订号 -> 422', r.status === 422 && r.json.error.code === 'missing_revision');
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'First', segment_revision: 1 });
  check('录入译文 201', r.status === 201, JSON.stringify(r.json));
  eq('新译文待审', r.json.translation.reviewed, false);
  eq('译文修订号从 1 开始', r.json.translation.revision, 1);
  eq('新译文未失效', r.json.translation.stale, false);
  eq('译文绑定当前原文内容', [r.json.translation.source_start_ms, r.json.translation.source_end_ms, r.json.translation.source_text],
    [1000, 2000, '第一句']);

  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'First!', segment_revision: 1 });
  check('改译文缺译文修订号 -> 422', r.status === 422 && r.json.error.code === 'missing_revision');
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'First!', segment_revision: 1, revision: 9 });
  check('译文修订号过期 -> 409 并返回当前译文', r.status === 409 && r.json.error.current.translation.text === 'First');
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'First!', segment_revision: 1, revision: 1 });
  check('携带双修订号改译文成功', r.status === 200 && r.json.translation.revision === 2, JSON.stringify(r.json));

  r = await req('POST', `/videos/${tv.id}/segments/${t2.id}/translation/review`, { reviewed: true, segment_revision: 1, revision: 1 });
  check('审校不存在的译文 -> 404', r.status === 404 && r.json.error.code === 'translation_not_found');
  r = await req('POST', `/videos/${tv.id}/segments/${t1.id}/translation/review`, { reviewed: true, segment_revision: 1, revision: 1 });
  check('审校译文旧修订号 -> 409', r.status === 409);
  r = await req('POST', `/videos/${tv.id}/segments/${t1.id}/translation/review`, { reviewed: true, segment_revision: 1, revision: 2 });
  check('审校译文成功', r.status === 200 && r.json.translation.reviewed === true);
  eq('审校后译文修订号递增', r.json.translation.revision, 3);

  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'First!!', segment_revision: 1, revision: 3 });
  check('修改已审译文成功', r.status === 200);
  eq('修改译文撤销其审校', r.json.translation.reviewed, false);
  r = await req('POST', `/videos/${tv.id}/segments/${t1.id}/translation/review`, { reviewed: true, segment_revision: 1, revision: 4 });
  check('译文再审校成功', r.status === 200 && r.json.translation.reviewed === true);

  // 原文文字改变 -> 译文失效；失效译文不能审校
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}`, { start_ms: 1000, end_ms: 2000, text: '第一句(改)', revision: 1 });
  check('修改原文文字成功', r.status === 200);
  eq('原文文字改变后译文失效', (await getTr(tv.id, t1.id)).stale, true);
  r = await req('POST', `/videos/${tv.id}/segments/${t1.id}/translation/review`, { reviewed: true, segment_revision: 2, revision: 5 });
  check('失效译文不能审校 -> 422 translation_stale', r.status === 422 && r.json.error.code === 'translation_stale');

  // 重新校对：重新绑定当前原文 -> 不再失效、审校撤销
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`, { text: 'First (revised)', segment_revision: 2, revision: 5 });
  check('失效后重新校对成功', r.status === 200, JSON.stringify(r.json));
  eq('重新校对后译文不再失效', r.json.translation.stale, false);
  eq('重新校对撤销译文审校', r.json.translation.reviewed, false);
  eq('译文重新绑定新原文', r.json.translation.source_text, '第一句(改)');

  // 仅切换原文审校状态 -> 译文不失效
  r = await req('POST', `/videos/${tv.id}/segments/${t1.id}/review`, { reviewed: true, revision: 2 });
  check('原文标记已审', r.status === 200);
  eq('仅切换原文审校不使译文失效', (await getTr(tv.id, t1.id)).stale, false);

  // 原文时间改变 -> 译文失效
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}`, { start_ms: 1200, end_ms: 2000, text: '第一句(改)', revision: 3 });
  check('修改原文时间成功', r.status === 200);
  eq('原文时间改变后译文失效', (await getTr(tv.id, t1.id)).stale, true);

  console.log('17. 删除 / 整稿替换 / 区间恢复不沿用旧译文');
  r = await req('PUT', `/videos/${tv.id}/segments/${t2.id}/translation`, { text: 'Second', segment_revision: 1 });
  check('给第二句录译文 201', r.status === 201);
  r = await req('DELETE', `/videos/${tv.id}/segments/${t2.id}`, { revision: 1 });
  check('删除片段成功', r.status === 200);
  check('删除片段后其译文被级联删除', (await getDetail(tv.id)).translations.every((x) => x.segment_id !== t2.id));

  const repl = '1\n00:00:05,000 --> 00:00:06,000\n全新草稿';
  let p = await srtPreview(tv.id, repl);
  r = await srtImport(tv.id, repl, 'replace', p.json.token);
  check('整稿替换成功', r.status === 201);
  eq('整稿替换后译文全部清空', (await getDetail(tv.id)).translations, []);

  // 区间恢复：恢复产生的新片段不沿用旧译文
  detail = await getDetail(tv.id);
  let g = detail.segments[0];
  r = await req('POST', `/videos/${tv.id}/segments/${g.id}/review`, { reviewed: true, revision: g.revision });
  check('草稿片段审校', r.status === 200);
  r = await req('PUT', `/videos/${tv.id}/segments/${g.id}/translation`, { text: 'Brand new', segment_revision: 2 });
  check('录入译文', r.status === 201);
  r = await req('POST', `/videos/${tv.id}/segments/${g.id}/translation/review`, { reviewed: true, segment_revision: 2, revision: 1 });
  check('译文审校', r.status === 200);
  r = await req('POST', `/videos/${tv.id}/publish`, {});
  check('双轨齐备发布 v1', r.status === 201 && r.json.publication.has_translation === true, JSON.stringify(r.json));
  r = await req('PUT', `/videos/${tv.id}/segments/${g.id}`, { start_ms: 5000, end_ms: 6000, text: '全新草稿改', revision: 2 });
  check('改草稿文字', r.status === 200);
  r = await req('PUT', `/videos/${tv.id}/segments/${g.id}/translation`, { text: 'Brand new 2', segment_revision: 3, revision: 2 });
  check('重新校对译文', r.status === 200);
  r = await req('POST', `/videos/${tv.id}/segments/${g.id}/translation/review`, { reviewed: true, segment_revision: 3, revision: 3 });
  check('译文再审校', r.status === 200);
  g = (await getDetail(tv.id)).segments[0];
  r = await req('POST', `/videos/${tv.id}/segments/${g.id}/review`, { reviewed: true, revision: g.revision });
  check('原文再审校', r.status === 200);
  r = await req('POST', `/videos/${tv.id}/publish`, {});
  check('发布 v2', r.status === 201 && r.json.publication.version === 2);
  p = await req('POST', `/videos/${tv.id}/restore/preview`, { version: 1, start_ms: 0, end_ms: 10000 });
  check('恢复预览 200', p.status === 200, JSON.stringify(p.json));
  r = await req('POST', `/videos/${tv.id}/restore/confirm`, { version: 1, start_ms: 0, end_ms: 10000, token: p.json.token });
  check('恢复确认 201', r.status === 201, JSON.stringify(r.json));
  eq('恢复产生的新片段不沿用旧译文', (await getDetail(tv.id)).translations, []);

  console.log('18. 双轨发布门禁与快照固定');
  const gv = await uploadVideo('双轨门禁', 8000, 48);
  await req('PUT', `/videos/${gv.id}/translation/track`, { language: 'zh-Hans' });
  const g1 = (await req('POST', `/videos/${gv.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '原文一' })).json.segment;
  await req('POST', `/videos/${gv.id}/segments/${g1.id}/review`, { reviewed: true, revision: 1 });

  r = await req('POST', `/videos/${gv.id}/publish`, {});
  check('缺译文不能发布 -> 422', r.status === 422 && r.json.error.code === 'not_publishable');
  check('失败返回待处理片段（缺译文）',
    Array.isArray(r.json.error.pending) && r.json.error.pending[0].segment_id === g1.id &&
    r.json.error.pending[0].reasons.includes('translation_missing'), JSON.stringify(r.json.error));
  eq('未生成部分版本', (await req('GET', `/videos/${gv.id}/publications`)).json.publications, []);

  r = await req('PUT', `/videos/${gv.id}/segments/${g1.id}/translation`, { text: '译文一', segment_revision: 2 });
  check('录入译文', r.status === 201);
  r = await req('POST', `/videos/${gv.id}/publish`, {});
  check('译文未审不能发布', r.status === 422 && r.json.error.pending[0].reasons.includes('translation_unreviewed'));
  eq('仍未生成部分版本', (await req('GET', `/videos/${gv.id}/publications`)).json.publications.length, 0);

  r = await req('POST', `/videos/${gv.id}/segments/${g1.id}/translation/review`, { reviewed: true, segment_revision: 2, revision: 1 });
  check('译文审校', r.status === 200);
  r = await req('GET', `/videos/${gv.id}/status`);
  check('状态接口报告双轨齐备可发布', r.json.canPublish === true && r.json.translation.language === 'zh-Hans' &&
    r.json.translation.reviewed === 1 && r.json.translation.missing === 0, JSON.stringify(r.json));
  r = await req('POST', `/videos/${gv.id}/publish`, {});
  check('双轨齐备发布 v1', r.status === 201 && r.json.publication.has_translation === true &&
    r.json.publication.translation_lang === 'zh-Hans', JSON.stringify(r.json));

  // 快照固定两轨：发布后改草稿译文，已发布译文 SRT 不变
  r = await req('PUT', `/videos/${gv.id}/segments/${g1.id}/translation`, { text: '译文一(改)', segment_revision: 2, revision: 2 });
  check('发布后改草稿译文', r.status === 200);
  let srt = await (await fetch(`${BASE}/videos/${gv.id}/srt/translation?version=published`)).text();
  check('已发布译文快照不可变', /译文一/.test(srt) && !/译文一\(改\)/.test(srt));
  srt = await (await fetch(`${BASE}/videos/${gv.id}/srt/translation?version=draft`)).text();
  check('草稿译文 SRT 反映最新修改', /译文一\(改\)/.test(srt));
  srt = await (await fetch(`${BASE}/videos/${gv.id}/srt?version=1`)).text();
  check('单语原文 SRT 导出不变', /原文一/.test(srt) && !/译文一/.test(srt));

  // 原文变更 -> 译文失效 -> 阻塞发布；原文未审同样阻塞
  r = await req('PUT', `/videos/${gv.id}/segments/${g1.id}`, { start_ms: 1000, end_ms: 2000, text: '原文一(改)', revision: 2 });
  check('改原文使译文失效', r.status === 200);
  r = await req('POST', `/videos/${gv.id}/publish`, {});
  check('译文失效阻塞发布', r.status === 422 && r.json.error.pending[0].reasons.includes('translation_stale'));
  r = await req('PUT', `/videos/${gv.id}/segments/${g1.id}/translation`, { text: '译文一(再改)', segment_revision: 3, revision: 3 });
  check('重新校对译文', r.status === 200);
  r = await req('POST', `/videos/${gv.id}/segments/${g1.id}/translation/review`, { reviewed: true, segment_revision: 3, revision: 4 });
  check('译文审校', r.status === 200);
  r = await req('POST', `/videos/${gv.id}/publish`, {});
  check('原文未审阻塞发布', r.status === 422 && r.json.error.pending[0].reasons.includes('segment_unreviewed'));
  r = await req('POST', `/videos/${gv.id}/segments/${g1.id}/review`, { reviewed: true, revision: 3 });
  check('原文审校', r.status === 200);
  r = await req('POST', `/videos/${gv.id}/publish`, {});
  check('再次齐备发布 v2', r.status === 201 && r.json.publication.version === 2);

  console.log('19. 译文 SRT 导出：缺失/失效拒绝并指出片段');
  const ev = await uploadVideo('译文导出', 5000, 48);
  await req('PUT', `/videos/${ev.id}/translation/track`, { language: 'en' });
  const e1 = (await req('POST', `/videos/${ev.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '甲' })).json.segment;

  srtRes = await fetch(`${BASE}/videos/${ev.id}/srt/translation?version=draft`);
  let ej = await srtRes.json();
  check('草稿缺译文 -> 422 translation_incomplete', srtRes.status === 422 && ej.error.code === 'translation_incomplete');
  check('指出缺失片段', ej.error.pending[0].segment_id === e1.id && ej.error.pending[0].reason === 'translation_missing');

  await req('PUT', `/videos/${ev.id}/segments/${e1.id}/translation`, { text: 'Alpha', segment_revision: 1 });
  await req('PUT', `/videos/${ev.id}/segments/${e1.id}`, { start_ms: 1000, end_ms: 2000, text: '甲乙', revision: 1 });
  srtRes = await fetch(`${BASE}/videos/${ev.id}/srt/translation?version=draft`);
  ej = await srtRes.json();
  check('译文失效 -> 422 并指出片段', srtRes.status === 422 && ej.error.pending[0].reason === 'translation_stale' &&
    ej.error.pending[0].segment_id === e1.id, JSON.stringify(ej));

  await req('PUT', `/videos/${ev.id}/segments/${e1.id}/translation`, { text: 'Alpha Beta', segment_revision: 2, revision: 1 });
  srtRes = await fetch(`${BASE}/videos/${ev.id}/srt/translation?version=draft`);
  srt = await srtRes.text();
  check('齐备草稿译文 SRT 可导出', srtRes.status === 200 && /Alpha Beta/.test(srt) && !/甲乙/.test(srt), srt);
  check('译文 SRT 时间戳正确', /00:00:01,000 --> 00:00:02,000/.test(srt));
  check('文件名携带语言标记', (srtRes.headers.get('content-disposition') || '').includes('.en.srt'));

  srtRes = await fetch(`${BASE}/videos/${ev.id}/srt/translation?version=published`);
  check('无发布版本 -> 404', srtRes.status === 404 && (await srtRes.json()).error.code === 'no_publication');
  srtRes = await fetch(`${BASE}/videos/${ev.id}/srt/translation?version=99`);
  check('版本不存在 -> 404', srtRes.status === 404 && (await srtRes.json()).error.code === 'version_not_found');
  srtRes = await fetch(`${BASE}/videos/${ev.id}/srt/translation?version=abc`);
  check('非法版本参数 -> 422', srtRes.status === 422 && (await srtRes.json()).error.code === 'invalid_version');

  // 未启用轨道时发布的旧版本不含译文快照
  const wv = await uploadVideo('纯原文视频', 5000, 48);
  const w1 = (await req('POST', `/videos/${wv.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '仅原文' })).json.segment;
  await req('POST', `/videos/${wv.id}/segments/${w1.id}/review`, { reviewed: true, revision: 1 });
  r = await req('POST', `/videos/${wv.id}/publish`, {});
  check('无轨道视频按单语门禁发布 v1', r.status === 201 && r.json.publication.has_translation === false);
  srtRes = await fetch(`${BASE}/videos/${wv.id}/srt/translation?version=1`);
  check('旧发布版本无译文 -> 422 translation_unavailable',
    srtRes.status === 422 && (await srtRes.json()).error.code === 'translation_unavailable');
  srtRes = await fetch(`${BASE}/videos/${wv.id}/srt/translation?version=published`);
  check('最新发布同样无译文 -> 422', srtRes.status === 422);

  console.log('20. 停用译文轨道：删除全部译文并恢复单语门禁');
  r = await req('DELETE', `/videos/${ev.id}/translation/track`);
  check('停用轨道 204', r.status === 204);
  detail = await getDetail(ev.id);
  eq('停用后轨道语言清空', detail.translation_lang, null);
  eq('停用后译文全部删除', detail.translations, []);
  r = await req('DELETE', `/videos/${ev.id}/translation/track`);
  check('重复停用 -> 404', r.status === 404 && r.json.error.code === 'no_translation_track');
  r = await req('PUT', `/videos/${ev.id}/translation/track`, { language: 'ja' });
  check('停用后可启用其它语言', r.status === 201 && r.json.translation_lang === 'ja');
  r = await req('DELETE', `/videos/${ev.id}/translation/track`);
  check('再次停用 204', r.status === 204);
  // 停用后回到单语门禁：审校原文即可发布，且新版本不含译文快照
  const e1cur = (await getDetail(ev.id)).segments.find((x) => x.id === e1.id);
  await req('POST', `/videos/${ev.id}/segments/${e1.id}/review`, { reviewed: true, revision: e1cur.revision });
  r = await req('POST', `/videos/${ev.id}/publish`, {});
  check('停用轨道后按单语门禁发布', r.status === 201 && r.json.publication.has_translation === false, JSON.stringify(r.json));
}

async function shiftTests() {
  console.log('21. 多片段整体平移：参数校验与预览');
  const sv = await uploadVideo('整体平移', 10000, 64);
  const addSeg = async (start, end, text) =>
    (await req('POST', `/videos/${sv.id}/segments`, { start_ms: start, end_ms: end, text })).json.segment;
  const getSegs = async () => (await req('GET', `/videos/${sv.id}`)).json.segments;
  const shiftPreview = (body) => req('POST', `/videos/${sv.id}/segments/shift/preview`, body);
  const shiftConfirm = (body) => req('POST', `/videos/${sv.id}/segments/shift/confirm`, body);

  const a = await addSeg(1000, 2000, '甲');
  const b = await addSeg(3000, 4000, '乙');
  const c = await addSeg(5000, 6000, '丙');

  // 空选择 / 非数组 / 非正整数 ID
  let r = await shiftPreview({ segment_ids: [], offset_ms: 100 });
  check('空选择 -> 422 invalid_segment_ids', r.status === 422 && r.json.error.code === 'invalid_segment_ids');
  r = await shiftPreview({ segment_ids: 'x', offset_ms: 100 });
  check('ID 非数组 -> 422', r.status === 422 && r.json.error.code === 'invalid_segment_ids');
  r = await shiftPreview({ segment_ids: [a.id, -1], offset_ms: 100 });
  check('ID 非正整数 -> 422', r.status === 422 && r.json.error.code === 'invalid_segment_ids');
  r = await shiftPreview({ offset_ms: 100 });
  check('缺少 segment_ids -> 422', r.status === 422 && r.json.error.code === 'invalid_segment_ids');
  // 重复 ID
  r = await shiftPreview({ segment_ids: [a.id, a.id, b.id], offset_ms: 100 });
  check('重复 ID -> 422 duplicate_segment_ids', r.status === 422 && r.json.error.code === 'duplicate_segment_ids' &&
    r.json.error.duplicate_ids.includes(a.id), JSON.stringify(r.json));
  // 不存在的 ID
  r = await shiftPreview({ segment_ids: [a.id, 999999], offset_ms: 100 });
  check('不存在 ID -> 422 unknown_segments', r.status === 422 && r.json.error.code === 'unknown_segments' &&
    r.json.error.missing_ids.includes(999999), JSON.stringify(r.json));
  // 偏移校验
  r = await shiftPreview({ segment_ids: [a.id] });
  check('缺少偏移 -> 422 invalid_offset', r.status === 422 && r.json.error.code === 'invalid_offset');
  r = await shiftPreview({ segment_ids: [a.id], offset_ms: 0 });
  check('零偏移 -> 422 invalid_offset', r.status === 422 && r.json.error.code === 'invalid_offset');
  r = await shiftPreview({ segment_ids: [a.id], offset_ms: 1.5 });
  check('非整数偏移 -> 422', r.status === 422 && r.json.error.code === 'invalid_offset');
  r = await shiftPreview({ segment_ids: [a.id], offset_ms: '100' });
  check('字符串偏移 -> 422', r.status === 422 && r.json.error.code === 'invalid_offset');
  // 未知视频
  r = await req('POST', '/videos/999999/segments/shift/preview', { segment_ids: [1], offset_ms: 100 });
  check('未知视频预览 -> 404', r.status === 404);

  console.log('22. 平移预览：前后时间、越界、重叠与相对间距');
  // 正常预览：甲、乙一起 +500（相对间距 1000ms 不变）
  let p = await shiftPreview({ segment_ids: [a.id, b.id], offset_ms: 500 });
  check('正常预览 200', p.status === 200, JSON.stringify(p.json));
  eq('预览选择/未选数量', [p.json.selected_count, p.json.unselected_count], [2, 1]);
  eq('预览前后时间', p.json.moved.map((m) => [m.before_start_ms, m.before_end_ms, m.after_start_ms, m.after_end_ms]),
    [[1000, 2000, 1500, 2500], [3000, 4000, 3500, 4500]]);
  check('无越界无冲突可确认', p.json.blocked === false && p.json.conflicts.length === 0 && p.json.boundary_issues.length === 0);
  check('返回确认令牌', typeof p.json.token === 'string' && p.json.token.includes('.'));
  // 预览不写入
  let segs = await getSegs();
  eq('预览不写入', segs.find((x) => x.id === a.id).start_ms, 1000);

  // 越界：起点为 0 边界 / 终点超时长
  p = await shiftPreview({ segment_ids: [a.id], offset_ms: -2000 });
  check('起点越过视频边界 -> 预览 blocked', p.status === 200 && p.json.blocked === true &&
    p.json.boundary_issues.some((x) => x.segment_id === a.id && x.kind === 'before_start'), JSON.stringify(p.json));
  p = await shiftPreview({ segment_ids: [c.id], offset_ms: 5000 });
  check('终点越过视频时长 -> 预览 blocked', p.status === 200 &&
    p.json.boundary_issues.some((x) => x.kind === 'beyond_duration' && x.at === 11000));
  // 预览中端点相接允许：乙 -1000 -> 2000-3000，与甲 1000-2000 端点相接，且不与丙重叠
  p = await shiftPreview({ segment_ids: [b.id], offset_ms: -1000 });
  check('与未选片段端点相接 -> 不冲突', p.json.blocked === false, JSON.stringify(p.json));
  // 相对间距：多选片段各自平移相同偏移，间距保持
  p = await shiftPreview({ segment_ids: [a.id, b.id, c.id], offset_ms: 200 });
  eq('相对间距不变（平移后起点差）',
    [p.json.moved[1].after_start_ms - p.json.moved[0].after_start_ms,
     p.json.moved[2].after_start_ms - p.json.moved[1].after_start_ms], [2000, 2000]);

  // 与未选片段重叠：只移甲 +2500 -> 3500-4500 撞上未选乙 3000-4000
  p = await shiftPreview({ segment_ids: [a.id], offset_ms: 2500 });
  check('撞上未选片段 -> blocked 且给出双方', p.status === 200 && p.json.blocked === true &&
    p.json.conflicts.length === 1 && p.json.conflicts[0].segment_id === a.id &&
    p.json.conflicts[0].other_segment_id === b.id, JSON.stringify(p.json));
  // 负偏移重叠：移丙 -2500 -> 2500-3500 撞上未选乙
  p = await shiftPreview({ segment_ids: [c.id], offset_ms: -2500 });
  check('负偏移撞上未选片段 -> blocked', p.json.blocked === true &&
    p.json.conflicts[0].other_segment_id === b.id);
  // 全选整体平移：所选片段之间（含相接）不算冲突；整体 +4000 后丙终点恰好等于视频时长，允许
  p = await shiftPreview({ segment_ids: [a.id, b.id, c.id], offset_ms: 4000 });
  check('全选平移无未选冲突、贴视频末尾允许', p.status === 200 && p.json.blocked === false &&
    p.json.conflicts.length === 0 && p.json.boundary_issues.length === 0, JSON.stringify(p.json));
  eq('全选平移后丙贴齐视频末尾', p.json.moved[2].after_end_ms, 10000);

  console.log('23. 平移确认：越界/重叠拒绝零写入与事务原子性');
  p = await shiftPreview({ segment_ids: [a.id], offset_ms: 2500 });
  r = await shiftConfirm({ segment_ids: [a.id], offset_ms: 2500, token: p.json.token });
  check('冲突确认 -> 422 shift_blocked 零写入', r.status === 422 && r.json.error.code === 'shift_blocked' &&
    r.json.error.conflicts.some((x) => x.segment_id === a.id), JSON.stringify(r.json));
  segs = await getSegs();
  eq('冲突后时间不变', segs.map((s) => [s.id, s.start_ms, s.end_ms]),
    [[a.id, 1000, 2000], [b.id, 3000, 4000], [c.id, 5000, 6000]]);
  p = await shiftPreview({ segment_ids: [c.id], offset_ms: 5000 });
  r = await shiftConfirm({ segment_ids: [c.id], offset_ms: 5000, token: p.json.token });
  check('越界确认 -> 422 shift_blocked', r.status === 422 && r.json.error.code === 'shift_blocked' &&
    r.json.error.boundary_issues.length === 1, JSON.stringify(r.json));
  eq('越界后零写入', (await getSegs()).find((x) => x.id === c.id).end_ms, 6000);

  console.log('24. 平移确认：令牌、参数一致性与预览后草稿变化');
  r = await shiftConfirm({ segment_ids: [a.id, b.id], offset_ms: 500 });
  check('无令牌确认 -> 409 preview_required', r.status === 409 && r.json.error.code === 'preview_required');
  r = await shiftConfirm({ segment_ids: [a.id, b.id], offset_ms: 500, token: 'garbage.token' });
  check('坏令牌 -> 409 preview_required', r.status === 409 && r.json.error.code === 'preview_required');
  p = await shiftPreview({ segment_ids: [a.id, b.id], offset_ms: 500 });
  r = await shiftConfirm({ segment_ids: [a.id, b.id], offset_ms: 600, token: p.json.token });
  check('偏移与预览不一致 -> 422 shift_params_changed',
    r.status === 422 && r.json.error.code === 'shift_params_changed', JSON.stringify(r.json));
  r = await shiftConfirm({ segment_ids: [a.id], offset_ms: 500, token: p.json.token });
  check('选择与预览不一致 -> 422 shift_params_changed',
    r.status === 422 && r.json.error.code === 'shift_params_changed');
  // 选择顺序不同、集合相同：允许
  r = await shiftConfirm({ segment_ids: [b.id, a.id], offset_ms: 500, token: p.json.token });
  check('选择顺序不同但集合相同 -> 201', r.status === 201, JSON.stringify(r.json));
  eq('两段时间正确移动', r.json.segments.map((s) => [s.start_ms, s.end_ms]),
    [[1500, 2500], [3500, 4500], [5000, 6000]]);
  const a2 = r.json.segments.find((x) => x.id === a.id);
  const b2 = r.json.segments.find((x) => x.id === b.id);
  const c2 = r.json.segments.find((x) => x.id === c.id);
  eq('所选片段修订号逐段 +1', [a2.revision, b2.revision], [2, 2]);
  eq('所选片段撤销审校为待审（原本就待审）', [a2.reviewed, b2.reviewed], [false, false]);
  eq('未选片段修订号不变', c2.revision, 1);

  // 预览后未选片段发生审校变化 -> 409 draft_changed，不写入
  p = await shiftPreview({ segment_ids: [a.id], offset_ms: 100 });
  await req('POST', `/videos/${sv.id}/segments/${c.id}/review`, { reviewed: true, revision: c2.revision });
  r = await shiftConfirm({ segment_ids: [a.id], offset_ms: 100, token: p.json.token });
  check('预览后审校变化 -> 409 draft_changed', r.status === 409 && r.json.error.code === 'draft_changed',
    JSON.stringify(r.json));
  check('409 附当前片段', Array.isArray(r.json.error.current_segments) && r.json.error.current_segments.length === 3);
  eq('409 零写入', (await getSegs()).find((x) => x.id === a.id).start_ms, 1500);
  // 重新预览后确认成功
  p = await shiftPreview({ segment_ids: [a.id], offset_ms: 100 });
  r = await shiftConfirm({ segment_ids: [a.id], offset_ms: 100, token: p.json.token });
  check('重新预览后确认 201', r.status === 201 && r.json.moved_count === 1, JSON.stringify(r.json));
  eq('甲再次移动 +100', r.json.segments.find((x) => x.id === a.id).start_ms, 1600);
  eq('甲修订号再次递增', r.json.segments.find((x) => x.id === a.id).revision, 3);
  eq('乙未受第二次平移影响', [r.json.segments.find((x) => x.id === b.id).start_ms,
    r.json.segments.find((x) => x.id === b.id).revision], [3500, 2]);

  console.log('25. 平移：撤销原文审校、译文保留但失效、门禁与历史不可变');
  const xv = await uploadVideo('平移双轨', 10000, 48);
  await req('PUT', `/videos/${xv.id}/translation/track`, { language: 'en' });
  const x1 = (await req('POST', `/videos/${xv.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '原文一' })).json.segment;
  const x2 = (await req('POST', `/videos/${xv.id}/segments`, { start_ms: 4000, end_ms: 5000, text: '原文二' })).json.segment;
  for (const s of [x1, x2]) {
    await req('POST', `/videos/${xv.id}/segments/${s.id}/review`, { reviewed: true, revision: 1 });
    await req('PUT', `/videos/${xv.id}/segments/${s.id}/translation`, { text: s.id === x1.id ? 'One' : 'Two', segment_revision: 2 });
    await req('POST', `/videos/${xv.id}/segments/${s.id}/translation/review`, { reviewed: true, segment_revision: 2, revision: 1 });
  }
  r = await req('POST', `/videos/${xv.id}/publish`, {});
  check('双轨齐备发布 v1', r.status === 201 && r.json.publication.version === 1, JSON.stringify(r.json));

  // 只平移 x1（与 x2 留有间隙，不冲突）
  p = await req('POST', `/videos/${xv.id}/segments/shift/preview`, { segment_ids: [x1.id], offset_ms: 500 });
  check('双轨视频预览 200', p.status === 200);
  r = await req('POST', `/videos/${xv.id}/segments/shift/confirm`, { segment_ids: [x1.id], offset_ms: 500, token: p.json.token });
  check('平移确认 201', r.status === 201, JSON.stringify(r.json));
  eq('已审原文被撤销', r.json.segments.find((s) => s.id === x1.id).reviewed, false);
  eq('原文修订号 +1', r.json.segments.find((s) => s.id === x1.id).revision, 3);
  eq('未选原文不动', [r.json.segments.find((s) => s.id === x2.id).start_ms,
    r.json.segments.find((s) => s.id === x2.id).reviewed], [4000, true]);
  // 译文：文字保留、标记失效、译文行仍在且其文字与修订号未被改写
  const tr1After = r.json.translations.find((t) => t.segment_id === x1.id);
  const tr2After = r.json.translations.find((t) => t.segment_id === x2.id);
  eq('译文文字保留', tr1After.text, 'One');
  eq('所选片段译文标记失效', tr1After.stale, true);
  eq('未选片段译文不失效', tr2After.stale, false);
  eq('译文行修订号不变', [tr1After.revision, tr2After.revision], [2, 2]);

  // 失效译文不能直接审校
  r = await req('POST', `/videos/${xv.id}/segments/${x1.id}/translation/review`, { reviewed: true, segment_revision: 3, revision: 2 });
  check('失效译文审校被拒 -> 422 translation_stale', r.status === 422 && r.json.error.code === 'translation_stale');

  // 发布门禁：原文未审 + 译文失效双重阻止
  r = await req('POST', `/videos/${xv.id}/publish`, {});
  check('门禁阻止直接发布', r.status === 422 && r.json.error.code === 'not_publishable');
  check('pending 指出原文未审与译文失效',
    r.json.error.pending.some((q) => q.segment_id === x1.id &&
      q.reasons.includes('segment_unreviewed') && q.reasons.includes('translation_stale')), JSON.stringify(r.json));
  // 草稿译文 SRT 导出同样被拒
  const trSrtRes = await fetch(`${BASE}/videos/${xv.id}/srt/translation?version=draft`);
  const trSrtJson = await trSrtRes.json();
  check('草稿译文 SRT 失效拒绝导出', trSrtRes.status === 422 && trSrtJson.error.code === 'translation_incomplete' &&
    trSrtJson.error.pending.some((q) => q.segment_id === x1.id && q.reason === 'translation_stale'), JSON.stringify(trSrtJson));

  // 按新时间重新校对译文 -> 不再失效
  r = await req('PUT', `/videos/${xv.id}/segments/${x1.id}/translation`, { text: 'One (retimed)', segment_revision: 3, revision: 2 });
  check('重新校对译文 200', r.status === 200);
  eq('重新绑定新时间', [r.json.translation.source_start_ms, r.json.translation.source_end_ms], [1500, 2500]);
  eq('重新校对后不失效', r.json.translation.stale, false);
  eq('重新校对撤销译文审校', r.json.translation.reviewed, false);

  // 历史发布版本与其原文/译文 SRT 保持不变
  const pubSrt = await (await fetch(`${BASE}/videos/${xv.id}/srt?version=1`)).text();
  check('历史原文 SRT 不变', /00:00:01,000 --> 00:00:02,000/.test(pubSrt) && /原文一/.test(pubSrt), pubSrt);
  const pubTrSrt = await (await fetch(`${BASE}/videos/${xv.id}/srt/translation?version=1`)).text();
  check('历史译文 SRT 不变', /00:00:01,000 --> 00:00:02,000/.test(pubTrSrt) && /One/.test(pubTrSrt), pubTrSrt);
  const pubs = (await req('GET', `/videos/${xv.id}/publications`)).json.publications;
  eq('历史发布版本仍只有 v1', pubs.map((x) => x.version), [1]);

  // 重新齐备后可发布 v2
  await req('POST', `/videos/${xv.id}/segments/${x1.id}/translation/review`, { reviewed: true, segment_revision: 3, revision: 3 });
  await req('POST', `/videos/${xv.id}/segments/${x1.id}/review`, { reviewed: true, revision: 3 });
  r = await req('POST', `/videos/${xv.id}/publish`, {});
  check('重新校对并审校后发布 v2', r.status === 201 && r.json.publication.version === 2, JSON.stringify(r.json));

  console.log('26. 质检规则：阈值校验、乐观锁与视频详情携带');
  const qv = await uploadVideo('质检视频', 10000, 32);
  let qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  eq('未配置时 tracks 仅原文', qc.tracks, ['source']);
  eq('未配置时 configured=false', qc.configured, false);
  eq('未配置时规则修订号为 0', qc.rules.revision, 0);
  eq('未配置时违规为 0', qc.blocking_count, 0);

  r = await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: 0, rules_revision: 0 });
  check('零阈值拒绝 -> 422', r.status === 422 && r.json.error.code === 'invalid_qc_threshold', JSON.stringify(r.json));
  r = await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: -3, rules_revision: 0 });
  check('负阈值拒绝 -> 422', r.status === 422 && r.json.error.code === 'invalid_qc_threshold');
  r = await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_line_chars: 5.5, rules_revision: 0 });
  check('单行字符数非整数 -> 422', r.status === 422 && r.json.error.code === 'invalid_qc_threshold');
  r = await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: 'abc', rules_revision: 0 });
  check('非数字阈值 -> 422', r.status === 422 && r.json.error.code === 'invalid_qc_threshold');
  r = await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: 10 });
  check('缺少规则修订号 -> 422', r.status === 422 && r.json.error.code === 'missing_revision');
  r = await req('PUT', `/videos/${qv.id}/qc/rules`, {});
  check('空规则体 -> 422 invalid_qc_rules', r.status === 422 && r.json.error.code === 'invalid_qc_rules');

  r = await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: 3.5, source_max_line_chars: 8, rules_revision: 0 });
  check('首次配置成功', r.status === 200 && r.json.rules_revision === 1, JSON.stringify(r.json));
  eq('小数 CPS 被保存', r.json.rules.source.max_cps, 3.5);
  r = await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: 9, rules_revision: 0 });
  check('过期规则修订号 -> 409 并返回当前规则', r.status === 409 &&
    r.json.error.code === 'revision_conflict' && r.json.error.current_rules.revision === 1, JSON.stringify(r.json));
  r = await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: null, rules_revision: 1 });
  check('null 清除阈值成功且修订号 +1', r.status === 200 && r.json.rules.source.max_cps === null &&
    r.json.rules_revision === 2, JSON.stringify(r.json));
  const detail = (await req('GET', `/videos/${qv.id}`)).json;
  eq('视频详情携带质检规则', detail.qc_rules.source.max_line_chars, 8);
  eq('视频详情质检汇总', detail.qc.configured, true);

  console.log('27. 质检计数：Unicode 码点、换行不计速度、时长换算与逐段报告');
  // 重新配置：CPS 阈值 3；单行阈值 1
  await req('PUT', `/videos/${qv.id}/qc/rules`,
    { source_max_cps: 3, source_max_line_chars: 1, translation_max_cps: null, translation_max_line_chars: null, rules_revision: 2 });
  // 'a' + '😀'（代理对，码点 1）+ 换行（不计速度）+ 'bb'：非换行码点 4 个；1000ms -> 4 cps
  const q1 = (await req('POST', `/videos/${qv.id}/segments`,
    { start_ms: 0, end_ms: 1000, text: 'a😀\nbb' })).json.segment;
  qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  let segQc = qc.segments.find((s) => s.segment_id === q1.id);
  const cpsItem = segQc.source.items.find((i) => i.rule === 'max_cps');
  const lineItem = segQc.source.items.find((i) => i.rule === 'max_line_chars');
  eq('换行不计速度：实测 4 cps', cpsItem.value, 4);
  eq('CPS 违规（4>3）', cpsItem.violation, true);
  eq('最长行按码点计为 2', lineItem.value, 2);
  eq('最长行序号为第 1 行', lineItem.line_index, 1);
  eq('单行违规（2>1）', lineItem.violation, true);
  eq('逐段报告给出轨道与阈值', [cpsItem.threshold, lineItem.threshold, cpsItem.chars, cpsItem.duration_ms],
    [3, 1, 4, 1000]);
  eq('共 2 项待放行', qc.blocking_count, 2);

  // 阈值等于实测不违规
  await req('PUT', `/videos/${qv.id}/qc/rules`,
    { source_max_cps: 4, source_max_line_chars: 2, rules_revision: 3 });
  qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  segQc = qc.segments.find((s) => s.segment_id === q1.id);
  eq('等于阈值不违规', segQc.source.items.every((i) => !i.violation), true);

  // 速度按时长换算：同文本拉长到 2000ms -> 2 cps
  await req('PUT', `/videos/${qv.id}/segments/${q1.id}`,
    { start_ms: 0, end_ms: 2000, text: 'a😀\nbb', revision: q1.revision });
  await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: 3, rules_revision: 4 });
  qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  segQc = qc.segments.find((s) => s.segment_id === q1.id);
  eq('2000ms 下实测 2 cps', segQc.source.items.find((i) => i.rule === 'max_cps').value, 2);
  eq('拉长后无 CPS 违规', segQc.source.items.find((i) => i.rule === 'max_cps').violation, false);

  console.log('28. 单项放行：参数校验、409、重复放行与报告状态');
  // 恢复违规场景：1000ms、CPS 阈值 1
  q1.revision = (await req('GET', `/videos/${qv.id}`)).json.segments.find((s) => s.id === q1.id).revision;
  await req('PUT', `/videos/${qv.id}/segments/${q1.id}`,
    { start_ms: 0, end_ms: 1000, text: 'a😀\nbb', revision: q1.revision });
  await req('PUT', `/videos/${qv.id}/qc/rules`,
    { source_max_cps: 1, source_max_line_chars: 1, rules_revision: 5 });
  qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  const vCps = qc.violations.find((x) => x.segment_id === q1.id && x.rule === 'max_cps');
  eq('违规清单给出中文说明与实测/阈值', [vCps.track, vCps.value, vCps.threshold, vCps.waived], ['source', 4, 1, false]);

  r = await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '片头快语速' });
  check('放行缺修订号 -> 422', r.status === 422 && r.json.error.code === 'missing_revision');
  r = await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '片头快语速', segment_revision: 999 });
  check('放行过期修订号 -> 409 返回当前状态', r.status === 409 &&
    r.json.error.code === 'revision_conflict' && r.json.error.current.segment.id === q1.id, JSON.stringify(r.json));
  r = await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '   ', segment_revision: qc.segments[0] ? q1.revision : 1 });
  check('空理由 -> 422', r.status === 422 && r.json.error.code === 'invalid_waiver_reason');
  r = await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'bad', rule: 'max_cps', reason: 'x', segment_revision: 1 });
  check('非法轨道 -> 422', r.status === 422 && r.json.error.code === 'invalid_qc_track');

  const curRev1 = (await req('GET', `/videos/${qv.id}`)).json.segments.find((s) => s.id === q1.id).revision;
  r = await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '片头快语速，人工确认', segment_revision: curRev1 });
  check('放行成功 201', r.status === 201, JSON.stringify(r.json));
  const waiverId = r.json.waiver.id;
  eq('放行绑定阈值快照', [r.json.waiver.bound_rules_revision, r.json.waiver.bound_start_ms,
    r.json.waiver.bound_end_ms, r.json.waiver.active], [6, 0, 1000, 1]);
  eq('放行后阻断数降到 1（单行仍违规）', r.json.qc.blocking_count, 1);
  r = await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '再放一次', segment_revision: curRev1 });
  check('重复放行 -> 422 waiver_exists 并回传当前质检', r.status === 422 &&
    r.json.error.code === 'waiver_exists' && !!r.json.error.current_qc, JSON.stringify(r.json));
  // 对当前并不违规的项放行 -> no_such_violation（此时 CPS 已放行；单行 2>1 仍违规，故先换一个高阈值场景）
  // 直接验证：未配置的规则项不能放行（先临时把单行阈值清除，见下方规则保存后恢复）
  const noViol = await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_line_chars', reason: '占位', segment_revision: curRev1 });
  check('单行当前可正常放行（随后验证重复）', noViol.status === 201, JSON.stringify(noViol.json));
  const wLineAgain = await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_line_chars', reason: '再来', segment_revision: curRev1 });
  check('单行重复放行 -> waiver_exists', wLineAgain.status === 422 && wLineAgain.json.error.code === 'waiver_exists');
  qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  eq('两项放行后阻断为 0', qc.blocking_count, 0);
  eq('有效放行 2 条', qc.active_waiver_count, 2);

  console.log('29. 放行失效：原文变化、规则变化（锁存且保留历史）');
  const curRev2 = (await req('GET', `/videos/${qv.id}`)).json.segments.find((s) => s.id === q1.id).revision;
  await req('PUT', `/videos/${qv.id}/segments/${q1.id}`,
    { start_ms: 0, end_ms: 1000, text: 'a😀\nbb（改）', revision: curRev2 });
  qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  check('原文变化后放行全部失效', qc.active_waiver_count === 0 && qc.inactive_waiver_count === 2,
    JSON.stringify({ a: qc.active_waiver_count, i: qc.inactive_waiver_count }));
  check('历史放行行仍保留且带理由', qc.waivers.length === 2 &&
    qc.waivers.every((w) => !w.active && w.revoked_at != null && w.reason.length > 0), JSON.stringify(qc.waivers));
  // 锁存：即使文本改回原值，旧放行也不自动复活
  const curRev3 = (await req('GET', `/videos/${qv.id}`)).json.segments.find((s) => s.id === q1.id).revision;
  await req('PUT', `/videos/${qv.id}/segments/${q1.id}`,
    { start_ms: 0, end_ms: 1000, text: 'a😀\nbb', revision: curRev3 });
  qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  check('恢复原文本后旧放行不复活（锁存）', qc.waivers.every((w) => !w.active), '放行应保持失效');

  // 规则变化使全部放行失效
  const curRev4 = (await req('GET', `/videos/${qv.id}`)).json.segments.find((s) => s.id === q1.id).revision;
  await req('PUT', `/videos/${qv.id}/segments/${q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '再次放行', segment_revision: curRev4 });
  await req('PUT', `/videos/${qv.id}/qc/rules`, { source_max_cps: 2, rules_revision: 6 });
  qc = (await req('GET', `/videos/${qv.id}/qc`)).json;
  check('规则修订号变化后放行失效且保留历史', qc.active_waiver_count === 0 &&
    qc.waivers.some((w) => w.reason === '再次放行' && !w.active));

  console.log('30. 发布：未放行阻止发布不出版本；放行后发布并固定规则/结果/放行');
  // 当前阈值：CPS 2（违规）、单行 1（违规），片段已审？先取消再设置干净场景
  const pv = await uploadVideo('发布质检', 10000, 32);
  // 先发布一个「未配置规则」的旧形态版本
  const p1 = (await req('POST', `/videos/${pv.id}/segments`, { start_ms: 0, end_ms: 1000, text: '短' })).json.segment;
  await req('POST', `/videos/${pv.id}/segments/${p1.id}/review`, { reviewed: true, revision: 1 });
  r = await req('POST', `/videos/${pv.id}/publish`, {});
  check('未配置规则时按原审校门禁发布 v1', r.status === 201 && r.json.publication.version === 1, JSON.stringify(r.json));
  eq('旧形态版本 has_qc=false', r.json.publication.has_qc, false);

  // 配置阈值后产生违规 -> 发布被质检阻止
  await req('PUT', `/videos/${pv.id}/qc/rules`, { source_max_cps: 1, rules_revision: 0 });
  // '短' 仅 1 字 = 1 cps，不违规；改成 3 字
  await req('PUT', `/videos/${pv.id}/segments/${p1.id}`,
    { start_ms: 0, end_ms: 1000, text: '一二三', revision: 2 });
  // 内容修改撤销了审校，先审校（满足原审校门禁，单独验证质检门禁）
  await req('POST', `/videos/${pv.id}/segments/${p1.id}/review`, { reviewed: true, revision: 3 });
  r = await req('POST', `/videos/${pv.id}/publish`, {});
  check('未放行违规阻止发布 -> 422 qc_blocked', r.status === 422 && r.json.error.code === 'qc_blocked',
    JSON.stringify(r.json).slice(0, 300));
  eq('返回违规清单（片段/轨道/项目/实测/阈值）',
    [r.json.error.qc_violations[0].segment_id, r.json.error.qc_violations[0].track,
      r.json.error.qc_violations[0].rule, r.json.error.qc_violations[0].value,
      r.json.error.qc_violations[0].threshold], [p1.id, 'source', 'max_cps', 3, 1]);
  let pvPubs = (await req('GET', `/videos/${pv.id}/publications`)).json.publications;
  eq('被阻止时不产生版本', pvPubs.map((x) => x.version), [1]);

  // 放行后发布成功（审校后片段修订号为 4）
  r = await req('PUT', `/videos/${pv.id}/segments/${p1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '标题口播，确认无误', segment_revision: 4 });
  check('阻断项放行成功', r.status === 201);
  r = await req('POST', `/videos/${pv.id}/publish`, {});
  check('放行后发布 v2', r.status === 201 && r.json.publication.version === 2, JSON.stringify(r.json));
  eq('v2 含质检快照', r.json.publication.has_qc, true);

  // 版本质检查询：固定的规则、结果与有效放行
  const snap = (await req('GET', `/videos/${pv.id}/publications/2/qc`)).json;
  eq('快照标记', snap.snapshot, true);
  eq('快照固定规则修订号', snap.rules_snapshot.revision, 1);
  eq('快照含违规与有效放行', [snap.violations.length, snap.valid_waivers.length, snap.violations[0].waived],
    [1, 1, true]);
  eq('快照放行理由固定', snap.valid_waivers[0].reason, '标题口播，确认无误');
  eq('快照固定当时阈值', [snap.valid_waivers[0].bound_thresholds.source_max_cps,
    snap.valid_waivers[0].bound_text], [1, '一二三']);
  const oldSnap = await req('GET', `/videos/${pv.id}/publications/1/qc`);
  check('旧版本无质检快照 -> 422 qc_unavailable（旧行为不变）',
    oldSnap.status === 422 && oldSnap.json.error.code === 'qc_unavailable');
  pvPubs = (await req('GET', `/videos/${pv.id}/publications`)).json.publications;
  eq('版本列表标记质检快照', pvPubs.map((x) => [x.version, x.has_qc]), [[2, true], [1, false]]);
  // 旧发布版本原文 SRT 行为不变
  const oldSrt = await (await fetch(`${BASE}/videos/${pv.id}/srt?version=1`)).text();
  check('旧版本原文 SRT 仍可导出且内容不变', /00:00:00,000 --> 00:00:01,000/.test(oldSrt) && /短/.test(oldSrt), oldSrt);

  // 发布后再改草稿：快照不变、草稿重新质检
  await req('PUT', `/videos/${pv.id}/segments/${p1.id}`,
    { start_ms: 0, end_ms: 1000, text: '一二三四五六', revision: 4 });
  const snap2 = (await req('GET', `/videos/${pv.id}/publications/2/qc`)).json;
  eq('发布后草稿变化不影响版本快照文本', snap2.valid_waivers[0].bound_text, '一二三');
  qc = (await req('GET', `/videos/${pv.id}/qc`)).json;
  check('草稿重新质检出现新违规', qc.blocking_count >= 1 &&
    qc.violations.some((x) => x.value === 6), JSON.stringify(qc.violations));

  console.log('31. 译文轨道质检：缺失/实测、双修订号放行、失效与停用只查原文');
  const tv = await uploadVideo('译文质检', 10000, 32);
  await req('PUT', `/videos/${tv.id}/translation/track`, { language: 'en' });
  const t1 = (await req('POST', `/videos/${tv.id}/segments`,
    { start_ms: 0, end_ms: 1000, text: '原文' })).json.segment;
  await req('PUT', `/videos/${tv.id}/qc/rules`,
    { source_max_cps: 100, translation_max_cps: 2, rules_revision: 0 });
  qc = (await req('GET', `/videos/${tv.id}/qc`)).json;
  eq('启用轨道后 tracks 含双轨', qc.tracks, ['source', 'translation']);
  segQc = qc.segments.find((s) => s.segment_id === t1.id);
  eq('缺失译文标记 present=false', segQc.translation.present, false);
  eq('缺失译文不产生译文违规（由审校门禁负责）',
    qc.violations.filter((x) => x.track === 'translation').length, 0);

  // 录入 5 码点译文 -> 5 cps 违规
  await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`,
    { text: 'hello', segment_revision: 1 });
  qc = (await req('GET', `/videos/${tv.id}/qc`)).json;
  const tvViol = qc.violations.find((x) => x.track === 'translation' && x.rule === 'max_cps');
  eq('译文实测 5 cps 超阈值 2', [tvViol.value, tvViol.threshold, tvViol.language], [5, 2, 'en']);

  // 译文放行需双修订号
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/qc/waiver`,
    { track: 'translation', rule: 'max_cps', reason: '英文连读', segment_revision: 1 });
  check('译文放行缺译文修订号 -> 422', r.status === 422 && r.json.error.code === 'missing_revision');
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/qc/waiver`,
    { track: 'translation', rule: 'max_cps', reason: '英文连读', segment_revision: 1, revision: 9 });
  check('译文修订号过期 -> 409', r.status === 409 && r.json.error.code === 'revision_conflict');
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/qc/waiver`,
    { track: 'translation', rule: 'max_cps', reason: '英文连读', segment_revision: 1, revision: 1 });
  check('双修订号正确译文放行成功', r.status === 201, JSON.stringify(r.json));
  eq('译文放行绑定语言', r.json.waiver.language, 'en');

  // 译文文本修改（rev 1 -> 2）-> 译文放行失效；原文放行不受译文变化影响
  await req('PUT', `/videos/${tv.id}/segments/${t1.id}/translation`,
    { text: 'world', segment_revision: 1, revision: 1 });
  qc = (await req('GET', `/videos/${tv.id}/qc`)).json;
  check('译文文本变化后译文放行失效', qc.waivers.some((w) => w.track === 'translation' && !w.active),
    JSON.stringify(qc.waivers));

  // 停用轨道：译文放行失效，只检查原文
  await req('DELETE', `/videos/${tv.id}/translation/track`);
  qc = (await req('GET', `/videos/${tv.id}/qc`)).json;
  eq('停用后只检查原文', qc.tracks, ['source']);
  check('停用后译文违规不再计入', qc.violations.every((x) => x.track === 'source'));
  check('停用后译文放行保留为失效历史', qc.waivers.some((w) => w.track === 'translation' && !w.active));
  // 未启用轨道时对译文放行 -> 422
  r = await req('PUT', `/videos/${tv.id}/segments/${t1.id}/qc/waiver`,
    { track: 'translation', rule: 'max_cps', reason: 'x', segment_revision: 1, revision: 1 });
  check('无译文轨道时译文放行 -> 422 no_translation_track',
    r.status === 422 && r.json.error.code === 'no_translation_track');

  console.log('32. 未配置阈值不增加阻断；status 汇总；平移使放行失效');
  const shiftv = await uploadVideo('无阈值视频', 10000, 24);
  const shiftS1 = (await req('POST', `/videos/${shiftv.id}/segments`,
    { start_ms: 0, end_ms: 500, text: '一二三四五六七八九十' })).json.segment;
  await req('POST', `/videos/${shiftv.id}/segments/${shiftS1.id}/review`, { reviewed: true, revision: 1 });
  r = await req('POST', `/videos/${shiftv.id}/publish`, {});
  check('未配置阈值：长文本也可正常发布（不增加阻断）', r.status === 201, JSON.stringify(r.json));
  const stNoCfg = (await req('GET', `/videos/${shiftv.id}/status`)).json;
  eq('status 携带质检汇总（未配置）', [stNoCfg.qc.configured, stNoCfg.qc.blocking_count, stNoCfg.qc.can_publish],
    [false, 0, true]);

  // 平移使放行失效
  await req('PUT', `/videos/${shiftv.id}/qc/rules`, { source_max_cps: 5, rules_revision: 0 });
  // 20 字 / 0.5 秒 = 40 cps 违规；放行（审校后片段修订号为 2）
  r = await req('PUT', `/videos/${shiftv.id}/segments/${shiftS1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '快', segment_revision: 2 });
  check('放行成功', r.status === 201);
  const prev2 = await req('POST', `/videos/${shiftv.id}/segments/shift/preview`,
    { segment_ids: [shiftS1.id], offset_ms: 500 });
  r = await req('POST', `/videos/${shiftv.id}/segments/shift/confirm`,
    { segment_ids: [shiftS1.id], offset_ms: 500, token: prev2.json.token });
  check('平移确认成功', r.status === 201);
  qc = (await req('GET', `/videos/${shiftv.id}/qc`)).json;
  check('平移后片段时间变化：放行失效并保留历史', qc.waivers.some((w) => !w.active) &&
    qc.active_waiver_count === 0, JSON.stringify(qc.waivers));

  // 对当前不存在的违规放行 -> 422 no_such_violation（平移后该片段时长仍 500ms、40cps 仍违规；
  // 改用「未配置的规则项」验证：单行阈值未配置）
  const shiftRev = (await req('GET', `/videos/${shiftv.id}`)).json.segments.find((s) => s.id === shiftS1.id).revision;
  const noItem = await req('PUT', `/videos/${shiftv.id}/segments/${shiftS1.id}/qc/waiver`,
    { track: 'source', rule: 'max_line_chars', reason: 'x', segment_revision: shiftRev });
  check('未配置/不违规的项放行 -> 422 no_such_violation',
    noItem.status === 422 && noItem.json.error.code === 'no_such_violation', JSON.stringify(noItem.json));

  console.log('33. 删除片段级联清除放行；旧发布 SRT 与无译文快照导出不变');
  // 新视频：配置规则、违规、放行、发布后删除片段 -> 放行随片段级联；历史版本质检快照仍可查
  const dv = await uploadVideo('级联视频', 10000, 24);
  const d1 = (await req('POST', `/videos/${dv.id}/segments`,
    { start_ms: 0, end_ms: 1000, text: '一二三四' })).json.segment;
  await req('PUT', `/videos/${dv.id}/qc/rules`, { source_max_cps: 1, rules_revision: 0 });
  await req('PUT', `/videos/${dv.id}/segments/${d1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '放行后发布', segment_revision: 1 });
  await req('POST', `/videos/${dv.id}/segments/${d1.id}/review`, { reviewed: true, revision: 1 });
  r = await req('POST', `/videos/${dv.id}/publish`, {});
  check('放行后发布 v1', r.status === 201 && r.json.publication.has_qc === true);
  // 删除片段（审校后修订号为 2）：草稿放行级联清除
  await req('DELETE', `/videos/${dv.id}/segments/${d1.id}`, { revision: 2 });
  qc = (await req('GET', `/videos/${dv.id}/qc`)).json;
  eq('片段删除后草稿放行被级联清除', qc.waivers.length, 0);
  const snapStill = await req('GET', `/videos/${dv.id}/publications/1/qc`);
  check('已发布版本质检快照仍可查（不可变）', snapStill.status === 200 &&
    snapStill.json.valid_waivers.length === 1, JSON.stringify(snapStill.json));
  // 双轨旧版本（无质检快照）译文 SRT 导出语义不变，由第 19/25 节覆盖；此处验证原文 SRT 仍正常
  const dSrt = await fetch(`${BASE}/videos/${dv.id}/srt?version=1`);
  check('该版本原文 SRT 导出不受影响', dSrt.ok && /一二三四/.test(await dSrt.text()));

  const stFinal = (await req('GET', `/videos/${qv.id}/status`)).json;
  check('status.qc 汇总字段齐备', typeof stFinal.qc.violation_count === 'number' &&
    typeof stFinal.qc.rules_revision === 'number', JSON.stringify(stFinal.qc));
}

async function splitTests() {
  console.log('34. 片段拆分：切点校验、修订号冲突与零写入');
  const sp = await uploadVideo('拆分视频', 10000, 48);
  const add = async (s, e, t) =>
    (await req('POST', `/videos/${sp.id}/segments`, { start_ms: s, end_ms: e, text: t })).json.segment;
  const getSegs = async () => (await req('GET', `/videos/${sp.id}`)).json.segments;

  const A = await add(1000, 2000, '前半句后半句');
  const B = await add(2000, 3000, '邻接片段');

  let r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 1500.5, left_text: '前', right_text: '后', revision: 1 });
  check('非整数切点 -> 422 invalid_cut_point', r.status === 422 && r.json.error.code === 'invalid_cut_point');
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 1000, left_text: '前', right_text: '后', revision: 1 });
  check('切点等于起点 -> 422', r.status === 422 && r.json.error.code === 'invalid_cut_point');
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 2000, left_text: '前', right_text: '后', revision: 1 });
  check('切点等于终点 -> 422', r.status === 422 && r.json.error.code === 'invalid_cut_point');
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 2500, left_text: '前', right_text: '后', revision: 1 });
  check('切点越出片段 -> 422', r.status === 422 && r.json.error.code === 'invalid_cut_point');
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 1500, left_text: '前', right_text: '后' });
  check('缺修订号 -> 422 missing_revision', r.status === 422 && r.json.error.code === 'missing_revision');
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 1500, left_text: '前', right_text: '后', revision: 7 });
  check('过期修订号 -> 409 且返回当前状态', r.status === 409 && r.json.error.code === 'revision_conflict' &&
    r.json.error.current.segment.id === A.id && r.json.error.current.segment.revision === 1, JSON.stringify(r.json));
  r = await req('POST', `/videos/${sp.id}/segments/999999/split`,
    { cut_ms: 1500, left_text: '前', right_text: '后', revision: 1 });
  check('片段不存在 -> 404', r.status === 404 && r.json.error.code === 'segment_not_found');
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 1500, left_text: '   ', right_text: '后', revision: 1 });
  check('左段仅空白 -> 422 empty_text', r.status === 422 && r.json.error.code === 'empty_text');
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 1500, left_text: '前', right_text: '', revision: 1 });
  check('右段为空 -> 422 empty_text', r.status === 422 && r.json.error.code === 'empty_text');
  eq('全部失败尝试零写入', (await getSegs()).map((x) => [x.id, x.start_ms, x.end_ms, x.text, x.revision]),
    [[A.id, 1000, 2000, '前半句后半句', 1], [B.id, 2000, 3000, '邻接片段', 1]]);

  // 已审片段拆分：两段均转待审；左段保留原 ID 且修订号 +1，右段获新 ID
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/review`, { reviewed: true, revision: 1 });
  check('拆分前标记已审', r.status === 200);
  r = await req('POST', `/videos/${sp.id}/segments/${A.id}/split`,
    { cut_ms: 1500, left_text: '前半句', right_text: '后半句', revision: 2 });
  check('拆分成功 201', r.status === 201, JSON.stringify(r.json));
  eq('左段保留原 ID 且修订号 +1', [r.json.left.id, r.json.left.revision], [A.id, 3]);
  eq('左段时间与文本', [r.json.left.start_ms, r.json.left.end_ms, r.json.left.text], [1000, 1500, '前半句']);
  eq('左段转待审', r.json.left.reviewed, false);
  check('右段获新 ID 且修订号从 1 开始', r.json.right.id !== A.id && r.json.right.revision === 1);
  eq('右段时间与文本', [r.json.right.start_ms, r.json.right.end_ms, r.json.right.text], [1500, 2000, '后半句']);
  eq('右段待审', r.json.right.reviewed, false);
  const rightId = r.json.right.id;
  let segs = await getSegs();
  eq('草稿变为 3 段且按时间排序',
    segs.map((x) => [x.id, x.start_ms, x.end_ms]),
    [[A.id, 1000, 1500], [rightId, 1500, 2000], [B.id, 2000, 3000]]);
  eq('相邻片段及其修订号不受影响', [segs[2].text, segs[2].revision, segs[2].reviewed], ['邻接片段', 1, false]);

  // 右段可级联再拆分
  r = await req('POST', `/videos/${sp.id}/segments/${rightId}/split`,
    { cut_ms: 1750, left_text: '后', right_text: '半句', revision: 1 });
  check('右段可再拆分', r.status === 201 && r.json.left.id === rightId && r.json.left.revision === 2);
  eq('再拆分后共 4 段', (await getSegs()).length, 4);

  // 时长 1ms 的片段不存在严格位于起止之间的整数切点
  const tiny = await add(4000, 4001, '一');
  r = await req('POST', `/videos/${sp.id}/segments/${tiny.id}/split`,
    { cut_ms: 4000, left_text: 'x', right_text: 'y', revision: 1 });
  check('1ms 片段无合法整数切点 -> 422', r.status === 422 && r.json.error.code === 'invalid_cut_point');

  console.log('35. 拆分与发布门禁、SRT 导出、历史版本不可变');
  // 拆分产生的待审段阻止发布
  r = await req('POST', `/videos/${sp.id}/publish`, {});
  check('存在待审段不能发布 -> 422', r.status === 422 && r.json.error.code === 'not_publishable');
  // 全部审校后发布 v1
  for (const s of await getSegs()) {
    await req('POST', `/videos/${sp.id}/segments/${s.id}/review`, { reviewed: true, revision: s.revision });
  }
  r = await req('POST', `/videos/${sp.id}/publish`, {});
  check('全部审校后发布 v1', r.status === 201 && r.json.publication.version === 1, JSON.stringify(r.json));
  const v1Srt = await (await fetch(`${BASE}/videos/${sp.id}/srt?version=1`)).text();
  check('v1 SRT 含 5 段时间戳', (v1Srt.match(/-->/g) || []).length === 5, v1Srt);

  // 发布后再拆分草稿中的 B（2000-3000）
  const Bcur = (await getSegs()).find((x) => x.id === B.id);
  r = await req('POST', `/videos/${sp.id}/segments/${B.id}/split`,
    { cut_ms: 2600, left_text: '邻接', right_text: '片段', revision: Bcur.revision });
  check('已发布后仍可拆分草稿', r.status === 201, JSON.stringify(r.json));
  const draftSrt = await (await fetch(`${BASE}/videos/${sp.id}/srt?version=draft`)).text();
  check('草稿 SRT 反映拆分结果',
    /00:00:02,000 --> 00:00:02,600/.test(draftSrt) && /00:00:02,600 --> 00:00:03,000/.test(draftSrt), draftSrt);
  const v1SrtAgain = await (await fetch(`${BASE}/videos/${sp.id}/srt?version=1`)).text();
  eq('历史发布 v1 的 SRT 不变', v1SrtAgain, v1Srt);
  const st = (await req('GET', `/videos/${sp.id}/status`)).json;
  check('拆分后发布门禁阻止发布', st.canPublish === false);
  check('pending 逐段列出左右两段',
    st.pending.some((p) => p.segment_id === B.id && p.reasons.includes('segment_unreviewed')) &&
    st.pending.some((p) => p.segment_id === r.json.right.id && p.reasons.includes('segment_unreviewed')),
    JSON.stringify(st.pending));

  console.log('36. 拆分与译文轨道：双段译文、复制禁止与双修订号');
  const tp = await uploadVideo('拆分译文', 10000, 48);
  await req('PUT', `/videos/${tp.id}/translation/track`, { language: 'en' });
  const getTp = async () => (await req('GET', `/videos/${tp.id}`)).json;
  const T1 = (await req('POST', `/videos/${tp.id}/segments`,
    { start_ms: 1000, end_ms: 3000, text: '长句子需要拆开' })).json.segment;

  // 启用轨道即须提交左右两段译文（即使该段尚无译文）
  r = await req('POST', `/videos/${tp.id}/segments/${T1.id}/split`,
    { cut_ms: 2000, left_text: '长句子', right_text: '需要拆开', revision: 1 });
  check('启用轨道缺译文 -> 422 missing_translation', r.status === 422 && r.json.error.code === 'missing_translation');
  r = await req('POST', `/videos/${tp.id}/segments/${T1.id}/split`,
    { cut_ms: 2000, left_text: '长句子', right_text: '需要拆开', revision: 1, left_translation: 'Long sentence', right_translation: ' ' });
  check('右段译文为空白 -> 422', r.status === 422 && r.json.error.code === 'missing_translation');
  // 无既有译文时拆分：两段译文新建（无需译文修订号）
  r = await req('POST', `/videos/${tp.id}/segments/${T1.id}/split`,
    { cut_ms: 2000, left_text: '长句子', right_text: '需要拆开', revision: 1,
      left_translation: 'Long sentence', right_translation: 'needs splitting' });
  check('无既有译文拆分成功 201', r.status === 201, JSON.stringify(r.json));
  let det = await getTp();
  eq('拆分后两段均有译文', det.translations.length, 2);
  const leftTr = det.translations.find((t) => t.segment_id === T1.id);
  eq('左段译文绑定左段原文且未失效待审',
    [leftTr.text, leftTr.stale, leftTr.reviewed, leftTr.revision], ['Long sentence', false, false, 1]);
  const rightTr = det.translations.find((t) => t.segment_id === r.json.right.id);
  eq('右段译文新建待审', [rightTr.text, rightTr.stale, rightTr.reviewed, rightTr.revision],
    ['needs splitting', false, false, 1]);

  // 已有译文时：须携带译文修订号；左右译文均不得复制原译文
  const L = T1.id; // 左段 1000-2000，译文 Long sentence（rev 1）
  r = await req('POST', `/videos/${tp.id}/segments/${L}/translation/review`,
    { reviewed: true, segment_revision: 2, revision: 1 });
  check('左段译文审校（译文 rev -> 2）', r.status === 200, JSON.stringify(r.json));
  r = await req('POST', `/videos/${tp.id}/segments/${L}/split`,
    { cut_ms: 1500, left_text: '长', right_text: '句子', revision: 2,
      left_translation: 'Long', right_translation: 'sentence' });
  check('缺译文修订号 -> 422 missing_revision', r.status === 422 && r.json.error.code === 'missing_revision');
  r = await req('POST', `/videos/${tp.id}/segments/${L}/split`,
    { cut_ms: 1500, left_text: '长', right_text: '句子', revision: 2,
      left_translation: 'Long', right_translation: 'sentence', translation_revision: 9 });
  check('译文修订号过期 -> 409 且返回当前译文', r.status === 409 &&
    r.json.error.current.translation.text === 'Long sentence', JSON.stringify(r.json));
  r = await req('POST', `/videos/${tp.id}/segments/${L}/split`,
    { cut_ms: 1500, left_text: '长', right_text: '句子', revision: 2,
      left_translation: 'Long sentence', right_translation: 'sentence', translation_revision: 2 });
  check('左译文复制原译文 -> 422 copied_translation', r.status === 422 && r.json.error.code === 'copied_translation');
  r = await req('POST', `/videos/${tp.id}/segments/${L}/split`,
    { cut_ms: 1500, left_text: '长', right_text: '句子', revision: 2,
      left_translation: 'Long', right_translation: 'Long sentence', translation_revision: 2 });
  check('右译文复制原译文 -> 422', r.status === 422 && r.json.error.code === 'copied_translation');
  det = await getTp();
  eq('失败尝试零写入（片段与译文均不变）',
    [det.segments.length, det.translations.length, det.translations.find((t) => t.segment_id === L).revision],
    [2, 2, 2]);

  // 携带双修订号拆分成功：原译文行保留给左段（修订号 +1、转待审、重新绑定不失效）
  r = await req('POST', `/videos/${tp.id}/segments/${L}/split`,
    { cut_ms: 1500, left_text: '长', right_text: '句子', revision: 2,
      left_translation: 'Long', right_translation: 'sentence', translation_revision: 2 });
  check('携带双修订号拆分成功', r.status === 201, JSON.stringify(r.json));
  det = await getTp();
  const newLeftTr = det.translations.find((t) => t.segment_id === L);
  eq('原译文行保留给左段：修订号 +1、待审、未失效',
    [newLeftTr.text, newLeftTr.revision, newLeftTr.reviewed, newLeftTr.stale], ['Long', 3, false, false]);
  const newRightTr = det.translations.find((t) => t.segment_id === r.json.right.id);
  eq('右段译文新建待审', [newRightTr.text, newRightTr.revision, newRightTr.reviewed, newRightTr.stale],
    ['sentence', 1, false, false]);

  // 双轨齐备发布 v1；随后拆分草稿，历史双轨快照与译文 SRT 不变
  det = await getTp();
  for (const s of det.segments) {
    await req('POST', `/videos/${tp.id}/segments/${s.id}/review`, { reviewed: true, revision: s.revision });
  }
  det = await getTp();
  for (const t of det.translations) {
    const segRev = det.segments.find((s) => s.id === t.segment_id).revision;
    await req('POST', `/videos/${tp.id}/segments/${t.segment_id}/translation/review`,
      { reviewed: true, segment_revision: segRev, revision: t.revision });
  }
  r = await req('POST', `/videos/${tp.id}/publish`, {});
  check('双轨齐备发布 v1', r.status === 201 && r.json.publication.has_translation === true, JSON.stringify(r.json));
  const v1TrSrt = await (await fetch(`${BASE}/videos/${tp.id}/srt/translation?version=1`)).text();
  check('v1 译文 SRT 含 3 段', (v1TrSrt.match(/-->/g) || []).length === 3, v1TrSrt);

  det = await getTp();
  const R2 = det.segments.find((s) => s.start_ms === 2000);
  const R2tr = det.translations.find((t) => t.segment_id === R2.id);
  r = await req('POST', `/videos/${tp.id}/segments/${R2.id}/split`,
    { cut_ms: 2500, left_text: '需要', right_text: '拆开', revision: R2.revision,
      left_translation: 'needs', right_translation: 'to split', translation_revision: R2tr.revision });
  check('发布后拆分草稿成功', r.status === 201, JSON.stringify(r.json));
  const v1TrSrtAgain = await (await fetch(`${BASE}/videos/${tp.id}/srt/translation?version=1`)).text();
  eq('历史发布 v1 译文 SRT 不变', v1TrSrtAgain, v1TrSrt);
  const draftTrSrt = await (await fetch(`${BASE}/videos/${tp.id}/srt/translation?version=draft`)).text();
  check('草稿译文 SRT 反映拆分（4 段且含切点）',
    (draftTrSrt.match(/-->/g) || []).length === 4 && /00:00:02,000 --> 00:00:02,500/.test(draftTrSrt), draftTrSrt);
  const st2 = (await req('GET', `/videos/${tp.id}/status`)).json;
  check('拆分后双轨门禁阻止发布', st2.canPublish === false &&
    st2.pending.some((p) => p.reasons.includes('translation_unreviewed')), JSON.stringify(st2.pending));

  console.log('37. 拆分与质检：放行失效保留历史、按新时长重新质检');
  const qp = await uploadVideo('拆分质检', 10000, 48);
  const Q1 = (await req('POST', `/videos/${qp.id}/segments`,
    { start_ms: 1000, end_ms: 2000, text: '一二三四五六七八九十' })).json.segment;
  await req('PUT', `/videos/${qp.id}/qc/rules`, { source_max_cps: 5, rules_revision: 0 });
  // 10 字 / 1 秒 = 10 cps > 5 -> 违规；填写理由放行
  r = await req('PUT', `/videos/${qp.id}/segments/${Q1.id}/qc/waiver`,
    { track: 'source', rule: 'max_cps', reason: '快语速已核对', segment_revision: 1 });
  check('拆分前放行成功', r.status === 201, JSON.stringify(r.json));
  let qc = (await req('GET', `/videos/${qp.id}/qc`)).json;
  eq('拆分前违规已放行', [qc.violation_count, qc.blocking_count, qc.active_waiver_count], [1, 0, 1]);

  // 拆分为两段各 5 字 / 0.5 秒 = 10 cps：按新时长重新质检仍违规，且既有放行失效
  r = await req('POST', `/videos/${qp.id}/segments/${Q1.id}/split`,
    { cut_ms: 1500, left_text: '一二三四五', right_text: '六七八九十', revision: 1 });
  check('拆分成功', r.status === 201, JSON.stringify(r.json));
  qc = (await req('GET', `/videos/${qp.id}/qc`)).json;
  eq('拆分后按新时长重新质检：两段均违规', qc.violation_count, 2);
  eq('两段违规均未放行', qc.blocking_count, 2);
  eq('既有放行已失效', qc.active_waiver_count, 0);
  check('失效放行历史理由保留可查',
    qc.waivers.some((w) => !w.active && w.reason === '快语速已核对' && w.revoked_at != null),
    JSON.stringify(qc.waivers));

  // 未放行违规阻止发布（审校两段后仍被质检拦截）
  await req('POST', `/videos/${qp.id}/segments/${Q1.id}/review`, { reviewed: true, revision: 2 });
  const qRight = (await req('GET', `/videos/${qp.id}`)).json.segments.find((x) => x.id !== Q1.id);
  await req('POST', `/videos/${qp.id}/segments/${qRight.id}/review`, { reviewed: true, revision: 1 });
  r = await req('POST', `/videos/${qp.id}/publish`, {});
  check('未放行违规阻止发布 -> 422 qc_blocked', r.status === 422 && r.json.error.code === 'qc_blocked',
    JSON.stringify(r.json));
}

// 38. 说话人名单：trim、去重、名单修订号与引用保护
async function speakerRosterTests() {
  console.log('38. 说话人名单：trim、去重、名单修订号乐观锁与删除引用保护');
  const v = await uploadVideo('说话人名单', 10000, 64);
  const A = (await req('POST', `/videos/${v.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '甲' })).json.segment;
  const B = (await req('POST', `/videos/${v.id}/segments`, { start_ms: 2000, end_ms: 3000, text: '乙' })).json.segment;

  // 初始详情携带空名单与修订号 0；全部片段未归属
  let d = (await req('GET', `/videos/${v.id}`)).json;
  eq('初始名单为空、修订号 0', [d.list_revision, d.speakers.length], [0, 0]);
  eq('初始全部片段未归属', d.unassigned_segment_ids.sort(), [A.id, B.id].sort());
  eq('片段携带 speaker 字段', [A.speaker_id, A.speaker_name], [null, null]);

  // 缺修订号 / 空名 / 纯空白
  let r = await req('POST', `/videos/${v.id}/speakers`, { name: '主持人' });
  check('缺名单修订号 -> 422', r.status === 422 && r.json.error.code === 'missing_revision', JSON.stringify(r.json));
  r = await req('POST', `/videos/${v.id}/speakers`, { name: '   ', list_revision: 0 });
  check('纯空白名称 -> 422', r.status === 422 && r.json.error.code === 'invalid_speaker_name');
  r = await req('POST', `/videos/${v.id}/speakers`, { name: 42, list_revision: 0 });
  check('非字符串名称 -> 422', r.status === 422 && r.json.error.code === 'invalid_speaker_name');

  // trim 后入库
  r = await req('POST', `/videos/${v.id}/speakers`, { name: '  主持人  ', list_revision: 0 });
  check('新增说话人 201，名称 trim', r.status === 201 && r.json.speaker.name === '主持人', JSON.stringify(r.json));
  const S1 = r.json.speaker.id;
  eq('名单修订号 -> 1', r.json.list_revision, 1);
  eq('usage_count 初始 0', r.json.speaker.usage_count, 0);

  // trim 后重复
  r = await req('POST', `/videos/${v.id}/speakers`, { name: '主持人', list_revision: 1 });
  check('trim 后重名 -> 422 duplicate_speaker',
    r.status === 422 && r.json.error.code === 'duplicate_speaker', JSON.stringify(r.json));

  // 过期名单修订号 -> 409 返回当前名单
  r = await req('POST', `/videos/${v.id}/speakers`, { name: '嘉宾', list_revision: 0 });
  check('过期名单修订号 -> 409 并返回当前名单',
    r.status === 409 && r.json.error.code === 'revision_conflict' &&
    r.json.error.list_revision === 1 && r.json.error.speakers[0].name === '主持人', JSON.stringify(r.json));

  r = await req('POST', `/videos/${v.id}/speakers`, { name: '嘉宾', list_revision: 1 });
  check('正确修订号新增第二位', r.status === 201);
  const S2 = r.json.speaker.id;
  eq('名单修订号 -> 2', r.json.list_revision, 2);

  // 改名：trim、去重（排除自己）、乐观锁
  r = await req('PUT', `/videos/${v.id}/speakers/${S2}`, { name: '  嘉宾A ', list_revision: 2 });
  check('改名成功并 trim', r.status === 200 && r.json.speaker.name === '嘉宾A' && r.json.list_revision === 3,
    JSON.stringify(r.json));
  r = await req('PUT', `/videos/${v.id}/speakers/${S2}`, { name: '主持人', list_revision: 3 });
  check('改成他人同名 -> 422', r.status === 422 && r.json.error.code === 'duplicate_speaker');
  r = await req('PUT', `/videos/${v.id}/speakers/${S2}`, { name: '主持人', list_revision: 0 });
  check('改名过期修订号 -> 409', r.status === 409 && r.json.error.code === 'revision_conflict');
  // 改成自己现名（trim 后）幂等不推进修订号
  r = await req('PUT', `/videos/${v.id}/speakers/${S2}`, { name: ' 嘉宾A ', list_revision: 3 });
  check('同名（仅空白差异）幂等，修订号不变', r.status === 200 && r.json.list_revision === 3);

  r = await req('PUT', `/videos/${v.id}/speakers/99999`, { name: 'X', list_revision: 3 });
  check('改名不存在的说话人 -> 404', r.status === 404 && r.json.error.code === 'speaker_not_found');

  // 无引用可删除；有引用保护
  r = await req('DELETE', `/videos/${v.id}/speakers/${S2}`, { list_revision: 3 });
  check('无引用说话人可删除，修订号 -> 4', r.status === 200 && r.json.list_revision === 4, JSON.stringify(r.json));

  // 把 A 归属给 S1 后再尝试删除 S1
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: S1, revision: 1 });
  check('归属成功', r.status === 200 && r.json.segment.speaker_id === S1);
  r = await req('DELETE', `/videos/${v.id}/speakers/${S1}`, { list_revision: 4 });
  check('被引用说话人删除 -> 422 speaker_in_use，返回引用清单',
    r.status === 422 && r.json.error.code === 'speaker_in_use' &&
    r.json.error.usage_count === 1 && r.json.error.referenced_by[0].id === A.id, JSON.stringify(r.json));

  // 置为未归属后可删除
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: null, revision: 2 });
  check('置为未归属成功', r.status === 200 && r.json.segment.speaker_id === null);
  r = await req('DELETE', `/videos/${v.id}/speakers/${S1}`, { list_revision: 4 });
  check('解除引用后可删除', r.status === 200 && r.json.speakers.length === 0 && r.json.list_revision === 5,
    JSON.stringify(r.json));

  d = (await req('GET', `/videos/${v.id}/speakers`)).json;
  check('名单 GET：无说话人时未归属清单不用于门禁（仅展示）',
    d.list_revision === 5 && d.speakers.length === 0 && d.unassigned_segment_ids.length === 2, JSON.stringify(d));
}

// 39. 片段归属：片段修订号、转待审、文字时间不变、译文不失效
async function speakerAssignTests() {
  console.log('39. 片段归属：片段修订号、转待审、原文/译文不变量');
  const v = await uploadVideo('片段归属', 10000, 64);
  // 启用译文轨道
  await req('PUT', `/videos/${v.id}/translation/track`, { language: 'en' });
  const A = (await req('POST', `/videos/${v.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '原文甲' })).json.segment;
  const S1 = (await req('POST', `/videos/${v.id}/speakers`, { name: '甲', list_revision: 0 })).json.speaker.id;

  // 参数校验
  let r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: S1 });
  check('归属缺片段修订号 -> 422', r.status === 422);
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { revision: 1 });
  check('归属缺 speaker_id -> 422 missing_speaker',
    r.status === 422 && r.json.error.code === 'missing_speaker', JSON.stringify(r.json));
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: 'x', revision: 1 });
  check('speaker_id 非法 -> 422', r.status === 422 && r.json.error.code === 'invalid_speaker');
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: 99999, revision: 1 });
  check('归属到不存在的说话人 -> 422 speaker_not_found',
    r.status === 422 && r.json.error.code === 'speaker_not_found', JSON.stringify(r.json));

  // 先录译文并审校原文+译文
  await req('PUT', `/videos/${v.id}/segments/${A.id}/translation`, { text: 'Source A', segment_revision: 1 });
  await req('POST', `/videos/${v.id}/segments/${A.id}/review`, { reviewed: true, revision: 1 });
  await req('POST', `/videos/${v.id}/segments/${A.id}/translation/review`,
    { reviewed: true, segment_revision: 2, revision: 1 });

  // 归属：片段 rev 2 -> 3、转待审；原文文字时间不变、译文不失效、译文审校保留
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: S1, revision: 2 });
  check('归属成功：修订号 +1、转待审、文字时间不变',
    r.status === 200 && r.json.segment.revision === 3 && r.json.segment.reviewed === false &&
    r.json.segment.text === '原文甲' && r.json.segment.start_ms === 1000 && r.json.segment.end_ms === 2000,
    JSON.stringify(r.json.segment));
  check('归属后返回当前说话人名', r.json.segment.speaker_name === '甲');
  let d = (await req('GET', `/videos/${v.id}`)).json;
  const tr = d.translations[0];
  check('译文不因归属变化而失效', tr.stale === false, JSON.stringify(tr));
  eq('译文审校状态保留', tr.reviewed, true);
  eq('译文绑定的原文文字时间不变', [tr.source_text, tr.source_start_ms, tr.source_end_ms], ['原文甲', 1000, 2000]);

  // 过期片段修订号归属 -> 409 且带当前片段与名单
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: null, revision: 2 });
  check('归属过期修订号 -> 409 且 current 为当前片段',
    r.status === 409 && r.json.error.code === 'revision_conflict' &&
    r.json.error.current.segment.revision === 3 && Array.isArray(r.json.error.speakers), JSON.stringify(r.json));

  // 相同归属（idempotent）：changed=false、修订号不再增加
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: S1, revision: 3 });
  check('相同归属无变化：changed=false、修订号不增',
    r.status === 200 && r.json.changed === false && r.json.segment.revision === 3, JSON.stringify(r.json));

  // 置为未归属：rev 3 -> 4、转待审
  r = await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: null, revision: 3 });
  check('置未归属成功', r.status === 200 && r.json.segment.speaker_id === null && r.json.segment.revision === 4);
  d = (await req('GET', `/videos/${v.id}`)).json;
  check('译文在置未归属后仍不失效', d.translations[0].stale === false);
}

// 40. 发布门禁与快照固定：未归属阻止发布；改名/改草稿不影响历史
async function speakerPublishTests() {
  console.log('40. 说话人：未归属阻止发布并给清单；发布固定名称与归属，历史不可变');
  const v = await uploadVideo('说话人发布', 10000, 64);
  const A = (await req('POST', `/videos/${v.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '一' })).json.segment;
  const B = (await req('POST', `/videos/${v.id}/segments`, { start_ms: 2000, end_ms: 3000, text: '二' })).json.segment;

  // 无说话人时门禁不受影响：审校后可发布（向后兼容）
  await req('POST', `/videos/${v.id}/segments/${A.id}/review`, { reviewed: true, revision: 1 });
  await req('POST', `/videos/${v.id}/segments/${B.id}/review`, { reviewed: true, revision: 1 });
  let st = (await req('GET', `/videos/${v.id}/status`)).json;
  check('无说话人：status.speakers.enabled=false', st.speakers.enabled === false && st.canPublish === true,
    JSON.stringify(st.speakers));
  let r = await req('POST', `/videos/${v.id}/publish`, {});
  check('无说话人时照常发布 v1', r.status === 201 && r.json.publication.version === 1, JSON.stringify(r.json));
  check('旧形态发布 has_speakers=false', r.json.publication.has_speakers === false);
  // 旧版本无说话人快照
  r = await req('GET', `/videos/${v.id}/publications/1/speakers`);
  check('旧版本说话人快照 -> 422 speakers_unavailable',
    r.status === 422 && r.json.error.code === 'speakers_unavailable', JSON.stringify(r.json));
  // 旧 SRT 导出语义不变
  const oldSrt = await (await fetch(`${BASE}/videos/${v.id}/srt?version=1`)).text();
  check('旧版本 SRT 导出不变', /一/.test(oldSrt) && /二/.test(oldSrt));
  let d;

  // 建名单 -> 已审片段未归属，门禁被阻止
  const S1 = (await req('POST', `/videos/${v.id}/speakers`, { name: '主持', list_revision: 0 })).json.speaker.id;
  st = (await req('GET', `/videos/${v.id}/status`)).json;
  check('有说话人后未归属：canPublish=false、汇总计数',
    st.canPublish === false && st.speakers.enabled && st.speakers.unassigned === 2 && st.speakers.assigned === 0,
    JSON.stringify(st.speakers));
  check('pending 逐段给 speaker_unassigned',
    st.pending.length === 2 && st.pending.every((p) => p.reasons.includes('speaker_unassigned')),
    JSON.stringify(st.pending));
  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('未归属阻止发布 -> 422 not_publishable 且清单含 speaker_unassigned',
    r.status === 422 && r.json.error.code === 'not_publishable' &&
    r.json.error.speakers.unassigned === 2 &&
    r.json.error.pending.every((p) => p.reasons.includes('speaker_unassigned')), JSON.stringify(r.json));

  // 归属后片段转待审：需重新审校；归属不改变原文文字
  await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: S1, revision: 2 });
  await req('PUT', `/videos/${v.id}/segments/${B.id}/speaker`, { speaker_id: S1, revision: 2 });
  // 再建第二个说话人，把 B 归属过去（验证快照逐段归属）
  const S2 = (await req('POST', `/videos/${v.id}/speakers`, { name: '嘉宾', list_revision: 1 })).json.speaker.id;
  await req('PUT', `/videos/${v.id}/segments/${B.id}/speaker`, { speaker_id: S2, revision: 3 });
  // A: rev2->3（归属）-> 重新审校 rev4；B: rev2->3->4（两次归属）-> 重新审校 rev5
  await req('POST', `/videos/${v.id}/segments/${A.id}/review`, { reviewed: true, revision: 3 });
  await req('POST', `/videos/${v.id}/segments/${B.id}/review`, { reviewed: true, revision: 4 });

  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('全部归属且已审 -> 发布 v2', r.status === 201 && r.json.publication.version === 2, JSON.stringify(r.json));
  check('v2 has_speakers=true', r.json.publication.has_speakers === true);
  const snap = (await req('GET', `/videos/${v.id}/publications/2/speakers`)).json;
  eq('快照固定名单名称', snap.speakers.map((x) => x.name).sort(), ['主持', '嘉宾']);
  const byId = Object.fromEntries(snap.assignments.map((a) => [a.segment_id, a.speaker_id]));
  eq('快照固定逐段归属', [byId[A.id], byId[B.id]], [S1, S2]);
  eq('快照记录当时名单修订号', snap.list_revision, 2);

  // 发布后改名：草稿立即用新名，v2 快照不变
  r = await req('PUT', `/videos/${v.id}/speakers/${S2}`, { name: '嘉宾（改）', list_revision: 2 });
  check('发布后改名成功', r.status === 200);
  const snap2 = (await req('GET', `/videos/${v.id}/publications/2/speakers`)).json;
  check('历史快照名称不随后续改名变化',
    snap2.speakers.find((x) => x.id === S2).name === '嘉宾', JSON.stringify(snap2.speakers));
  d = (await req('GET', `/videos/${v.id}`)).json;
  check('草稿片段立即显示新名',
    d.segments.find((x) => x.id === B.id).speaker_name === '嘉宾（改）');

  // 发布后改草稿归属：v2 快照归属不变
  await req('PUT', `/videos/${v.id}/segments/${B.id}/speaker`, { speaker_id: null, revision: 5 });  const snap3 = (await req('GET', `/videos/${v.id}/publications/2/speakers`)).json;
  const byId3 = Object.fromEntries(snap3.assignments.map((a) => [a.segment_id, a.speaker_id]));
  eq('历史快照归属不随后续改草稿变化', byId3[B.id], S2);
}

// 41. 拆分 / SRT 导入 / 区间恢复产生的新片段归属规则
async function speakerNewSegmentTests() {
  console.log('41. 说话人：拆分沿用原归属；SRT 导入与区间恢复新片段未归属');

  // 拆分：左右两段沿用原归属
  const v = await uploadVideo('说话人拆分', 10000, 64);
  const A = (await req('POST', `/videos/${v.id}/segments`, { start_ms: 1000, end_ms: 3000, text: '一句长话' })).json.segment;
  const S1 = (await req('POST', `/videos/${v.id}/speakers`, { name: '主持', list_revision: 0 })).json.speaker.id;
  await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: S1, revision: 1 });
  let r = await req('POST', `/videos/${v.id}/segments/${A.id}/split`,
    { cut_ms: 2000, left_text: '前半', right_text: '后半', revision: 2 });
  check('已归属片段拆分成功', r.status === 201, JSON.stringify(r.json));
  eq('左段沿用原归属', [r.json.left.speaker_id, r.json.left.speaker_name], [S1, '主持']);
  eq('右段沿用原归属', [r.json.right.speaker_id, r.json.right.speaker_name], [S1, '主持']);

  // 未归属片段拆分：两段都未归属
  const v2 = await uploadVideo('说话人拆分2', 10000, 64);
  const C = (await req('POST', `/videos/${v2.id}/segments`, { start_ms: 1000, end_ms: 3000, text: '无主长话' })).json.segment;
  await req('POST', `/videos/${v2.id}/speakers`, { name: '某', list_revision: 0 });
  r = await req('POST', `/videos/${v2.id}/segments/${C.id}/split`,
    { cut_ms: 2000, left_text: '前', right_text: '后', revision: 1 });
  check('未归属片段拆分成功', r.status === 201);
  eq('左段未归属', r.json.left.speaker_id, null);
  eq('右段未归属', r.json.right.speaker_id, null);

  // SRT 导入（替换）：新片段未归属
  const v3 = await uploadVideo('说话人导入', 10000, 64);
  const S3 = (await req('POST', `/videos/${v3.id}/speakers`, { name: '导入者', list_revision: 0 })).json.speaker.id;
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n导入甲\n\n2\n00:00:02,000 --> 00:00:03,000\n导入乙\n';
  let pv = await req('POST', `/videos/${v3.id}/srt/preview`, { content: srt });
  r = await req('POST', `/videos/${v3.id}/srt/import`, { content: srt, mode: 'replace', token: pv.json.token });
  check('SRT 替换导入成功', r.status === 201, JSON.stringify(r.json));
  check('导入新片段全部未归属', r.json.segments.every((s) => s.speaker_id === null),
    JSON.stringify(r.json.segments.map((s) => s.speaker_id)));
  // 未归属阻止发布
  r = await req('POST', `/videos/${v3.id}/publish`, {});
  check('导入未归属片段阻止发布', r.status === 422 && r.json.error.speakers.unassigned === 2,
    JSON.stringify(r.json.error));

  // 区间恢复：恢复片段为新片段、未归属；区间外片段归属不变
  // 先给 v3 草稿全部归属并审校，发布 v1
  for (const s of r === null ? [] : []) { /* noop */ }
  let det = (await req('GET', `/videos/${v3.id}`)).json;
  for (const s of det.segments) {
    await req('PUT', `/videos/${v3.id}/segments/${s.id}/speaker`, { speaker_id: S3, revision: s.revision });
  }
  det = (await req('GET', `/videos/${v3.id}`)).json;
  for (const s of det.segments) {
    await req('POST', `/videos/${v3.id}/segments/${s.id}/review`, { reviewed: true, revision: s.revision });
  }
  const pub = await req('POST', `/videos/${v3.id}/publish`, {});
  check('归属齐备发布 v1', pub.status === 201, JSON.stringify(pub.json));
  // 用 replace 导入不同文本的草稿（制造可恢复差异），再恢复整区间
  const srt2 = '1\n00:00:01,000 --> 00:00:02,000\n草稿甲改\n\n2\n00:00:02,000 --> 00:00:03,000\n草稿乙改\n';
  pv = await req('POST', `/videos/${v3.id}/srt/preview`, { content: srt2 });
  await req('POST', `/videos/${v3.id}/srt/import`, { content: srt2, mode: 'replace', token: pv.json.token });
  // 恢复区间边界必须落在间隙：恢复 0-10000 覆盖全部（端点在片段间隙 0 / 10000 之外需注意；
  // 这里恢复 [0,3000]，0 在第一段起点、3000 在第二段终点，均不穿过片段）
  pv = await req('POST', `/videos/${v3.id}/restore/preview`,
    { version: 1, start_ms: 0, end_ms: 3000 });
  check('恢复预览成功', pv.status === 200, JSON.stringify(pv.json));
  r = await req('POST', `/videos/${v3.id}/restore/confirm`,
    { version: 1, start_ms: 0, end_ms: 3000, token: pv.json.token });
  check('区间恢复确认成功', r.status === 201, JSON.stringify(r.json));
  check('恢复片段作为新片段未归属', r.json.restored.every((s) => s.speaker_id === null),
    JSON.stringify(r.json.restored.map((s) => s.speaker_id)));
  check('恢复片段修订号从 1 开始且待审',
    r.json.restored.every((s) => s.revision === 1 && s.reviewed === false));
}

// 42. 说话人与译文轨道/SRT 导出共存：归属不影响译文 SRT；双轨发布快照完整
async function speakerTranslationTests() {
  console.log('42. 说话人 × 译文轨道：归属不使译文失效；双轨+说话人发布与导出');
  const v = await uploadVideo('说话人译文', 10000, 64);
  await req('PUT', `/videos/${v.id}/translation/track`, { language: 'en' });
  const A = (await req('POST', `/videos/${v.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '原文' })).json.segment;
  const S1 = (await req('POST', `/videos/${v.id}/speakers`, { name: 'Hoster', list_revision: 0 })).json.speaker.id;
  await req('PUT', `/videos/${v.id}/segments/${A.id}/translation`, { text: 'Source', segment_revision: 1 });
  await req('PUT', `/videos/${v.id}/segments/${A.id}/speaker`, { speaker_id: S1, revision: 1 });
  // 归属后原文 rev 2：译文仍可审校（未失效）
  let r = await req('POST', `/videos/${v.id}/segments/${A.id}/translation/review`,
    { reviewed: true, segment_revision: 2, revision: 1 });
  check('归属后译文未失效、可审校', r.status === 200, JSON.stringify(r.json));
  await req('POST', `/videos/${v.id}/segments/${A.id}/review`, { reviewed: true, revision: 2 });
  // 草稿译文 SRT 在归属变化后仍可导出（译文齐备未失效）
  const trSrt = await (await fetch(`${BASE}/videos/${v.id}/srt/translation?version=draft`)).text();
  check('归属不影响草稿译文 SRT 导出', /Source/.test(trSrt), trSrt);

  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('双轨 + 说话人齐备发布成功', r.status === 201 &&
    r.json.publication.has_translation && r.json.publication.has_speakers, JSON.stringify(r.json));
  const ver = r.json.publication.version;
  // 历史原文/译文 SRT 语义不变（不含说话人）
  const pubSrt = await (await fetch(`${BASE}/videos/${v.id}/srt?version=${ver}`)).text();
  const pubTrSrt = await (await fetch(`${BASE}/videos/${v.id}/srt/translation?version=${ver}`)).text();
  check('历史原文 SRT 仍只有时间与文本', /原文/.test(pubSrt) && !/Hoster/.test(pubSrt));
  check('历史译文 SRT 仍只有时间与译文', /Source/.test(pubTrSrt) && !/Hoster/.test(pubTrSrt));
}

// 43. 说话人视频级隔离：同名允许跨视频；删除视频级联清理
async function speakerIsolationTests() {
  console.log('43. 说话人：跨视频同名允许、视频隔离与级联删除');
  const v1 = await uploadVideo('说话人隔离1', 10000, 64);
  const v2 = await uploadVideo('说话人隔离2', 10000, 64);
  const r1 = await req('POST', `/videos/${v1.id}/speakers`, { name: '同名', list_revision: 0 });
  const r2 = await req('POST', `/videos/${v2.id}/speakers`, { name: '同名', list_revision: 0 });
  check('跨视频允许同名说话人', r1.status === 201 && r2.status === 201, JSON.stringify(r2.json));
  // v2 的归属不能引用 v1 的说话人 id
  const A2 = (await req('POST', `/videos/${v2.id}/segments`, { start_ms: 1000, end_ms: 2000, text: 'x' })).json.segment;
  const r = await req('PUT', `/videos/${v2.id}/segments/${A2.id}/speaker`,
    { speaker_id: r1.json.speaker.id, revision: 1 });
  check('不能归属到其他视频的说话人 -> 422', r.status === 422 && r.json.error.code === 'speaker_not_found',
    JSON.stringify(r.json));
  // 删除视频：级联删除名单（外键级联），不影响另一视频
  const dr = await req('DELETE', `/videos/${v1.id}`);
  check('删除视频 204', dr.status === 204);
  const d2 = (await req('GET', `/videos/${v2.id}`)).json;
  check('另一视频名单不受影响', d2.speakers.length === 1 && d2.speakers[0].name === '同名',
    JSON.stringify(d2.speakers));
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(tmpDir, 'test.db'),
    UPLOAD_DIR: path.join(tmpDir, 'videos'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}/videos`);
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器启动超时：\n' + serverOut);
}

waitForServer()
  .then(main)
  .then(() => { server.kill(); fs.rmSync(tmpDir, { recursive: true, force: true }); })
  .catch((e) => {
    console.error('测试运行失败:', e);
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
