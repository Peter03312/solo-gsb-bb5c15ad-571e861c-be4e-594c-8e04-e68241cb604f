'use strict';

/* ================= 全局状态 ================= */
const state = {
  view: 'list',
  videos: [],
  video: null,
  segments: [],
  publications: [],
  translationLang: null, // 译文轨道语言（未启用为 null）
  translations: [],      // 当前草稿全部译文（逐段关联）
  qcRules: null,         // 质检阈值（含 revision）
  qcReport: null,        // 当前草稿完整质检报告
  speakers: [],          // 说话人名单（含 usage_count）
  listRevision: 0,       // 所见名单修订号
  unassignedIds: [],     // 未归属片段 ID 清单
  activeSegmentId: null,
  editor: null, // { mode:'create'|'edit', segmentId, revision, initialText, dirty }
  shiftSelected: new Set(), // 整体平移勾选的片段 ID
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);
const app = $('app');

/* ================= 工具 ================= */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function fmtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}
function fmtTimeShort(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return (h ? `${h}:` : '') + `${pad(m)}:${pad(s)}`;
}

async function api(url, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data && data.error;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function currentVideoEl() { return $('videoPlayer'); }
function currentMs() {
  const v = currentVideoEl();
  return v ? Math.floor(v.currentTime * 1000) : 0;
}

/* ================= 视图：视频列表 / 上传 ================= */
async function loadList() {
  const data = await api('/api/videos');
  state.videos = data.videos;
  state.view = 'list';
  stopPolling();
  render();
}

function renderList() {
  app.innerHTML = `
    <section class="card">
      <h2>上传新视频</h2>
      <div class="upload-row">
        <label>标题
          <input type="text" id="upTitle" placeholder="例如：产品发布会完整版" />
        </label>
        <label>视频文件（浏览器会读取时长并随上传提交）
          <input type="file" id="upFile" accept="video/*" />
        </label>
        <button class="btn primary" id="upBtn">上传</button>
      </div>
      <p id="uploadMsg"></p>
    </section>

    <section class="card">
      <h2>视频列表（${state.videos.length}）</h2>
      <div class="video-list" id="videoList"></div>
    </section>`;

  $('upFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('upTitle').value ||= file.name.replace(/\.[^.]+$/, '');
    $('uploadMsg').textContent = `已选择 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB），点击上传后由浏览器读取时长…`;
  });

  $('upBtn').addEventListener('click', uploadVideo);

  const list = $('videoList');
  if (!state.videos.length) {
    list.innerHTML = '<p class="meta">暂无视频，先上传一个吧。</p>';
    return;
  }
  list.innerHTML = state.videos.map((v) => {
    const allReviewed = v.segment_count > 0 && v.segment_count === v.reviewed_count;
    const reviewBadge = v.segment_count === 0
      ? '<span class="badge warn">无字幕</span>'
      : allReviewed
        ? '<span class="badge ok">全部已审</span>'
        : `<span class="badge warn">已审 ${v.reviewed_count}/${v.segment_count}</span>`;
    return `
      <div class="video-item" data-id="${v.id}">
        <div class="name">${esc(v.title)}</div>
        <div class="stats">
          <span>时长 ${fmtTime(v.duration_ms)}</span>
          <span>${v.segment_count} 段</span>
          ${reviewBadge}
          ${v.translation_lang ? `<span class="badge ok">译文 ${esc(v.translation_lang)}</span>` : ''}
          ${v.latest_version ? `<span class="badge ok">已发布 v${v.latest_version}</span>` : ''}
        </div>
        <div class="meta" style="margin-top:6px">${esc(v.original_name)}</div>
      </div>`;
  }).join('');
  list.querySelectorAll('.video-item').forEach((el) =>
    el.addEventListener('click', () => openVideo(Number(el.dataset.id)))
  );
}

function readVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.src = url;
    probe.addEventListener('loadedmetadata', () => {
      const ms = Math.round(probe.duration * 1000);
      URL.revokeObjectURL(url);
      if (!Number.isFinite(ms) || ms <= 0) reject(new Error('无法读取该视频的时长，请换用 MP4/WebM 等浏览器可识别的格式'));
      else resolve(ms);
    });
    probe.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      reject(new Error('浏览器无法解析该视频文件，请换用 MP4/WebM 格式'));
    });
  });
}

async function uploadVideo() {
  const title = $('upTitle').value.trim();
  const file = $('upFile').files[0];
  const msg = $('uploadMsg');
  if (!title) { msg.textContent = '请先填写标题'; return; }
  if (!file) { msg.textContent = '请选择视频文件'; return; }
  msg.textContent = '正在读取视频时长…';
  let durationMs;
  try {
    durationMs = await readVideoDuration(file);
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  msg.textContent = `时长 ${fmtTime(durationMs)}，正在上传…`;
  const fd = new FormData();
  fd.append('title', title);
  fd.append('duration_ms', String(durationMs));
  fd.append('video', file);
  try {
    await api('/api/videos', { method: 'POST', body: fd });
    toast('上传成功');
    await loadList();
  } catch (e) {
    msg.textContent = `上传失败：${e.message}`;
  }
}

/* ================= 视图：校对工作台 ================= */
async function loadQcReport() {
  const data = await api(`/api/videos/${state.video.id}/qc`);
  state.qcReport = data;
  return data;
}

async function openVideo(id) {
  const data = await api(`/api/videos/${id}`);
  state.view = 'detail';
  state.video = data.video;
  state.segments = data.segments;
  state.publications = data.publications;
  state.translationLang = data.translation_lang != null ? data.translation_lang : null;
  state.translations = data.translations || [];
  state.qcRules = data.qc_rules || null;
  state.qcReport = null;
  state.speakers = data.speakers || [];
  state.listRevision = data.list_revision || 0;
  state.unassignedIds = data.unassigned_segment_ids || [];
  state.activeSegmentId = null;
  state.shiftSelected = new Set();
  render();
  startPolling();
  loadQcReport().then(() => renderQcPanel()).catch(() => {});
}

function backToList() { stopPolling(); loadList(); }

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollRefresh, 5000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}
function anyModalOpen() {
  return !$('editorModal').classList.contains('hidden') ||
         !$('conflictModal').classList.contains('hidden') ||
         !$('splitModal').classList.contains('hidden') ||
         !$('importModal').classList.contains('hidden') ||
         !$('restoreModal').classList.contains('hidden') ||
         !$('shiftModal').classList.contains('hidden') ||
         !$('trModal').classList.contains('hidden') ||
         !$('qcWaiverModal').classList.contains('hidden') ||
         !$('qcPubModal').classList.contains('hidden');
}
async function pollRefresh() {
  if (anyModalOpen() || !state.video) return;
  if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  try {
    const data = await api(`/api/videos/${state.video.id}`);
    const changed =
      JSON.stringify(data.segments.map(stripSeg)) !== JSON.stringify(state.segments.map(stripSeg)) ||
      JSON.stringify((data.translations || []).map(stripTr)) !== JSON.stringify(state.translations.map(stripTr)) ||
      (data.translation_lang != null ? data.translation_lang : null) !== state.translationLang ||
      JSON.stringify((data.speakers || []).map((sp) => [sp.id, sp.name, sp.usage_count]))
        !== JSON.stringify(state.speakers.map((sp) => [sp.id, sp.name, sp.usage_count])) ||
      (data.list_revision || 0) !== state.listRevision;
    state.segments = data.segments;
    state.translations = data.translations || [];
    state.translationLang = data.translation_lang != null ? data.translation_lang : null;
    state.speakers = data.speakers || [];
    state.listRevision = data.list_revision || 0;
    state.unassignedIds = data.unassigned_segment_ids || [];
    state.publications = data.publications;
    state.qcRules = data.qc_rules || null;
    syncShiftSelected();
    if (changed) {
      renderSegmentDependent();
      toast('检测到他人的修改，已刷新片段列表');
    }
    loadQcReport().then(() => {
      // 正在质检卡片内编辑阈值（焦点位于卡片输入框）时不重绘，避免冲掉未保存的输入
      const ae = document.activeElement;
      const inQcCard = ae && $('qcCard') && $('qcCard').contains(ae);
      if (!anyModalOpen() && !inQcCard) renderQcPanel();
    }).catch(() => {});
  } catch (_) { /* 忽略轮询错误 */ }
}
function stripSeg(s) {
  return [s.id, s.start_ms, s.end_ms, s.text, s.reviewed, s.revision, s.speaker_id];
}
function stripTr(t) {
  return [t.segment_id, t.text, t.reviewed, t.revision, t.stale];
}
function trOf(segmentId) {
  return state.translations.find((t) => t.segment_id === segmentId);
}

// 草稿刷新（轮询/写操作/409 回灌）后，剔除已不存在的勾选片段
function syncShiftSelected() {
  const ids = new Set(state.segments.map((s) => s.id));
  for (const id of [...state.shiftSelected]) {
    if (!ids.has(id)) state.shiftSelected.delete(id);
  }
}

function render() {
  if (state.view === 'list') { renderList(); return; }
  renderDetail();
}

function renderDetail() {
  const v = state.video;
  const allReviewed = state.segments.length > 0 && state.segments.every((s) => s.reviewed);
  app.innerHTML = `
    <span class="back-link" id="backLink">← 返回视频列表</span>

    <div class="workbench-grid">
      <div>
        <section class="card">
          <h2>${esc(v.title)} <span class="meta">时长 ${fmtTime(v.duration_ms)} ｜ 共 ${state.segments.length} 段
            ${allReviewed ? '｜<span style="color:var(--ok)">全部已审</span>' : ''}
            ${state.translationLang ? `｜译文轨道 <b>${esc(state.translationLang)}</b>` : ''}</span></h2>
          <video id="videoPlayer" controls preload="metadata" src="/api/videos/${v.id}/media"></video>
          <div class="subtitle-overlay" id="subtitleOverlay">— 播放时此处显示当前字幕 —</div>
          <div id="timelineContainer"></div>
        </section>

        <section class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2 style="margin:0">片段列表</h2>
            <div class="row-actions">
              <button class="btn small" id="shiftBtn">⇄ 整体平移…</button>
              <button class="btn small" id="restoreRangeBtn">↩ 区间恢复…</button>
              <button class="btn small" id="importSrtBtn">⬆ 导入 SRT…</button>
              <button class="btn primary small" id="addBtn">＋ 新增片段</button>
            </div>
          </div>
          <p class="meta">所有写操作都会携带你当前看到的修订号；修订号过期时服务端拒绝并返回冲突，绝不覆盖他人修改。${state.translationLang ? '原文文字或时间被修改后，对应译文会标记为「已失效」，需重新校对。' : ''}</p>
          <div class="side-scroll">
            <table class="seg-table">
              <thead><tr><th>#</th><th>时间</th><th>文本</th>${state.translationLang ? '<th>译文</th>' : ''}<th>状态</th><th>操作</th></tr></thead>
              <tbody id="segTbody"></tbody>
            </table>
          </div>
        </section>
      </div>

      <div>
        <section class="card" id="speakersCard"></section>
        <section class="card" id="qcCard"></section>
        <section class="card" id="publishCard"></section>
      </div>
    </div>`;

  $('backLink').addEventListener('click', backToList);
  $('addBtn').addEventListener('click', () => openEditor('create'));
  $('importSrtBtn').addEventListener('click', openImportModal);
  $('restoreRangeBtn').addEventListener('click', openRestoreModal);
  $('shiftBtn').addEventListener('click', openShiftModal);
  const videoEl = $('videoPlayer');
  videoEl.addEventListener('timeupdate', onTimeUpdate);

  renderTimeline();
  renderSegmentTable();
  renderSpeakerCard();
  renderPublishCard();
  renderQcPanel();
}

// 仅刷新依赖片段数据的区域（轮询/写操作后），不重建 <video>
function renderSegmentDependent() {
  if (state.view !== 'detail') return;
  renderTimeline();
  renderSegmentTable();
  renderSpeakerCard();
  renderPublishCard();
  renderQcPanel();
  onTimeUpdate();
}

/* ---------- 时间轴 ---------- */
function renderTimeline() {
  const c = $('timelineContainer');
  if (!c) return;
  const duration = state.video.duration_ms;
  const pct = (ms) => `${Math.min(100, Math.max(0, (ms / duration) * 100))}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    `<span style="left:${f * 100}%">${fmtTimeShort(f * duration)}</span>`).join('');

  c.innerHTML = `
    <div class="timeline-wrap">
      <div class="timeline-ruler">${ticks}</div>
      <div class="timeline" id="timeline">
        <div class="track" id="track">
          ${state.segments.map((s) => `
            <div class="seg-block ${s.reviewed ? 'reviewed' : 'draft'} ${state.activeSegmentId === s.id ? 'active' : ''}"
                 data-id="${s.id}" title="#${s.id} ${fmtTime(s.start_ms)} → ${fmtTime(s.end_ms)}&#10;${esc(s.text)}"
                 style="left:${pct(s.start_ms)};width:calc(${pct(s.end_ms - s.start_ms)} - 2px);">
              <div class="seg-label">${esc(s.text) || '(空文本)'}</div>
            </div>`).join('')}
        </div>
        <div class="playhead" id="playhead" style="left:0%"></div>
      </div>
    </div>`;

  const timeline = $('timeline');
  timeline.addEventListener('click', (e) => {
    const rect = timeline.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const videoEl = currentVideoEl();
    if (videoEl) videoEl.currentTime = (ratio * state.video.duration_ms) / 1000;
  });
  c.querySelectorAll('.seg-block').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const seg = state.segments.find((s) => s.id === Number(el.dataset.id));
      if (!seg) return;
      state.activeSegmentId = seg.id;
      currentVideoEl().currentTime = seg.start_ms / 1000;
      renderSegmentDependent();
    });
  });
}

function onTimeUpdate() {
  const videoEl = currentVideoEl();
  const playhead = $('playhead');
  const overlay = $('subtitleOverlay');
  if (!videoEl || !playhead) return;
  const ms = videoEl.currentTime * 1000;
  playhead.style.left = `${Math.min(100, (ms / state.video.duration_ms) * 100)}%`;
  const seg = state.segments.find((s) => ms >= s.start_ms && ms < s.end_ms);
  if (overlay) overlay.textContent = seg ? seg.text : '';
  if (seg && seg.id !== state.activeSegmentId) {
    state.activeSegmentId = seg.id;
    document.querySelectorAll('.seg-block').forEach((el) =>
      el.classList.toggle('active', Number(el.dataset.id) === seg.id));
    document.querySelectorAll('#segTbody tr').forEach((tr) =>
      tr.classList.toggle('active', Number(tr.dataset.id) === seg.id));
  }
}

/* ---------- 片段表 ---------- */
function trStatusTag(tr) {
  if (!tr) return '<span class="tag warn">未译</span>';
  if (tr.stale) return '<span class="tag bad">已失效</span>';
  return tr.reviewed ? '<span class="tag ok">译文已审</span>' : '<span class="tag warn">译文待审</span>';
}

function renderSegmentTable() {
  const tbody = $('segTbody');
  if (!tbody) return;
  const track = !!state.translationLang;
  const hasSpeakers = state.speakers.length > 0;
  const colCount = (track ? 6 : 5) + (hasSpeakers ? 1 : 0) + 1;
  if (!state.segments.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="meta">还没有片段，点击右上角「新增片段」。</td></tr>`;
    return;
  }
  const allChecked = state.segments.every((s) => state.shiftSelected.has(s.id));
  const someChecked = !allChecked && state.shiftSelected.size > 0;
  tbody.parentElement.querySelector('thead tr').innerHTML =
    `<th class="shift-col"><input type="checkbox" id="shiftSelectAll" ${allChecked ? 'checked' : ''} ` +
    `${someChecked ? 'data-indeterminate="1"' : ''} title="全选/取消全选（用于整体平移）" /></th>` +
    `<th>#</th><th>时间</th><th>文本</th>${track ? '<th>译文</th>' : ''}` +
    `${hasSpeakers ? '<th>说话人</th>' : ''}<th>状态</th><th>操作</th>`;
  const selectAll = $('shiftSelectAll');
  if (selectAll && someChecked) selectAll.indeterminate = true;
  if (selectAll) {
    selectAll.addEventListener('click', () => {
      if (state.shiftSelected.size === state.segments.length) state.shiftSelected.clear();
      else state.segments.forEach((s) => state.shiftSelected.add(s.id));
      renderSegmentTable();
    });
  }
  tbody.innerHTML = state.segments.map((s) => {
    const checked = state.shiftSelected.has(s.id);
    const tr = track ? trOf(s.id) : null;
    const trCell = track ? `
      <td class="seg-text-cell">${tr ? (esc(tr.text) || '<span class="meta">(空)</span>') : '<span class="meta">—</span>'}
          <div style="margin-top:3px">${trStatusTag(tr)}${tr ? `<span class="mono">rev ${tr.revision}</span>` : ''}</div></td>` : '';
    const trActions = track ? `
        <button class="btn small" data-act="tr-edit">${tr ? '改译文' : '录译文'}</button>
        ${tr && !tr.stale ? `<button class="btn small ${tr.reviewed ? 'ghost' : 'ok'}" data-act="tr-review">${tr.reviewed ? '取消审译' : '审译'}</button>` : ''}` : '';
    const speakerCell = hasSpeakers ? `
      <td>
        <select class="speaker-select" data-act="speaker" data-rev="${s.revision}">
          <option value="" ${s.speaker_id == null ? 'selected' : ''}>未归属</option>
          ${state.speakers.map((sp) => `<option value="${sp.id}" ${s.speaker_id === sp.id ? 'selected' : ''}>${esc(sp.name)}</option>`).join('')}
        </select>
        ${s.speaker_id == null ? '<div><span class="tag bad">未归属</span></div>' : ''}
      </td>` : '';
    return `
    <tr data-id="${s.id}" class="${state.activeSegmentId === s.id ? 'active' : ''} ${checked ? 'shift-selected' : ''}">
      <td class="shift-col"><input type="checkbox" class="shift-check" data-act="shift-pick" ${checked ? 'checked' : ''} title="勾选后可整体平移" /></td>
      <td>${s.id}</td>
      <td class="mono">${fmtTime(s.start_ms)}<br>→ ${fmtTime(s.end_ms)}</td>
      <td class="seg-text-cell">${esc(s.text) || '<span class="meta">(空)</span>'}
          <div class="mono" style="margin-top:3px">rev ${s.revision}</div></td>
      ${trCell}
      ${speakerCell}
      <td>${s.reviewed ? '<span class="tag ok">已审</span>' : '<span class="tag warn">待审</span>'}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="seek">定位</button>
        <button class="btn small" data-act="edit">编辑</button>
        <button class="btn small" data-act="split">拆分</button>
        <button class="btn small ${s.reviewed ? 'ghost' : 'ok'}" data-act="review">${s.reviewed ? '取消审校' : '标记已审'}</button>
        ${trActions}
        <button class="btn small danger" data-act="del">删除</button>
      </div></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    const seg = state.segments.find((s) => s.id === id);
    tr.querySelector('[data-act=seek]').addEventListener('click', () => {
      state.activeSegmentId = id;
      currentVideoEl().currentTime = seg.start_ms / 1000;
      renderSegmentDependent();
    });
    const pick = tr.querySelector('[data-act=shift-pick]');
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pick.checked) state.shiftSelected.add(id);
      else state.shiftSelected.delete(id);
      renderSegmentTable();
    });
    tr.querySelector('[data-act=edit]').addEventListener('click', () => openEditor('edit', seg));
    tr.querySelector('[data-act=split]').addEventListener('click', () => openSplitModal(seg));
    tr.querySelector('[data-act=review]').addEventListener('click', () => toggleReview(seg));
    tr.querySelector('[data-act=del]').addEventListener('click', () => deleteSegment(seg));
    const trEditBtn = tr.querySelector('[data-act=tr-edit]');
    if (trEditBtn) trEditBtn.addEventListener('click', () => openTrEditor(seg));
    const trReviewBtn = tr.querySelector('[data-act=tr-review]');
    if (trReviewBtn) trReviewBtn.addEventListener('click', () => toggleTrReview(seg));
    const spSel = tr.querySelector('[data-act=speaker]');
    if (spSel) spSel.addEventListener('change', () => assignSpeaker(seg, spSel.value === '' ? null : Number(spSel.value), Number(spSel.dataset.rev)));
  });
}

/* ================= 说话人名单与片段归属 ================= */
function renderSpeakerCard() {
  const card = $('speakersCard');
  if (!card) return;
  const unassignedSet = new Set(state.unassignedIds);
  const rows = state.speakers.map((sp) => `
    <tr>
      <td>${sp.id}</td>
      <td><span class="sp-name" data-id="${sp.id}">${esc(sp.name)}</span></td>
      <td class="mono">${sp.usage_count} 段</td>
      <td><div class="row-actions">
        <button class="btn small" data-spact="rename" data-id="${sp.id}">改名</button>
        <button class="btn small danger" data-spact="delete" data-id="${sp.id}" ${sp.usage_count ? 'disabled title="仍被片段引用，不能删除"' : ''}>删除</button>
      </div></td>
    </tr>`).join('');
  card.innerHTML = `
    <h2>说话人名单</h2>
    <p class="meta">按视频维护说话人，并把每个草稿片段归属到一名说话人。名称去首尾空白后不能为空、不能重复；
      仍被片段引用的说话人不能删除。所有名单修改都携带所见名单修订号 <b>${state.listRevision}</b>；
      归属修改携带片段修订号，成功后片段转<b>待审</b>（原文文字与时间、译文均不变）。
      发布固定当时名称与逐段归属，之后改名或改草稿不影响历史版本。</p>
    <div class="form-row">
      <label>新增说话人
        <input type="text" id="newSpeakerName" placeholder="如：主持人 / 嘉宾A" maxlength="100" />
      </label>
      <button class="btn small primary" id="addSpeakerBtn">新增（修订号 ${state.listRevision}）</button>
    </div>
    <p id="speakerMsg" class="meta"></p>
    <div class="side-scroll">
      <table class="seg-table">
        <thead><tr><th>#</th><th>名称</th><th>引用</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="meta">还没有说话人。存在说话人时，未归属片段会阻止发布。</td></tr>'}</tbody>
      </table>
    </div>
    ${state.speakers.length ? `<p class="meta">未归属片段：<b class="${unassignedSet.size ? 'bad' : 'good'}">${unassignedSet.size}</b> 个
      （在片段表「说话人」列下拉修改归属）${unassignedSet.size ? `：${[...unassignedSet].slice(0, 20).map((id) => `#${id}`).join('、')}${unassignedSet.size > 20 ? ' …' : ''}` : ''}</p>` : ''}`;

  $('addSpeakerBtn').addEventListener('click', addSpeaker);
  $('newSpeakerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSpeaker(); });
  card.querySelectorAll('[data-spact=rename]').forEach((btn) =>
    btn.addEventListener('click', () => renameSpeaker(Number(btn.dataset.id))));
  card.querySelectorAll('[data-spact=delete]').forEach((btn) =>
    btn.addEventListener('click', () => deleteSpeaker(Number(btn.dataset.id))));
}

function speakerMsg(text, bad) {
  const el = $('speakerMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = bad ? 'error' : 'meta';
}

// 名单 409：把服务端返回的当前名单回灌状态并重绘（绝不覆盖他人修改）
function absorbRosterConflict(data) {
  state.speakers = data.speakers || [];
  state.listRevision = data.list_revision || 0;
  state.unassignedIds = data.unassigned_segment_ids || state.unassignedIds;
  renderSegmentDependent();
}

async function addSpeaker() {
  const input = $('newSpeakerName');
  const name = input.value.trim();
  speakerMsg('', false);
  if (!name) { speakerMsg('名称去首尾空白后不能为空', true); return; }
  try {
    const data = await api(`/api/videos/${state.video.id}/speakers`, {
      method: 'POST', body: { name, list_revision: state.listRevision },
    });
    state.speakers = data.speakers;
    state.listRevision = data.list_revision;
    input.value = '';
    renderSegmentDependent();
    toast(`已新增说话人「${data.speaker.name}」`);
  } catch (err) {
    if (err.status === 409 && err.data && err.data.speakers) {
      absorbRosterConflict(err.data);
      speakerMsg(`名单已被他人修改，已刷新：${err.message}`, true);
    } else {
      speakerMsg(err.message, true);
    }
  }
}

async function renameSpeaker(id) {
  const sp = state.speakers.find((x) => x.id === id);
  if (!sp) return;
  const name = prompt(`修改说话人 #${id} 的名称（改名只影响草稿与今后的发布；历史发布版本固定的名称不变）：`, sp.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) { toast('名称去首尾空白后不能为空', true); return; }
  try {
    const data = await api(`/api/videos/${state.video.id}/speakers/${id}`, {
      method: 'PUT', body: { name: trimmed, list_revision: state.listRevision },
    });
    state.speakers = data.speakers;
    state.listRevision = data.list_revision;
    renderSegmentDependent();
    toast(`说话人已改名为「${trimmed}」`);
  } catch (err) {
    if (err.status === 409 && err.data && err.data.speakers) {
      absorbRosterConflict(err.data);
      toast(`名单已被他人修改，已刷新：${err.message}`, true);
    } else {
      toast(`改名失败：${err.message}`, true);
    }
  }
}

async function deleteSpeaker(id) {
  const sp = state.speakers.find((x) => x.id === id);
  if (!sp) return;
  if (sp.usage_count > 0) { toast(`「${sp.name}」仍被 ${sp.usage_count} 个片段引用，请先改这些片段的归属`, true); return; }
  if (!confirm(`确定删除说话人「${sp.name}」？\n该操作携带名单修订号 ${state.listRevision}。`)) return;
  try {
    const data = await api(`/api/videos/${state.video.id}/speakers/${id}`, {
      method: 'DELETE', body: { list_revision: state.listRevision },
    });
    state.speakers = data.speakers;
    state.listRevision = data.list_revision;
    renderSegmentDependent();
    toast(`已删除说话人「${sp.name}」`);
  } catch (err) {
    if (err.status === 409 && err.data && err.data.speakers) {
      absorbRosterConflict(err.data);
      toast(`名单已被他人修改，已刷新：${err.message}`, true);
    } else {
      toast(`删除失败：${err.message}`, true);
    }
  }
}

// 修改片段归属：携带所见片段修订号；成功后片段修订号 +1、转待审；文字/时间/译文不变
async function assignSpeaker(seg, speakerId, seenRevision) {
  const label = speakerId == null ? '未归属' : (state.speakers.find((x) => x.id === speakerId) || {}).name || `#${speakerId}`;
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${seg.id}/speaker`, {
      method: 'PUT', body: { speaker_id: speakerId, revision: seenRevision },
    });
    state.segments = data.segments;
    state.unassignedIds = data.unassigned_segment_ids || [];
    renderSegmentDependent();
    toast(data.changed
      ? `片段 #${seg.id} 已归属「${label}」（原文转待审；文字、时间与译文不变）`
      : `片段 #${seg.id} 本就归属「${label}」，无变化`);
  } catch (err) {
    if (err.status === 409) {
      await refreshCurrent();
      if (err.data && err.data.speakers) absorbRosterConflict(err.data);
      toast(`冲突：${err.message}，已刷新当前状态`, true);
    } else {
      toast(`归属修改失败：${err.message}`, true);
      await refreshCurrent();
    }
  }
}

/* ================= 片段编辑弹窗 ================= */
function openEditor(mode, segment) {
  state.editor = { mode, segmentId: segment ? segment.id : null };
  $('editorError').textContent = '';
  $('editorReviewNote').classList.add('hidden');
  if (mode === 'create') {
    $('editorTitle').textContent = '新增片段';
    $('editorId').textContent = '新';
    $('editorRevision').textContent = '—';
    const start = currentMs();
    $('editStart').value = start;
    $('editEnd').value = Math.min(start + 3000, state.video.duration_ms);
    $('editText').value = '';
  } else {
    $('editorTitle').textContent = '编辑片段';
    $('editorId').textContent = segment.id;
    $('editorRevision').textContent = segment.revision;
    $('editorReviewNote').classList.toggle('hidden', !segment.reviewed);
    $('editStart').value = segment.start_ms;
    $('editEnd').value = segment.end_ms;
    $('editText').value = segment.text;
  }
  $('editorModal').classList.remove('hidden');
}

function closeEditor() {
  state.editor = null;
  $('editorModal').classList.add('hidden');
}

function editorInputs() {
  return {
    start_ms: Number($('editStart').value),
    end_ms: Number($('editEnd').value),
    text: $('editText').value,
  };
}

async function saveEditor() {
  const e = state.editor;
  if (!e) return;
  const body = editorInputs();
  $('editorError').textContent = '';
  try {
    let data;
    if (e.mode === 'create') {
      data = await api(`/api/videos/${state.video.id}/segments`, { method: 'POST', body });
      toast('片段已新增（待审）');
    } else {
      const seg = state.segments.find((s) => s.id === e.segmentId);
      data = await api(`/api/videos/${state.video.id}/segments/${e.segmentId}`, {
        method: 'PUT',
        body: { ...body, revision: seg.revision },
      });
      const wasReviewed = seg.reviewed;
      if (wasReviewed && !data.segment.reviewed) toast('已保存；因内容被修改，审校状态已撤销', true);
      else toast('片段已保存');
    }
    state.segments = data.segments;
    closeEditor();
    renderSegmentDependent();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.current) {
      closeEditor();
      showConflict(err.message, err.data.current, e);
      return;
    }
    // 422 等非法修改：保留弹窗与用户输入（原稿未被服务端改动）
    $('editorError').textContent = `未保存：${err.message}`;
  }
}

async function toggleReview(seg) {
  const target = !seg.reviewed;
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${seg.id}/review`, {
      method: 'POST',
      body: { reviewed: target, revision: seg.revision },
    });
    state.segments = data.segments;
    renderSegmentDependent();
    toast(target ? `片段 #${seg.id} 已标记审校` : `片段 #${seg.id} 已取消审校`);
  } catch (err) {
    if (err.status === 409) {
      toast('冲突：该片段已被他人修改，已刷新最新内容', true);
      await refreshCurrent();
    } else {
      toast(`操作失败：${err.message}`, true);
    }
  }
}

async function deleteSegment(seg) {
  if (!confirm(`确定删除片段 #${seg.id}？\n「${seg.text.slice(0, 60)}」\n删除需匹配修订号 rev ${seg.revision}`)) return;
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${seg.id}`, {
      method: 'DELETE',
      body: { revision: seg.revision },
    });
    state.segments = data.segments;
    renderSegmentDependent();
    toast('片段已删除');
  } catch (err) {
    if (err.status === 409) {
      toast('冲突：该片段已被他人修改，已刷新最新内容', true);
      await refreshCurrent();
    } else {
      toast(`删除失败：${err.message}`, true);
    }
  }
}

async function refreshCurrent() {
  const data = await api(`/api/videos/${state.video.id}`);
  state.segments = data.segments;
  state.publications = data.publications;
  state.translations = data.translations || [];
  state.translationLang = data.translation_lang != null ? data.translation_lang : null;
  state.qcRules = data.qc_rules || null;
  state.speakers = data.speakers || [];
  state.listRevision = data.list_revision || 0;
  state.unassignedIds = data.unassigned_segment_ids || [];
  syncShiftSelected();
  renderSegmentDependent();
  try { await loadQcReport(); renderQcPanel(); } catch (_) { /* 忽略 */ }
}

/* ================= 片段拆分弹窗 ================= */
const splitEditor = { segmentId: null };

function openSplitModal(seg) {
  splitEditor.segmentId = seg.id;
  const track = !!state.translationLang;
  const tr = track ? trOf(seg.id) : null;
  $('splitSegId').textContent = seg.id;
  $('splitRange').textContent = `${fmtTime(seg.start_ms)} → ${fmtTime(seg.end_ms)}`;
  $('splitRevision').textContent = seg.revision;
  $('splitSource').textContent = seg.text || '(空文本)';
  $('splitTrCurrentWrap').classList.toggle('hidden', !(track && tr));
  if (track && tr) $('splitTrSource').textContent = tr.text || '(空)';
  $('splitTrRevWrap').classList.toggle('hidden', !(track && tr));
  if (track && tr) $('splitTrRevision').textContent = tr.revision;
  $('splitTrInputs').classList.toggle('hidden', !track);
  if (track) $('splitTrLang').textContent = state.translationLang;
  // 默认切点：播放位置落在片段内部时取播放位置，否则取片段中点
  const play = currentMs();
  $('splitCut').value = play > seg.start_ms && play < seg.end_ms
    ? play : Math.floor((seg.start_ms + seg.end_ms) / 2);
  $('splitLeftText').value = seg.text;
  $('splitRightText').value = '';
  $('splitLeftTr').value = '';
  $('splitRightTr').value = '';
  $('splitError').textContent = '';
  $('splitModal').classList.remove('hidden');
}

function closeSplitModal() {
  splitEditor.segmentId = null;
  $('splitModal').classList.add('hidden');
}

async function saveSplit() {
  const seg = state.segments.find((s) => s.id === splitEditor.segmentId);
  if (!seg) { closeSplitModal(); return; }
  const tr = state.translationLang ? trOf(seg.id) : null;
  const body = {
    cut_ms: Number($('splitCut').value),
    left_text: $('splitLeftText').value,
    right_text: $('splitRightText').value,
    revision: seg.revision,
  };
  if (state.translationLang) {
    body.left_translation = $('splitLeftTr').value;
    body.right_translation = $('splitRightTr').value;
    if (tr) body.translation_revision = tr.revision;
  }
  $('splitError').textContent = '';
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${seg.id}/split`, { method: 'POST', body });
    state.segments = data.segments;
    state.translations = data.translations || [];
    closeSplitModal();
    renderSegmentDependent();
    // 拆分改变时长并使放行失效：立即刷新质检报告与发布门禁
    loadQcReport().then(() => { renderQcPanel(); renderPublishCard(); }).catch(() => {});
    toast(`已拆分为 #${data.left.id}（左）与 #${data.right.id}（右），两段均待审`);
  } catch (err) {
    if (err.status === 409) {
      // 修订号过期：刷新为当前原文/译文状态，保留用户已输入的拆分内容
      await refreshCurrent();
      const fresh = state.segments.find((s) => s.id === splitEditor.segmentId);
      if (!fresh) {
        closeSplitModal();
        toast('冲突：该片段已被他人删除', true);
        return;
      }
      const freshTr = state.translationLang ? trOf(fresh.id) : null;
      $('splitRange').textContent = `${fmtTime(fresh.start_ms)} → ${fmtTime(fresh.end_ms)}`;
      $('splitRevision').textContent = fresh.revision;
      $('splitSource').textContent = fresh.text || '(空文本)';
      $('splitTrCurrentWrap').classList.toggle('hidden', !(state.translationLang && freshTr));
      $('splitTrRevWrap').classList.toggle('hidden', !(state.translationLang && freshTr));
      if (freshTr) {
        $('splitTrSource').textContent = freshTr.text || '(空)';
        $('splitTrRevision').textContent = freshTr.revision;
      }
      $('splitError').textContent = `未拆分：${err.message}`;
      return;
    }
    // 422 等非法修改：保留弹窗与用户输入（原稿未被服务端改动）
    $('splitError').textContent = `未拆分：${err.message}`;
  }
}

/* ================= 多片段整体平移 ================= */
const shiftState = { preview: null, busy: false };

/* ================= 译文轨道 ================= */
async function enableTrack() {
  const input = $('trackLang');
  const language = input ? input.value.trim() : '';
  if (!language) { toast('请先填写译文语言（如 en / zh-Hans / 日语）', true); return; }
  try {
    await api(`/api/videos/${state.video.id}/translation/track`, { method: 'PUT', body: { language } });
    toast(`已启用「${language}」译文轨道`);
    await refreshCurrent();
  } catch (err) {
    toast(`启用失败：${err.message}`, true);
  }
}

async function disableTrack() {
  if (!confirm(`确定停用「${state.translationLang}」译文轨道？\n该视频草稿的全部译文将被删除（已发布版本的快照不受影响）。`)) return;
  try {
    await api(`/api/videos/${state.video.id}/translation/track`, { method: 'DELETE' });
    toast('译文轨道已停用，草稿译文已全部删除');
    await refreshCurrent();
  } catch (err) {
    toast(`停用失败：${err.message}`, true);
  }
}

/* ---------- 译文编辑弹窗 ---------- */
const trEditor = { segmentId: null };

function openTrEditor(seg) {
  const tr = trOf(seg.id);
  trEditor.segmentId = seg.id;
  $('trTitle').textContent = tr ? '修改译文' : '录入译文';
  $('trSegId').textContent = seg.id;
  $('trSegRev').textContent = seg.revision;
  $('trRev').textContent = tr ? tr.revision : '—（新译文）';
  $('trLang').textContent = state.translationLang;
  $('trSource').textContent = seg.text || '(空文本)';
  $('trText').value = tr ? tr.text : '';
  $('trStaleNote').classList.toggle('hidden', !(tr && tr.stale));
  $('trReviewNote').classList.toggle('hidden', !(tr && tr.reviewed));
  $('trError').textContent = '';
  $('trModal').classList.remove('hidden');
}

function closeTrEditor() {
  trEditor.segmentId = null;
  $('trModal').classList.add('hidden');
}

async function saveTrEditor() {
  const seg = state.segments.find((s) => s.id === trEditor.segmentId);
  if (!seg) { closeTrEditor(); return; }
  const tr = trOf(seg.id);
  const wasReviewed = !!(tr && tr.reviewed);
  const body = { text: $('trText').value, segment_revision: seg.revision };
  if (tr) body.revision = tr.revision;
  $('trError').textContent = '';
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${seg.id}/translation`, {
      method: 'PUT',
      body,
    });
    state.translations = data.translations;
    closeTrEditor();
    renderSegmentDependent();
    if (wasReviewed && !data.translation.reviewed) toast('译文已保存；因内容被修改，译文审校状态已撤销', true);
    else toast('译文已保存（待审）');
  } catch (err) {
    if (err.status === 409 && err.data && err.data.current) {
      // 修订号过期：刷新为当前原文/译文状态，保留用户已输入的译文文本
      $('trError').textContent = `未保存：${err.message}`;
      await refreshCurrent();
      const freshSeg = state.segments.find((s) => s.id === trEditor.segmentId);
      if (!freshSeg) { closeTrEditor(); return; }
      const freshTr = trOf(freshSeg.id);
      $('trSegRev').textContent = freshSeg.revision;
      $('trRev').textContent = freshTr ? freshTr.revision : '—（新译文）';
      $('trSource').textContent = freshSeg.text || '(空文本)';
      $('trStaleNote').classList.toggle('hidden', !(freshTr && freshTr.stale));
      return;
    }
    $('trError').textContent = `未保存：${err.message}`;
  }
}

async function toggleTrReview(seg) {
  const tr = trOf(seg.id);
  if (!tr) return;
  const target = !tr.reviewed;
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${seg.id}/translation/review`, {
      method: 'POST',
      body: { reviewed: target, segment_revision: seg.revision, revision: tr.revision },
    });
    state.translations = data.translations;
    renderSegmentDependent();
    toast(target ? `片段 #${seg.id} 译文已标记审校` : `片段 #${seg.id} 译文已取消审校`);
  } catch (err) {
    if (err.status === 409) {
      toast('冲突：原文或译文已被他人修改，已刷新最新状态', true);
      await refreshCurrent();
    } else if (err.status === 422 && err.data && err.data.code === 'translation_stale') {
      toast('译文已失效：请先按当前原文重新校对译文', true);
      await refreshCurrent();
    } else {
      toast(`操作失败：${err.message}`, true);
    }
  }
}


/* ---------- 冲突弹窗 ---------- */
function showConflict(message, current, editorCtx) {
  $('conflictMessage').textContent = message;
  $('conflictRevision').textContent = current.revision;
  $('conflictTime').textContent = `${fmtTime(current.start_ms)} → ${fmtTime(current.end_ms)}`;
  $('conflictText').textContent = current.text;
  $('conflictReviewed').classList.toggle('hidden', !current.reviewed);
  $('conflictNotReviewed').classList.toggle('hidden', current.reviewed);
  $('conflictModal').classList.remove('hidden');

  $('conflictDiscard').onclick = async () => {
    $('conflictModal').classList.add('hidden');
    await refreshCurrent();
  };
  $('conflictReload').onclick = async () => {
    $('conflictModal').classList.add('hidden');
    const fresh = state.segments.find((s) => s.id === current.id);
    if (editorCtx && editorCtx.mode === 'edit' && fresh) openEditor('edit', fresh);
  };
}

/* ================= 质检（QC）：配置、查看与放行 ================= */
const RULE_NAMES = { max_cps: '每秒字符数（CPS）', max_line_chars: '最大单行字符数' };
const TRACK_NAMES = { source: '原文', translation: '译文' };
const qcWaiverEditor = { segmentId: null, track: null, rule: null };

function qcRulesRevision() {
  return state.qcRules ? state.qcRules.revision : 0;
}

function fmtThreshold(v) {
  return v == null ? '<span class="meta">未配置</span>' : esc(String(v));
}

function renderQcStatusLi(qc) {
  if (!qc || !qc.configured) {
    return '<li class="good">质检：未配置阈值（不阻断发布）</li>';
  }
  const ok = qc.blocking_count === 0;
  return `<li class="${ok ? 'good' : 'bad'}">
    质检：违规 ${qc.violation_count} 项${qc.active_waiver_count ? `｜已放行 ${qc.active_waiver_count} 项` : ''}
    ${qc.blocking_count ? `｜<b>待放行 ${qc.blocking_count} 项</b>` : '｜无阻断项'}</li>`;
}

function renderQcPanel() {
  const card = $('qcCard');
  if (!card) return;
  const r = state.qcRules || { revision: 0, source: { max_cps: null, max_line_chars: null }, translation: { max_cps: null, max_line_chars: null } };
  const rep = state.qcReport;
  const track = !!state.translationLang;
  const cfgCount = [r.source.max_cps, r.source.max_line_chars, r.translation.max_cps, r.translation.max_line_chars]
    .filter((x) => x != null).length;

  card.innerHTML = `
    <h2>质检规则与放行</h2>
    <p class="meta">按 Unicode 码点计数；换行不计入速度，速度 = 非换行字符数 ÷ 片段时长（秒）。
      阈值留空表示该项不检查、不阻断。发布时会重新质检，<b>未放行违规将阻止发布</b>；原有审校门禁始终适用。
      规则修订号 <b>${r.revision}</b>。</p>
    <table class="qc-rules-table">
      <thead><tr><th>轨道</th><th>最大每秒字符数</th><th>最大单行字符数</th></tr></thead>
      <tbody>
        <tr><td>原文</td>
          <td><input type="number" min="0" step="any" id="qcSrcCps" placeholder="留空=不检查" value="${r.source.max_cps ?? ''}" /></td>
          <td><input type="number" min="1" step="1" id="qcSrcLine" placeholder="留空=不检查" value="${r.source.max_line_chars ?? ''}" /></td></tr>
        <tr class="${track ? '' : 'hidden'}"><td>译文${track ? `（${esc(state.translationLang)}）` : ''}</td>
          <td><input type="number" min="0" step="any" id="qcTrCps" placeholder="留空=不检查" value="${r.translation.max_cps ?? ''}" /></td>
          <td><input type="number" min="1" step="1" id="qcTrLine" placeholder="留空=不检查" value="${r.translation.max_line_chars ?? ''}" /></td></tr>
      </tbody>
    </table>
    <div class="row-actions">
      <button class="btn small primary" id="qcSaveRules">保存质检规则（修订号 ${r.revision}）</button>
      <button class="btn small" id="qcRefresh">重新质检</button>
    </div>
    <p id="qcRulesMsg" class="meta"></p>
    <hr>
    <div id="qcReportBox">${rep ? renderQcReportHtml(rep) : '<p class="meta">质检结果加载中…</p>'}</div>`;

  $('qcSaveRules').addEventListener('click', saveQcRules);
  $('qcRefresh').addEventListener('click', async () => {
    try { await loadQcReport(); renderQcPanel(); renderPublishCard(); toast('已重新质检'); }
    catch (e) { toast(`质检失败：${e.message}`, true); }
  });
  if (rep) bindQcReportActions(card, rep);
}

function qcInputOrNull(id) {
  const el = $(id);
  const raw = el.value.trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

async function saveQcRules() {
  const msg = $('qcRulesMsg');
  msg.textContent = '';
  const body = {
    source_max_cps: qcInputOrNull('qcSrcCps'),
    source_max_line_chars: qcInputOrNull('qcSrcLine'),
    translation_max_cps: qcInputOrNull('qcTrCps'),
    translation_max_line_chars: qcInputOrNull('qcTrLine'),
    rules_revision: qcRulesRevision(),
  };
  if (Object.values(body).some((v) => Number.isNaN(v))) {
    msg.textContent = '阈值必须为正数（单行字符数为正整数）；留空表示不检查。';
    msg.className = 'error';
    return;
  }
  try {
    const data = await api(`/api/videos/${state.video.id}/qc/rules`, { method: 'PUT', body });
    state.qcRules = data.rules;
    await loadQcReport();
    renderQcPanel();
    renderPublishCard();
    toast('质检规则已保存；阈值变化后既有放行已全部失效（历史保留）');
  } catch (err) {
    if (err.status === 409 && err.data && err.data.current_rules) {
      state.qcRules = err.data.current_rules;
      renderQcPanel();
      toast(`规则修订号过期：${err.message}`, true);
      return;
    }
    msg.textContent = `保存失败：${err.message}`;
    msg.className = 'error';
  }
}

function renderQcReportHtml(rep) {
  if (!rep.configured) {
    return '<p class="meta">当前未配置任何质检阈值，质检不阻断发布。配置阈值后此处逐段列出实测值、阈值与违规项。</p>';
  }
  const blocking = rep.blocking_violations || [];
  const rows = blocking.map((v) => `
    <tr class="qc-bad">
      <td>${v.segment_id}</td>
      <td><a href="javascript:void(0)" class="qc-seek" data-id="${v.segment_id}">${fmtTime(v.start_ms)} → ${fmtTime(v.end_ms)}</a></td>
      <td>${TRACK_NAMES[v.track]}${v.track === 'translation' && v.language ? `（${esc(v.language)}）` : ''}</td>
      <td>${RULE_NAMES[v.rule]}</td>
      <td class="mono">${esc(String(v.value))}</td>
      <td class="mono">${esc(String(v.threshold))}</td>
      <td><button class="btn small danger" data-act="qc-waive"
         data-seg="${v.segment_id}" data-track="${v.track}" data-rule="${v.rule}">填写理由放行</button></td>
    </tr>`).join('');

  const waived = (rep.violations || []).filter((v) => v.waived);
  const waivedRows = waived.map((v) => `
    <tr class="qc-waived">
      <td>${v.segment_id}</td>
      <td><a href="javascript:void(0)" class="qc-seek" data-id="${v.segment_id}">${fmtTime(v.start_ms)} → ${fmtTime(v.end_ms)}</a></td>
      <td>${TRACK_NAMES[v.track]}${v.track === 'translation' && v.language ? `（${esc(v.language)}）` : ''}</td>
      <td>${RULE_NAMES[v.rule]}</td>
      <td class="mono">${esc(String(v.value))} / ${esc(String(v.threshold))}</td>
      <td>已放行：${esc(v.waiver ? v.waiver.reason : '')}</td>
    </tr>`).join('');

  const history = (rep.waivers || []).filter((w) => !w.active);
  const historyRows = history.slice(0, 50).map((w) => `
    <tr class="qc-hist">
      <td>${w.segment_id}</td>
      <td>${TRACK_NAMES[w.track]}${w.language ? `（${esc(w.language)}）` : ''}</td>
      <td>${RULE_NAMES[w.rule]}</td>
      <td class="qc-reason-cell">${esc(w.reason)}</td>
      <td>${new Date(w.created_at).toLocaleString()}</td>
      <td><span class="tag warn">已失效</span></td>
    </tr>`).join('');

  return `
    <p class="meta">逐段质检结果：共 <b>${rep.violation_count}</b> 项违规，
      其中 <b style="color:var(--danger)">${blocking.length} 项待放行</b>，
      <span style="color:var(--ok)">${waived.length} 项已放行</span>；历史失效放行 ${history.length} 条（理由保留）。</p>
    ${blocking.length ? `
    <b class="bad">⚠️ 阻止发布的违规（逐项可放行）</b>
    <div class="qc-scroll">
      <table class="seg-table qc-table">
        <thead><tr><th>#</th><th>时间（点击定位）</th><th>轨道</th><th>项目</th><th>实测值</th><th>阈值</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : '<p class="good">✔ 没有阻止发布的违规。</p>'}
    ${waived.length ? `
    <b style="color:var(--ok)">已放行（绑定内容/阈值变化后自动失效）</b>
    <div class="qc-scroll">
      <table class="seg-table qc-table">
        <thead><tr><th>#</th><th>时间</th><th>轨道</th><th>项目</th><th>实测/阈值</th><th>理由</th></tr></thead>
        <tbody>${waivedRows}</tbody>
      </table>
    </div>` : ''}
    ${history.length ? `
    <details><summary class="meta">失效放行历史（${history.length} 条）</summary>
    <div class="qc-scroll">
      <table class="seg-table qc-table">
        <thead><tr><th>#</th><th>轨道</th><th>项目</th><th>理由</th><th>放行时间</th><th>状态</th></tr></thead>
        <tbody>${historyRows}</tbody>
      </table>
    </div></details>` : ''}`;
}

function bindQcReportActions(card, rep) {
  card.querySelectorAll('.qc-seek').forEach((a) => {
    a.addEventListener('click', () => seekSegment(Number(a.dataset.id)));
  });
  card.querySelectorAll('[data-act=qc-waive]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const segId = Number(btn.dataset.seg);
      const v = rep.violations.find((x) => x.segment_id === segId && x.track === btn.dataset.track && x.rule === btn.dataset.rule);
      if (v) openQcWaiver(v);
    });
  });
}

function seekSegment(id) {
  const seg = state.segments.find((s) => s.id === id);
  if (!seg) return;
  state.activeSegmentId = id;
  const videoEl = currentVideoEl();
  if (videoEl) videoEl.currentTime = seg.start_ms / 1000;
  renderSegmentDependent();
  const tr = document.querySelector(`#segTbody tr[data-id="${id}"]`);
  if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function openQcWaiver(v) {
  qcWaiverEditor.segmentId = v.segment_id;
  qcWaiverEditor.track = v.track;
  qcWaiverEditor.rule = v.rule;
  $('qcWaiverSegId').textContent = v.segment_id;
  $('qcWaiverTrack').textContent = TRACK_NAMES[v.track] + (v.track === 'translation' && v.language ? `（${v.language}）` : '');
  $('qcWaiverRule').textContent = RULE_NAMES[v.rule];
  $('qcWaiverValue').textContent = v.value;
  $('qcWaiverThreshold').textContent = v.threshold;
  $('qcWaiverReason').value = '';
  $('qcWaiverError').textContent = '';
  $('qcWaiverModal').classList.remove('hidden');
}
function closeQcWaiver() {
  qcWaiverEditor.segmentId = null;
  $('qcWaiverModal').classList.add('hidden');
}

async function saveQcWaiver() {
  const e = qcWaiverEditor;
  if (!e.segmentId) return;
  const reason = $('qcWaiverReason').value.trim();
  if (!reason) { $('qcWaiverError').textContent = '请填写放行理由'; return; }
  const seg = state.segments.find((s) => s.id === e.segmentId);
  const body = { track: e.track, rule: e.rule, reason, segment_revision: seg ? seg.revision : null };
  if (e.track === 'translation') {
    const tr = trOf(e.segmentId);
    if (tr) body.revision = tr.revision;
  }
  $('qcWaiverError').textContent = '';
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${e.segmentId}/qc/waiver`, { method: 'PUT', body });
    state.qcReport = data.qc;
    closeQcWaiver();
    renderQcPanel();
    renderPublishCard();
    toast('已放行：该违规不再阻止发布；内容或阈值变化后放行自动失效');
  } catch (err) {
    if (err.status === 409) {
      await refreshCurrent();
      closeQcWaiver();
      toast(`冲突：${err.message}，已刷新当前状态`, true);
      return;
    }
    if (err.status === 422 && err.data && err.data.current_qc) {
      state.qcReport = err.data.current_qc;
      renderQcPanel();
      renderPublishCard();
      $('qcWaiverError').textContent = `未能放行：${err.message}`;
      return;
    }
    $('qcWaiverError').textContent = `未能放行：${err.message}`;
  }
}

async function openPublishedQc(version, unavailable) {
  if (unavailable) {
    toast(`v${version} 发布时未配置质检阈值，没有质检快照（旧版本行为保持不变）`, true);
    return;
  }
  try {
    const d = await api(`/api/videos/${state.video.id}/publications/${version}/qc`);
    $('qcPubTitle').textContent = `v${d.version} 发布时固定的质检快照（${new Date(d.published_at).toLocaleString()}）`;
    $('qcPubMeta').textContent =
      `规则修订号 ${d.rules_snapshot ? d.rules_snapshot.revision : 0}；检查轨道：${d.tracks.join('、')}；` +
      `违规 ${d.violations.length} 项；有效放行 ${d.valid_waivers.length} 项（快照固定，不随后续编辑变化）。`;
    const bodyRows = d.violations.map((v) => `
      <tr class="${v.waived ? 'qc-waived' : 'qc-bad'}">
        <td>${v.segment_id}</td>
        <td class="mono">${fmtTime(v.start_ms)} → ${fmtTime(v.end_ms)}</td>
        <td>${TRACK_NAMES[v.track]}${v.track === 'translation' && v.language ? `（${esc(v.language)}）` : ''}</td>
        <td>${RULE_NAMES[v.rule]}</td>
        <td class="mono">${esc(String(v.value))}</td>
        <td class="mono">${esc(String(v.threshold))}</td>
        <td>${v.waived ? `已放行：${esc(v.waiver ? v.waiver.reason : '')}` : '<span class="tag warn">未放行</span>'}</td>
      </tr>`).join('');
    $('qcPubBody').innerHTML = `
      <table class="seg-table qc-table">
        <thead><tr><th>#</th><th>时间</th><th>轨道</th><th>项目</th><th>实测值</th><th>阈值</th><th>发布时状态</th></tr></thead>
        <tbody>${bodyRows || '<tr><td colspan="7" class="meta">该版本质检无违规项。</td></tr>'}</tbody>
      </table>`;
    $('qcPubModal').classList.remove('hidden');
  } catch (err) {
    toast(`无法查看：${err.message}`, true);
  }
}

/* ================= 发布 / 下载 ================= */
function computeStatus() {
  const problems = [];
  if (state.segments.length === 0) problems.push('至少需要一个字幕片段才能发布');
  for (const s of state.segments) {
    if (s.start_ms < 0 || s.start_ms >= s.end_ms) problems.push(`片段 #${s.id} 起点必须早于终点`);
    if (s.end_ms > state.video.duration_ms) problems.push(`片段 #${s.id} 终点超过视频时长`);
  }
  const ordered = [...state.segments].sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start_ms < ordered[i - 1].end_ms) {
      problems.push(`片段 #${ordered[i - 1].id} 与 #${ordered[i].id} 时间重叠`);
    }
  }
  if (state.segments.some((s) => !s.reviewed)) problems.push('仍有片段未通过审校');

  // 说话人门禁：存在名单时，每段都必须归属
  let sp = null;
  if (state.speakers.length) {
    sp = { total: state.speakers.length, unassigned: 0 };
    for (const s of state.segments) if (s.speaker_id == null) sp.unassigned++;
    if (sp.unassigned) problems.push(`说话人：${sp.unassigned} 个片段尚未归属说话人`);
  }

  // 译文轨道门禁：每段译文齐备、已审且对应当前原文（未失效）
  let tr = null;
  if (state.translationLang) {
    tr = { missing: 0, stale: 0, unreviewed: 0, ok: 0 };
    for (const s of state.segments) {
      const t = trOf(s.id);
      if (!t) tr.missing++;
      else if (t.stale) tr.stale++;
      else if (!t.reviewed) tr.unreviewed++;
      else tr.ok++;
    }
    if (tr.missing) problems.push(`译文轨道：${tr.missing} 段缺少译文`);
    if (tr.stale) problems.push(`译文轨道：${tr.stale} 段译文已失效（需重新校对）`);
    if (tr.unreviewed) problems.push(`译文轨道：${tr.unreviewed} 段译文待审校`);
  }
  // 质检门禁：未放行的违规阻止发布（已放行的不阻止）
  const qc = state.qcReport;
  if (qc && qc.configured && qc.blocking_count > 0) {
    problems.push(`质检：${qc.blocking_count} 项违规尚未放行`);
  }
  return {
    canPublish: problems.length === 0,
    problems,
    reviewedCount: state.segments.filter((s) => s.reviewed).length,
    tr,
    sp,
    qc,
  };
}

function renderPublishCard() {
  const card = $('publishCard');
  if (!card) return;
  const status = computeStatus();
  const track = !!state.translationLang;
  card.innerHTML = `
    <h2>发布与下载</h2>
    <p class="meta">发布生成不可变版本快照；发布后再编辑只影响草稿，不影响历史版本。${track ? '启用译文轨道后，发布会同时固定原文与译文两轨内容。' : ''}</p>
    <ul class="status-list">
      <li class="${state.segments.length ? 'good' : 'bad'}">片段数量：${state.segments.length}（至少 1 段）</li>
      <li class="${status.reviewedCount === state.segments.length && state.segments.length ? 'good' : 'bad'}">
        审校进度：${status.reviewedCount}/${state.segments.length}</li>
      ${status.sp ? `<li class="${status.sp.unassigned === 0 && state.segments.length ? 'good' : 'bad'}">
        说话人归属：${state.segments.length - status.sp.unassigned}/${state.segments.length}
        （名单 ${status.sp.total} 人）${status.sp.unassigned ? `｜<b>${status.sp.unassigned} 段未归属，阻止发布</b>` : ''}</li>` : ''}
      ${track ? `<li class="${status.tr.missing + status.tr.stale + status.tr.unreviewed === 0 && state.segments.length ? 'good' : 'bad'}">
        译文（${esc(state.translationLang)}）已审：${status.tr.ok}/${state.segments.length}
        ${status.tr.missing ? `｜未译 ${status.tr.missing}` : ''}${status.tr.stale ? `｜已失效 ${status.tr.stale}` : ''}${status.tr.unreviewed ? `｜待审 ${status.tr.unreviewed}` : ''}</li>` : ''}
      ${renderQcStatusLi(status.qc)}
      ${status.problems.filter((p) => !p.includes('未通过审校') && !p.includes('至少需要') && !p.startsWith('译文轨道')).map((p) =>
        `<li class="bad">时间问题：${esc(p)}</li>`).join('')}
    </ul>
    <div class="publish-bar">
      <button class="btn primary" id="publishBtn" ${status.canPublish ? '' : 'disabled'}>发布新版本</button>
      <div class="dropdown">
        <button class="btn" id="downloadBtn">下载 SRT ▾</button>
        <div class="dropdown-menu hidden" id="downloadMenu"></div>
      </div>
    </div>
    <div class="track-bar" id="trackBar"></div>
    <div class="pub-list" id="pubList"></div>`;

  $('publishBtn').addEventListener('click', publishVersion);

  const menu = $('downloadMenu');  const items = ['<div class="label">原文 · 草稿（当前编辑内容）</div>',
    `<a href="/api/videos/${state.video.id}/srt?version=draft">原文 SRT（草稿）</a>`];
  if (state.publications.length) {
    items.push('<div class="label" style="margin-top:6px">原文 · 已发布版本（不可变）</div>');
    items.push(`<a href="/api/videos/${state.video.id}/srt?version=published">最新已发布 v${state.publications[0].version} 原文 SRT</a>`);
    for (const p of state.publications) {
      items.push(`<a href="/api/videos/${state.video.id}/srt?version=${p.version}">v${p.version}（${new Date(p.published_at).toLocaleString()}，${p.segment_count} 段）</a>`);
    }
  } else {
    items.push('<div class="label" style="margin-top:6px;color:var(--warn)">尚无已发布版本</div>');
  }
  const trPubs = state.publications.filter((p) => p.has_translation);
  if (track || trPubs.length) {
    items.push(`<div class="label" style="margin-top:6px">译文 SRT${track ? `（${esc(state.translationLang)}）` : ''}</div>`);
    if (track) items.push(`<a href="/api/videos/${state.video.id}/srt/translation?version=draft">译文 SRT（草稿，需译文齐备且未失效）</a>`);
    for (const p of trPubs) {
      items.push(`<a href="/api/videos/${state.video.id}/srt/translation?version=${p.version}">v${p.version} 译文 SRT（${esc(p.translation_lang || '')}）</a>`);
    }
  }
  menu.innerHTML = items.join('');
  $('downloadBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });

  // 译文轨道管理栏
  const bar = $('trackBar');
  if (!track) {
    bar.innerHTML = `
      <div class="form-row">
        <label>译文轨道（未启用）：输入语言后启用
          <input type="text" id="trackLang" placeholder="如 en / zh-Hans / 日语" maxlength="40" />
        </label>
        <button class="btn small primary" id="trackEnableBtn">启用译文轨道</button>
      </div>`;
    $('trackEnableBtn').addEventListener('click', enableTrack);
  } else {
    bar.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="meta" style="margin:0">译文轨道：<b>${esc(state.translationLang)}</b>（同一视频仅一个语言）</span>
        <button class="btn small danger" id="trackDisableBtn">停用轨道（删除全部译文）</button>
      </div>`;
    $('trackDisableBtn').addEventListener('click', disableTrack);
  }

  const pubList = $('pubList');
  pubList.innerHTML = state.publications.length
    ? '历史发布：' + state.publications
        .map((p) => `v${p.version}${p.has_translation ? '（双轨）' : ''}${p.has_qc ? '（含质检快照）' : ''}${p.has_speakers ? '（含说话人快照）' : ''} · ${new Date(p.published_at).toLocaleString()} · ${p.segment_count} 段
          <a href="javascript:void(0)" class="qc-pub-link" data-version="${p.version}">${p.has_qc ? '查看质检快照' : '质检快照（无）'}</a>`)
        .join(' ｜ ')
    : '尚未发布过版本';
  pubList.querySelectorAll('.qc-pub-link').forEach((a) => {
    a.addEventListener('click', () => openPublishedQc(Number(a.dataset.version), !state.publications.find((p) => p.version === Number(a.dataset.version)).has_qc));
  });
}

async function publishVersion() {
  try {
    const data = await api(`/api/videos/${state.video.id}/publish`, { method: 'POST' });
    toast(`已发布不可变版本 v${data.publication.version}`);
    await refreshCurrent();
  } catch (err) {
    const pending = err.data && Array.isArray(err.data.pending) ? err.data.pending : [];
    const suffix = pending.length ? `（待处理片段：${pending.map((p) => `#${p.segment_id}`).join('、')}）` : '';
    if (err.data && err.data.code === 'qc_blocked') {
      // 发布时重新质检：刷新报告并展开质检面板定位未放行违规
      try { await loadQcReport(); renderQcPanel(); renderPublishCard(); } catch (_) { /* 忽略 */ }
      const n = err.data.qc && err.data.qc.blocking_count;
      toast(`发布被质检阻止：${n} 项违规尚未放行，请在「质检规则与放行」中逐项处理`, true);
      const card = $('qcCard');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    toast(`发布失败：${err.message}${suffix}`, true);
  }
}

/* ================= SRT 导入 ================= */
const IMPORT_PREVIEW_LIMIT = 200;
const importState = { content: null, filename: null, preview: null, busy: false };

function openImportModal() {
  importState.content = null;
  importState.filename = null;
  importState.preview = null;
  importState.busy = false;
  $('importFile').value = '';
  $('importFileMsg').textContent = '';
  $('importError').textContent = '';
  $('importResult').classList.add('hidden');
  $('importAppendBtn').disabled = true;
  $('importReplaceBtn').disabled = true;
  $('importModal').classList.remove('hidden');
}
function closeImportModal() {
  $('importModal').classList.add('hidden');
}

async function previewImport() {
  const file = $('importFile').files[0];
  $('importError').textContent = '';
  if (!file) { $('importError').textContent = '请先选择 .srt 文件'; return; }
  $('importFileMsg').textContent = `正在解析 ${file.name}…`;
  // 预览与确认都发送同一份解码文本（浏览器 UTF-8 解码会去掉 BOM），保证内容指纹一致
  const content = await file.text();
  importState.content = content;
  importState.filename = file.name;
  try {
    const fd = new FormData();
    fd.append('srt', new Blob([content], { type: 'text/plain' }), file.name);
    const data = await api(`/api/videos/${state.video.id}/srt/preview`, { method: 'POST', body: fd });
    importState.preview = data;
    renderImportPreview(data);
  } catch (err) {
    importState.preview = null;
    $('importResult').classList.add('hidden');
    $('importAppendBtn').disabled = true;
    $('importReplaceBtn').disabled = true;
    renderImportErrors(err);
  } finally {
    $('importFileMsg').textContent = '';
  }
}

function renderImportErrors(err, prefix = '预览失败，未写入任何内容：') {
  const errs = err.data && Array.isArray(err.data.errors) ? err.data.errors : [];
  let msg = `${prefix}${err.message}`;
  if (errs.length > 1) msg += `\n（共 ${errs.length} 处问题，以下列出前 20 条）`;
  const detail = errs.slice(0, 20).map((e) => `· ${e.message}`).join('\n');
  $('importError').textContent = detail ? `${msg}\n${detail}` : msg;
}

function renderImportPreview(data) {
  $('importError').textContent = '';
  $('importResult').classList.remove('hidden');

  const conflictBox = $('importConflictBox');
  if (data.conflicts.length) {
    conflictBox.classList.remove('hidden');
    $('importConflictList').innerHTML = data.conflicts.slice(0, 20)
      .map((c) => `<li>${esc(c.message)}</li>`).join('') +
      (data.conflicts.length > 20 ? `<li>… 其余 ${data.conflicts.length - 20} 条从略</li>` : '');
  } else {
    conflictBox.classList.add('hidden');
  }

  $('importSummary').innerHTML =
    `文件 <b>${esc(data.filename)}</b> 解析出 <b>${data.imported_count}</b> 个条目` +
    `（序号可不连续）；当前草稿 <b>${data.draft_count}</b> 段。` +
    (data.conflicts.length
      ? `<br><span class="warn">与草稿存在 ${data.conflicts.length} 处时间冲突 —— 追加被阻止，可改用替换。</span>`
      : '<br><span style="color:var(--ok)">与当前草稿无时间冲突，可直接追加。</span>');

  const shown = data.entries.slice(0, IMPORT_PREVIEW_LIMIT);
  $('importTbody').innerHTML = shown.map((e) => {
    const clash = data.conflicts.some((c) => c.entry === e.entry);
    return `
    <tr class="${clash ? 'import-conflict' : ''}">
      <td>${e.entry}</td>
      <td class="mono">${e.seq == null ? '(缺)' : e.seq}</td>
      <td class="mono">第 ${e.line} 行</td>
      <td class="mono">${fmtTime(e.start_ms)}<br>→ ${fmtTime(e.end_ms)}</td>
      <td class="seg-text-cell">${esc(e.text) || '<span class="meta">(空)</span>'}</td>
    </tr>`;
  }).join('');
  const hint = $('importMoreHint');
  if (data.entries.length > IMPORT_PREVIEW_LIMIT) {
    hint.classList.remove('hidden');
    hint.textContent = `仅显示前 ${IMPORT_PREVIEW_LIMIT} 条，共 ${data.entries.length} 条；确认时会整批写入。`;
  } else {
    hint.classList.add('hidden');
  }

  // 追加在有冲突时禁用；替换始终可用（条目已通过全部校验）
  $('importAppendBtn').disabled = data.append_blocked;
  $('importReplaceBtn').disabled = false;
}

async function confirmImport(mode) {
  if (importState.busy || !importState.preview) return;
  const p = importState.preview;
  if (mode === 'replace' &&
      !confirm(`替换将先删除当前草稿的全部 ${p.draft_count} 个片段，再写入导入的 ${p.imported_count} 个待审片段。\n已发布的历史版本不受影响。确定继续？`)) {
    return;
  }
  importState.busy = true;
  const btns = [$('importAppendBtn'), $('importReplaceBtn')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    const fd = new FormData();
    fd.append('srt', new Blob([importState.content], { type: 'text/plain' }), importState.filename || 'import.srt');
    fd.append('mode', mode);
    fd.append('token', p.token);
    const data = await api(`/api/videos/${state.video.id}/srt/import`, { method: 'POST', body: fd });
    state.segments = data.segments;
    closeImportModal();
    renderSegmentDependent();
    toast(`${mode === 'append' ? '已追加' : '已替换草稿并写入'} ${data.imported_count} 个待审片段`);
  } catch (err) {
    if (err.status === 409 && err.data && Array.isArray(err.data.current_segments)) {
      // 预览后草稿被修改：拒绝覆盖，自动用最新草稿重新预览同一份 SRT
      const changedMsg = `⚠️ ${err.message}`;
      state.segments = err.data.current_segments;
      renderSegmentDependent();
      try {
        const fd = new FormData();
        fd.append('srt', new Blob([importState.content], { type: 'text/plain' }), importState.filename || 'import.srt');
        const re = await api(`/api/videos/${state.video.id}/srt/preview`, { method: 'POST', body: fd });
        importState.preview = re;
        renderImportPreview(re);
      } catch (e2) {
        renderImportErrors(e2);
      }
      $('importError').textContent = `${changedMsg}\n已按最新草稿重新预览，请核对后再次操作。`;
      toast('预览后草稿发生了变化，请重新核对预览', true);
      return;
    }
    renderImportErrors(err, '确认失败，未写入任何内容：');
    // 422（如 SRT 内容变化）后恢复按钮可用性由预览状态决定
    if (importState.preview) {
      $('importAppendBtn').disabled = importState.preview.append_blocked;
      $('importReplaceBtn').disabled = false;
    }
  } finally {
    importState.busy = false;
  }
}

/* ================= 历史版本区间恢复 ================= */
const restoreState = { preview: null, busy: false };

function openRestoreModal() {
  restoreState.preview = null;
  restoreState.busy = false;
  const sel = $('restoreVersion');
  sel.innerHTML = state.publications.length
    ? state.publications
        .map((p) => `<option value="${p.version}">v${p.version}（${new Date(p.published_at).toLocaleString()}，${p.segment_count} 段）</option>`)
        .join('')
    : '<option value="">（尚无已发布版本）</option>';
  $('restoreStart').value = 0;
  $('restoreEnd').value = state.video.duration_ms;
  $('restoreError').textContent = '';
  $('restoreResult').classList.add('hidden');
  $('restoreConfirmBtn').disabled = true;
  $('restoreModal').classList.remove('hidden');
}
function closeRestoreModal() {
  $('restoreModal').classList.add('hidden');
}

// 版本或区间被改动后，旧预览令牌不再匹配，必须重新预览
function invalidateRestorePreview() {
  restoreState.preview = null;
  $('restoreResult').classList.add('hidden');
  $('restoreConfirmBtn').disabled = true;
}

function restoreParams() {
  return {
    version: Number($('restoreVersion').value),
    start_ms: Number($('restoreStart').value),
    end_ms: Number($('restoreEnd').value),
  };
}

async function previewRestore() {
  $('restoreError').textContent = '';
  invalidateRestorePreview();
  if (!state.publications.length) {
    $('restoreError').textContent = '该视频还没有已发布版本，请先在右侧「发布与下载」发布一个版本。';
    return;
  }
  try {
    const data = await api(`/api/videos/${state.video.id}/restore/preview`, { method: 'POST', body: restoreParams() });
    restoreState.preview = data;
    renderRestorePreview(data);
  } catch (err) {
    renderRestoreError(err, '预览失败：');
  }
}

function renderRestoreError(err, prefix) {
  const crossings = err.data && Array.isArray(err.data.crossings) ? err.data.crossings : [];
  let msg = `${prefix}${err.message}`;
  if (crossings.length > 1) msg += `\n（共 ${crossings.length} 处边界穿过，需全部调整）`;
  const detail = crossings.slice(0, 20).map((c) => `· ${c.message}`).join('\n');
  $('restoreError').textContent = detail ? `${msg}\n${detail}` : msg;
}

function renderRestorePreview(data) {
  $('restoreResult').classList.remove('hidden');
  $('restoreSummary').innerHTML =
    `将用发布版本 <b>v${data.version}</b> 在 <b>${fmtTime(data.start_ms)} → ${fmtTime(data.end_ms)}</b> 区间内的 ` +
    `<b>${data.to_restore.length}</b> 个片段，整体替换当前草稿该区间的 <b>${data.to_remove.length}</b> 个片段；` +
    '恢复片段均为<b>待审</b>新片段，区间外草稿片段与修订号不变。';
  $('restorePubTitle').textContent = `发布快照 v${data.version}（区间内 ${data.to_restore.length} 段，确认后恢复为待审）`;
  $('restorePubTbody').innerHTML = data.to_restore.length
    ? data.to_restore.map((e) => `
      <tr>
        <td class="mono">第 ${e.snapshot_index} 条</td>
        <td class="mono">${fmtTime(e.start_ms)}<br>→ ${fmtTime(e.end_ms)}</td>
        <td class="seg-text-cell">${esc(e.text) || '<span class="meta">(空)</span>'}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="meta">该区间内发布快照没有片段（确认后区间内草稿片段将被清空）。</td></tr>';
  $('restoreDraftTbody').innerHTML = data.to_remove.length
    ? data.to_remove.map((s) => `
      <tr>
        <td>${s.id}</td>
        <td class="mono">${fmtTime(s.start_ms)}<br>→ ${fmtTime(s.end_ms)}</td>
        <td class="seg-text-cell">${esc(s.text) || '<span class="meta">(空)</span>'}</td>
        <td>${s.reviewed ? '<span class="tag ok">已审</span>' : '<span class="tag warn">待审</span>'}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="meta">该区间内当前草稿没有片段。</td></tr>';
  $('restoreConfirmBtn').disabled = false;
}

async function confirmRestore() {
  if (restoreState.busy || !restoreState.preview) return;
  const p = restoreState.preview;
  if (!confirm(`确定用 v${p.version} 在 ${fmtTime(p.start_ms)} → ${fmtTime(p.end_ms)} 区间内的 ${p.to_restore.length} 个片段，` +
    `整体替换草稿该区间的 ${p.to_remove.length} 个片段？\n恢复片段均为待审；区间外草稿与历史发布版本不受影响。`)) {
    return;
  }
  restoreState.busy = true;
  $('restoreConfirmBtn').disabled = true;
  try {
    const data = await api(`/api/videos/${state.video.id}/restore/confirm`, {
      method: 'POST',
      body: { version: p.version, start_ms: p.start_ms, end_ms: p.end_ms, token: p.token },
    });
    state.segments = data.segments;
    closeRestoreModal();
    renderSegmentDependent();
    toast(`已恢复区间：移除 ${data.removed_count} 段、恢复 ${data.restored_count} 段（均为待审）`);
  } catch (err) {
    if (err.status === 409 && err.data && Array.isArray(err.data.current_segments)) {
      // 预览后草稿被修改：拒绝覆盖，按最新草稿自动重新预览同一版本与区间
      const changedMsg = `⚠️ ${err.message}`;
      state.segments = err.data.current_segments;
      renderSegmentDependent();
      try {
        const re = await api(`/api/videos/${state.video.id}/restore/preview`, {
          method: 'POST',
          body: { version: p.version, start_ms: p.start_ms, end_ms: p.end_ms },
        });
        restoreState.preview = re;
        renderRestorePreview(re);
        $('restoreError').textContent = `${changedMsg}\n已按最新草稿重新预览，请核对后再次确认。`;
      } catch (e2) {
        invalidateRestorePreview();
        renderRestoreError(e2, '草稿已变化，按相同条件重新预览失败：');
      }
      toast('预览后草稿发生了变化，请重新核对预览', true);
      return;
    }
    renderRestoreError(err, '确认失败，未写入任何内容：');
    if (restoreState.preview) $('restoreConfirmBtn').disabled = false;
  } finally {
    restoreState.busy = false;
  }
}

/* ================= 多片段整体平移 ================= */
function openShiftModal() {
  syncShiftSelected();
  shiftState.preview = null;
  shiftState.busy = false;
  $('shiftOffset').value = '';
  $('shiftError').textContent = '';
  $('shiftResult').classList.add('hidden');
  $('shiftConfirmBtn').disabled = true;
  renderShiftHeader();
  $('shiftModal').classList.remove('hidden');
}
function closeShiftModal() {
  $('shiftModal').classList.add('hidden');
}
function invalidateShiftPreview() {
  shiftState.preview = null;
  $('shiftResult').classList.add('hidden');
  $('shiftConfirmBtn').disabled = true;
}
function renderShiftHeader() {
  $('shiftSelCount').textContent = state.shiftSelected.size;
}
function shiftParams() {
  return {
    segment_ids: [...state.shiftSelected].sort((a, b) => a - b),
    offset_ms: Number($('shiftOffset').value),
  };
}

async function previewShift() {
  $('shiftError').textContent = '';
  invalidateShiftPreview();
  renderShiftHeader();
  if (!state.shiftSelected.size) {
    $('shiftError').textContent = '请先在片段表中勾选要整体平移的片段（表头复选框可全选）。';
    return;
  }
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/shift/preview`, {
      method: 'POST',
      body: shiftParams(),
    });
    shiftState.preview = data;
    renderShiftPreview(data);
  } catch (err) {
    $('shiftError').textContent = `预览失败，未写入任何内容：${err.message}`;
  }
}

function renderShiftIssueList(preview) {
  const box = $('shiftIssueBox');
  const issues = [
    ...preview.boundary_issues.map((x) => ({ message: x.message })),
    ...preview.conflicts.map((x) => ({ message: x.message })),
  ];
  if (!issues.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  $('shiftIssueList').innerHTML = issues.slice(0, 30)
    .map((x) => `<li>${esc(x.message)}</li>`).join('') +
    (issues.length > 30 ? `<li>… 其余 ${issues.length - 30} 条从略</li>` : '');
}

function renderShiftPreview(data) {
  $('shiftResult').classList.remove('hidden');
  const dir = data.offset_ms > 0 ? `延后 +${data.offset_ms}` : `提前 ${data.offset_ms}`;
  $('shiftSummary').innerHTML =
    `将把 <b>${data.selected_count}</b> 个所选片段整体<b>${dir}ms</b>（相对间距不变，未选 ${data.unselected_count} 段不动）。` +
    (data.blocked
      ? '<br><span class="warn">存在越界或重叠，确认会被拒绝且不写入；请调整后重新预览。</span>'
      : '<br><span style="color:var(--ok)">全部落在视频边界内且不与未选片段重叠（端点相接允许），可以确认应用。</span>');
  renderShiftIssueList(data);
  const clashIds = new Set(data.conflicts.map((c) => c.segment_id));
  const boundIds = new Set(data.boundary_issues.map((x) => x.segment_id));
  $('shiftTbody').innerHTML = data.moved.map((m) => `
    <tr class="${clashIds.has(m.segment_id) || boundIds.has(m.segment_id) ? 'import-conflict' : ''}">
      <td>${m.segment_id}</td>
      <td class="mono">${fmtTime(m.before_start_ms)}<br>→ ${fmtTime(m.before_end_ms)}</td>
      <td class="mono">${fmtTime(m.after_start_ms)}<br>→ ${fmtTime(m.after_end_ms)}</td>
      <td class="seg-text-cell">${esc(m.text) || '<span class="meta">(空)</span>'}</td>
      <td>${m.reviewed ? '<span class="tag ok">已审→待审</span>' : '<span class="tag warn">待审</span>'}
          <div class="mono">rev ${m.revision} → ${m.revision + 1}</div></td>
    </tr>`).join('');
  $('shiftConfirmBtn').disabled = data.blocked;
}

async function confirmShift() {
  if (shiftState.busy || !shiftState.preview) return;
  const p = shiftState.preview;
  if (!confirm(`确定把勾选的 ${p.moved.length} 个片段整体${p.offset_ms > 0 ? '延后' : '提前'} ${Math.abs(p.offset_ms)}ms？\n` +
    '所选片段修订号将逐段 +1 并撤销原文审校；其译文保留文字但标记失效，须按新时间重新校对；未选片段不动。')) {
    return;
  }
  shiftState.busy = true;
  $('shiftConfirmBtn').disabled = true;
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/shift/confirm`, {
      method: 'POST',
      body: {
        segment_ids: p.moved.map((m) => m.segment_id).sort((a, b) => a - b),
        offset_ms: p.offset_ms,
        token: p.token,
      },
    });
    state.segments = data.segments;
    state.translations = data.translations || [];
    syncShiftSelected();
    closeShiftModal();
    renderSegmentDependent();
    toast(`已整体平移 ${data.moved_count} 个片段：原文待重新审校，译文已按新时间标记失效`);
  } catch (err) {
    if (err.status === 409 && err.data && Array.isArray(err.data.current_segments)) {
      // 预览后草稿被修改：拒绝写入，按最新草稿以相同选择与偏移自动重新预览
      const changedMsg = `⚠️ ${err.message}`;
      state.segments = err.data.current_segments;
      renderSegmentDependent();
      renderShiftHeader();
      try {
        const re = await api(`/api/videos/${state.video.id}/segments/shift/preview`, {
          method: 'POST',
          body: { segment_ids: [...state.shiftSelected].sort((a, b) => a - b), offset_ms: shiftState.preview ? shiftState.preview.offset_ms : Number($('shiftOffset').value) },
        });
        shiftState.preview = re;
        renderShiftPreview(re);
        $('shiftError').textContent = `${changedMsg}\n已按最新草稿重新预览，请核对后再次确认。`;
      } catch (e2) {
        invalidateShiftPreview();
        $('shiftError').textContent = `${changedMsg}\n按相同条件重新预览失败：${e2.message}`;
      }
      toast('预览后草稿发生了变化，请重新核对预览', true);
      return;
    }
    $('shiftError').textContent = `确认失败，未写入任何内容：${err.message}`;
    if (shiftState.preview) $('shiftConfirmBtn').disabled = shiftState.preview.blocked;
  } finally {
    shiftState.busy = false;
  }
}

/* ================= 弹窗事件绑定 ================= */
document.addEventListener('click', (e) => {
  const menu = $('downloadMenu');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'downloadBtn') {
    menu.classList.add('hidden');
  }
});
$('editorCancel').addEventListener('click', closeEditor);
$('editorSave').addEventListener('click', saveEditor);
$('editStartNow').addEventListener('click', () => { $('editStart').value = currentMs(); });
$('editEndNow').addEventListener('click', () => { $('editEnd').value = currentMs(); });
$('editorModal').addEventListener('click', (e) => { if (e.target === $('editorModal')) closeEditor(); });
$('splitCancel').addEventListener('click', closeSplitModal);
$('splitSave').addEventListener('click', saveSplit);
$('splitCutNow').addEventListener('click', () => { $('splitCut').value = currentMs(); });
$('splitModal').addEventListener('click', (e) => { if (e.target === $('splitModal')) closeSplitModal(); });
$('importCancel').addEventListener('click', closeImportModal);
$('importPreviewBtn').addEventListener('click', previewImport);
$('importAppendBtn').addEventListener('click', () => confirmImport('append'));
$('importReplaceBtn').addEventListener('click', () => confirmImport('replace'));
$('importModal').addEventListener('click', (e) => { if (e.target === $('importModal')) closeImportModal(); });
$('importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  $('importFileMsg').textContent = f ? `已选择 ${f.name}（${(f.size / 1024).toFixed(1)} KB），点击「解析并预览」` : '';
});
$('restoreCancel').addEventListener('click', closeRestoreModal);
$('restorePreviewBtn').addEventListener('click', previewRestore);
$('restoreConfirmBtn').addEventListener('click', confirmRestore);
$('restoreModal').addEventListener('click', (e) => { if (e.target === $('restoreModal')) closeRestoreModal(); });
['restoreVersion', 'restoreStart', 'restoreEnd'].forEach((id) => {
  $(id).addEventListener('input', invalidateRestorePreview);
  $(id).addEventListener('change', invalidateRestorePreview);
});
$('trCancel').addEventListener('click', closeTrEditor);
$('trSave').addEventListener('click', saveTrEditor);
$('trModal').addEventListener('click', (e) => { if (e.target === $('trModal')) closeTrEditor(); });
$('shiftCancel').addEventListener('click', closeShiftModal);
$('shiftPreviewBtn').addEventListener('click', previewShift);
$('shiftConfirmBtn').addEventListener('click', confirmShift);
$('shiftOffset').addEventListener('input', invalidateShiftPreview);
$('shiftModal').addEventListener('click', (e) => { if (e.target === $('shiftModal')) closeShiftModal(); });
$('qcWaiverCancel').addEventListener('click', closeQcWaiver);
$('qcWaiverSave').addEventListener('click', saveQcWaiver);
$('qcWaiverModal').addEventListener('click', (e) => { if (e.target === $('qcWaiverModal')) closeQcWaiver(); });
$('qcPubClose').addEventListener('click', () => $('qcPubModal').classList.add('hidden'));
$('qcPubModal').addEventListener('click', (e) => { if (e.target === $('qcPubModal')) $('qcPubModal').classList.add('hidden'); });

/* ================= 启动 ================= */
loadList().catch((e) => {
  app.innerHTML = `<div class="card"><h2>加载失败</h2><p class="error">${esc(e.message)}</p></div>`;
});
