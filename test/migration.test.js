'use strict';

// 版本化结构迁移测试（不依赖外部框架）：
//  1. 新建空库启动后达到当前结构并登记全部版本
//  2. 旧库（缺新表/新列）首次升级：识别既有结构、补全缺失结构，数据不丢失
//  3. 当前结构库首次升级：仅登记不改动，视频/字幕/译文/质检/发布快照全量保留
//  4. 重复初始化幂等：版本只登记一次
//  5. 多进程同时初始化同一新库：同一升级只生效一次
//  6. 多进程同时升级同一旧库：同一升级只生效一次
//  7. 迁移失败：该版本结构与登记一并回滚，句柄保持未初始化
//  8. 服务进程在迁移失败时中止启动且不监听端口
//  9. 升级后的旧库：HTTP API 行为与既有数据不变
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-desk-migration-'));

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

// 每个场景使用全新的 db 模块实例（模块级单例不串场）
function loadFreshDbModule() {
  const resolved = require.resolve('../src/db');
  delete require.cache[resolved];
  return require(resolved);
}

function tableNames(d) {
  return d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name);
}
function indexNames(d) {
  return d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name);
}
function columnNames(d, table) {
  return d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function migrationRows(d) {
  return d.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
}

const EXPECT_TABLES = ['publications', 'qc_rules', 'qc_waivers', 'schema_migrations',
  'segments', 'speakers', 'translations', 'videos'];
const EXPECT_INDEXES = ['idx_publications_video', 'idx_qc_waivers_video', 'idx_segments_speaker',
  'idx_segments_video', 'idx_speakers_video', 'idx_translations_video'];
const EXPECT_MIGRATIONS = [
  [1, 'baseline-tables'],
  [2, 'translation-track-columns'],
  [3, 'qc-snapshot-columns'],
  [4, 'speaker-columns'],
];

function checkCurrentSchema(d, label) {
  eq(`${label}：表集合`, tableNames(d), EXPECT_TABLES);
  eq(`${label}：索引集合`, indexNames(d), EXPECT_INDEXES);
  check(`${label}：videos 含 translation_lang/speakers_revision`,
    columnNames(d, 'videos').includes('translation_lang') && columnNames(d, 'videos').includes('speakers_revision'));
  check(`${label}：segments 含 speaker_id`, columnNames(d, 'segments').includes('speaker_id'));
  const pubCols = columnNames(d, 'publications');
  check(`${label}：publications 含全部快照列`,
    ['translation_snapshot', 'translation_lang', 'qc_rules_snapshot', 'qc_report_snapshot', 'speaker_snapshot']
      .every((c) => pubCols.includes(c)));
  eq(`${label}：迁移登记`, migrationRows(d).map((r) => [r.version, r.name]), EXPECT_MIGRATIONS);
}

// 构造「译文轨道上线前」的旧库：仅 videos/segments/publications 基础表，无后续列与后续表
function createLegacyDb(dbPath) {
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE videos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      storage_name  TEXT    NOT NULL,
      original_name TEXT    NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL,
      duration_ms   INTEGER NOT NULL CHECK (duration_ms > 0),
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE segments (
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
    CREATE INDEX idx_segments_video ON segments(video_id, start_ms);
    CREATE TABLE publications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id     INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      version      INTEGER NOT NULL,
      snapshot     TEXT    NOT NULL,
      segment_count INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      UNIQUE (video_id, version)
    );
    CREATE INDEX idx_publications_video ON publications(video_id, version);
  `);
  d.prepare(`INSERT INTO videos (title, storage_name, original_name, mime_type, size_bytes, duration_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('旧库视频', 'legacy-video.mp4', '旧库视频.mp4', 'video/mp4', 256, 10000, 1700000000000);
  const seg = d.prepare(`INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, updated_at)
                         VALUES (1, ?, ?, ?, ?, ?, ?)`);
  seg.run(1000, 2000, '旧字幕一', 1, 3, 1700000001000);
  seg.run(3000, 4000, '旧字幕二', 0, 1, 1700000002000);
  d.prepare('INSERT INTO publications (video_id, version, snapshot, segment_count, published_at) VALUES (1, 1, ?, 2, ?)')
    .run(JSON.stringify([
      { start_ms: 1000, end_ms: 2000, text: '旧字幕一' },
      { start_ms: 3000, end_ms: 4000, text: '旧字幕二' },
    ]), 1700000003000);
  d.close();
}

function checkLegacyDataPreserved(d, label) {
  const video = d.prepare('SELECT * FROM videos WHERE id = 1').get();
  eq(`${label}：视频行保留`, [video.title, video.duration_ms, video.created_at], ['旧库视频', 10000, 1700000000000]);
  eq(`${label}：新列默认值`, [video.translation_lang, video.speakers_revision], [null, 0]);
  const segs = d.prepare('SELECT * FROM segments WHERE video_id = 1 ORDER BY start_ms').all();
  eq(`${label}：字幕行保留`, segs.map((s) => [s.start_ms, s.end_ms, s.text, s.reviewed, s.revision, s.speaker_id]),
    [[1000, 2000, '旧字幕一', 1, 3, null], [3000, 4000, '旧字幕二', 0, 1, null]]);
  const pub = d.prepare('SELECT * FROM publications WHERE video_id = 1 AND version = 1').get();
  eq(`${label}：发布快照保留`, [JSON.parse(pub.snapshot), pub.segment_count, pub.published_at],
    [[{ start_ms: 1000, end_ms: 2000, text: '旧字幕一' }, { start_ms: 3000, end_ms: 4000, text: '旧字幕二' }],
      2, 1700000003000]);
  eq(`${label}：发布新快照列为空`, [pub.translation_snapshot, pub.translation_lang, pub.qc_rules_snapshot,
    pub.qc_report_snapshot, pub.speaker_snapshot], [null, null, null, null, null]);
}

/* ---------- 1. 新建空库 ---------- */
function testFreshDatabase() {
  console.log('1. 新建空库：启动后达到当前结构');
  const dbPath = path.join(tmpDir, 'fresh.db');
  loadFreshDbModule().init(dbPath);
  const d = new Database(dbPath, { readonly: true });
  checkCurrentSchema(d, '新库');
  check('新库：各业务表为空', ['videos', 'segments', 'speakers', 'publications', 'translations', 'qc_rules', 'qc_waivers']
    .every((t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n === 0));
  d.close();
}

/* ---------- 2. 旧库升级（建表 + 补列路径） ---------- */
function testLegacyDatabaseUpgrade() {
  console.log('2. 旧库首次升级：识别既有结构、补全缺失、数据保留');
  const dbPath = path.join(tmpDir, 'legacy.db');
  createLegacyDb(dbPath);
  loadFreshDbModule().init(dbPath);
  const d = new Database(dbPath, { readonly: true });
  checkCurrentSchema(d, '旧库');
  checkLegacyDataPreserved(d, '旧库');
  check('旧库：新表已建且为空', ['speakers', 'translations', 'qc_rules', 'qc_waivers']
    .every((t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n === 0));
  d.close();
  return dbPath;
}

/* ---------- 3. 当前结构库：仅登记，全量数据保留 ---------- */
function testCurrentDatabaseRegistration() {
  console.log('3. 当前结构库首次升级：识别并登记既有结构，全量数据保留');
  const dbPath = path.join(tmpDir, 'current.db');
  // 用应用自身初始化出当前结构，再写入覆盖全部实体类型的数据
  loadFreshDbModule().init(dbPath);
  const w = new Database(dbPath);
  w.pragma('foreign_keys = ON');
  w.prepare(`INSERT INTO videos (title, storage_name, original_name, mime_type, size_bytes, duration_ms,
               translation_lang, speakers_revision, created_at)
             VALUES ('全量视频', 'full.mp4', '全量视频.mp4', 'video/mp4', 128, 8000, 'en', 2, 1700000100000)`).run();
  w.prepare(`INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, speaker_id, updated_at)
             VALUES (1, 1000, 2000, '原文一', 1, 2, NULL, 1700000101000)`).run();
  w.prepare(`INSERT INTO speakers (video_id, name, created_at, updated_at) VALUES (1, '主持人', 1700000102000, 1700000102000)`).run();
  w.prepare(`UPDATE segments SET speaker_id = 1 WHERE id = 1`).run();
  w.prepare(`INSERT INTO translations (video_id, segment_id, text, reviewed, revision,
               source_start_ms, source_end_ms, source_text, created_at, updated_at)
             VALUES (1, 1, 'First', 1, 1, 1000, 2000, '原文一', 1700000103000, 1700000103000)`).run();
  w.prepare(`INSERT INTO qc_rules (video_id, source_max_cps, source_max_line_chars,
               translation_max_cps, translation_max_line_chars, revision, updated_at)
             VALUES (1, 15.0, 42, 20.0, 84, 3, 1700000104000)`).run();
  w.prepare(`INSERT INTO qc_waivers (video_id, segment_id, track, rule, language, reason, active,
               bound_start_ms, bound_end_ms, bound_text, bound_rules_revision,
               bound_source_max_cps, bound_source_max_line_chars,
               bound_translation_max_cps, bound_translation_max_line_chars, created_at, revoked_at)
             VALUES (1, 1, 'source', 'max_cps', NULL, '片头快语速', 0, 1000, 2000, '原文一', 2,
                     15.0, 42, NULL, NULL, 1700000105000, 1700000106000)`).run();
  w.prepare(`INSERT INTO publications (video_id, version, snapshot, translation_snapshot, translation_lang,
               qc_rules_snapshot, qc_report_snapshot, speaker_snapshot, segment_count, published_at)
             VALUES (1, 1, ?, ?, 'en', ?, ?, ?, 1, 1700000107000)`)
    .run(
      JSON.stringify([{ start_ms: 1000, end_ms: 2000, text: '原文一' }]),
      JSON.stringify([{ start_ms: 1000, end_ms: 2000, text: 'First' }]),
      JSON.stringify({ revision: 3, source: { max_cps: 15, max_line_chars: 42 } }),
      JSON.stringify({ configured: true, violations: [] }),
      JSON.stringify({ list_revision: 2, speakers: [{ id: 1, name: '主持人' }], assignments: [{ segment_id: 1, speaker_id: 1 }] })
    );
  // 升级前删除登记表演绎「由旧版本应用创建的库」
  w.exec('DROP TABLE schema_migrations');
  const before = {
    videos: w.prepare('SELECT * FROM videos').all(),
    segments: w.prepare('SELECT * FROM segments').all(),
    speakers: w.prepare('SELECT * FROM speakers').all(),
    translations: w.prepare('SELECT * FROM translations').all(),
    qc_rules: w.prepare('SELECT * FROM qc_rules').all(),
    qc_waivers: w.prepare('SELECT * FROM qc_waivers').all(),
    publications: w.prepare('SELECT * FROM publications').all(),
  };
  w.close();

  loadFreshDbModule().init(dbPath);

  const d = new Database(dbPath, { readonly: true });
  checkCurrentSchema(d, '当前结构库');
  for (const t of Object.keys(before)) {
    eq(`当前结构库：${t} 数据不变`, d.prepare(`SELECT * FROM ${t}`).all(), before[t]);
  }
  d.close();
}

/* ---------- 4. 重复初始化幂等 ---------- */
function testReinitIdempotent() {
  console.log('4. 重复初始化：版本只登记一次，数据不变');
  const dbPath = path.join(tmpDir, 'legacy.db'); // 场景 2 已升级的库
  loadFreshDbModule().init(dbPath);
  const d = new Database(dbPath, { readonly: true });
  eq('重复初始化后登记仍为一版一行', migrationRows(d).map((r) => [r.version, r.name]), EXPECT_MIGRATIONS);
  checkLegacyDataPreserved(d, '重复初始化');
  d.close();
}

/* ---------- 5/6. 多进程并发：同一升级只生效一次 ---------- */
function runChildInit(dbPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '-e', `require(${JSON.stringify(path.join(ROOT, 'src', 'db'))}).init(process.argv[1])`, dbPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

async function testConcurrentInit(label, dbPath, prepare) {
  console.log(label);
  prepare(dbPath);
  const results = await Promise.all([0, 1, 2, 3].map(() => runChildInit(dbPath)));
  check('全部进程初始化成功', results.every((r) => r.code === 0),
    results.map((r) => `code=${r.code} ${r.out}`).join(' | ').slice(0, 400));
  const d = new Database(dbPath, { readonly: true });
  eq('每个版本只登记一次', migrationRows(d).map((r) => [r.version, r.name]), EXPECT_MIGRATIONS);
  checkCurrentSchema(d, '并发库');
  return d;
}

/* ---------- 7. 迁移失败回滚 ---------- */
function testFailureRollback() {
  console.log('7. 迁移失败：该版本结构与登记一并回滚');
  const dbPath = path.join(tmpDir, 'broken.db');
  // 预置缺列的登记表，使 v1 的登记 INSERT 失败（建表之后、提交之前）
  const seed = new Database(dbPath);
  seed.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)');
  seed.close();

  const dbModule = loadFreshDbModule();
  let err = null;
  try { dbModule.init(dbPath); } catch (e) { err = e; }
  check('init 抛出迁移失败错误', !!err && /v1/.test(err.message) && /失败/.test(err.message), err && err.message);

  let getErr = null;
  try { dbModule.get(); } catch (e) { getErr = e; }
  check('失败后 get() 拒绝提供访问', !!getErr && /尚未初始化/.test(getErr.message), getErr && getErr.message);

  const d = new Database(dbPath, { readonly: true });
  check('v1 建表已回滚（videos 不存在）', !tableNames(d).includes('videos'), tableNames(d).join(','));
  eq('登记表无残留登记行', d.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
  d.close();

  // 修复登记表后可重新升级：证明回滚干净、无半成品结构
  const fix = new Database(dbPath);
  fix.exec('DROP TABLE schema_migrations');
  fix.close();
  loadFreshDbModule().init(dbPath);
  const d2 = new Database(dbPath, { readonly: true });
  checkCurrentSchema(d2, '修复后重升');
  d2.close();
}

/* ---------- 8. 服务进程在迁移失败时中止启动 ---------- */
function testServerAbortsOnMigrationFailure() {
  console.log('8. 迁移失败时服务进程退出且不监听端口');
  return new Promise((resolve) => {
    const dbPath = path.join(tmpDir, 'server-broken.db');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)');
    seed.close();

    const port = 8791;
    const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOAD_DIR: path.join(tmpDir, 'videos-broken') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (c) => { out += c; });
    server.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => { server.kill(); finish(-1); }, 15000);
    server.on('exit', (code) => { clearTimeout(timer); finish(code); });

    async function finish(code) {
      check('服务进程非零退出', code !== 0 && code !== null, `退出码 ${code}；输出：${out.slice(0, 300)}`);
      check('输出说明升级失败中止启动', /启动中止/.test(out) && /失败/.test(out), out.slice(0, 300));
      let reachable = false;
      try { await fetch(`http://127.0.0.1:${port}/api/videos`); reachable = true; } catch (_) { /* 预期不可达 */ }
      check('端口未提供请求服务', !reachable);
      resolve();
    }
  });
}

/* ---------- 9. 升级后的旧库：HTTP API 行为不变 ---------- */
async function testHttpBehaviorOnUpgradedLegacy(dbPath) {
  console.log('9. 升级后的旧库：HTTP API 行为与既有数据不变');
  const port = 8790;
  const base = `http://127.0.0.1:${port}/api`;
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOAD_DIR: path.join(tmpDir, 'videos-legacy') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  server.stdout.on('data', (c) => { serverOut += c; });
  server.stderr.on('data', (c) => { serverOut += c; });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { up = (await fetch(`${base}/videos`)).ok; } catch (_) { await new Promise((r) => setTimeout(r, 250)); }
    }
    check('服务在升级后的旧库上启动', up, serverOut.slice(0, 300));

    let r = await fetch(`${base}/videos`);
    let j = await r.json();
    eq('视频列表返回旧库视频', j.videos.map((v) => [v.id, v.title, v.duration_ms]), [[1, '旧库视频', 10000]]);

    r = await fetch(`${base}/videos/1`);
    j = await r.json();
    eq('详情返回旧字幕与修订号', j.segments.map((s) => [s.start_ms, s.end_ms, s.text, s.reviewed, s.revision, s.speaker_id]),
      [[1000, 2000, '旧字幕一', true, 3, null], [3000, 4000, '旧字幕二', false, 1, null]]);
    eq('详情返回旧发布版本', j.publications.map((p) => [p.version, p.has_translation, p.has_qc, p.has_speakers]),
      [[1, false, false, false]]);
    eq('详情返回空名单与空译文', [j.speakers, j.translations, j.translation_lang], [[], [], null]);

    r = await fetch(`${base}/videos/1/srt?version=1`);
    let text = await r.text();
    check('历史版本 SRT 可导出且内容不变',
      r.status === 200 && /1\n00:00:01,000 --> 00:00:02,000\n旧字幕一/.test(text) && /旧字幕二/.test(text), text);
    r = await fetch(`${base}/videos/1/srt?version=draft`);
    text = await r.text();
    check('草稿 SRT 内容不变', r.status === 200 && /旧字幕一/.test(text) && /旧字幕二/.test(text), text);

    // 升级后的库支撑全部现有写路径
    r = await fetch(`${base}/videos/1/segments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_ms: 5000, end_ms: 6000, text: '新句' }),
    });
    j = await r.json();
    check('新增片段 201', r.status === 201, JSON.stringify(j));
    const newSegId = j.segment.id;

    r = await fetch(`${base}/videos/1/translation/track`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en' }),
    });
    check('启用译文轨道 201', r.status === 201, JSON.stringify(await r.clone().json().catch(() => null)));
    r = await fetch(`${base}/videos/1/segments/${newSegId}/translation`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'New sentence', segment_revision: 1 }),
    });
    check('录入译文 201', r.status === 201, JSON.stringify(await r.clone().json().catch(() => null)));
    r = await fetch(`${base}/videos/1/qc/rules`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_max_cps: 10, rules_revision: 0 }),
    });
    check('配置质检规则 200', r.status === 200, JSON.stringify(await r.clone().json().catch(() => null)));
    r = await fetch(`${base}/videos/1/speakers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '主持人', list_revision: 0 }),
    });
    check('新增说话人 201', r.status === 201, JSON.stringify(await r.clone().json().catch(() => null)));

    // 既有数据仍未被改动
    r = await fetch(`${base}/videos/1`);
    j = await r.json();
    check('旧片段保持原样', j.segments.some((s) => s.text === '旧字幕一' && s.revision === 3 && s.reviewed === true));
    check('旧发布版本仍只有一个', j.publications.length === 1 && j.publications[0].version === 1);
  } finally {
    server.kill();
  }
}

async function main() {
  testFreshDatabase();
  const legacyDb = testLegacyDatabaseUpgrade();
  testCurrentDatabaseRegistration();
  testReinitIdempotent();

  const d1 = await testConcurrentInit('5. 多进程同时初始化同一新库：同一升级只生效一次',
    path.join(tmpDir, 'concurrent-fresh.db'), () => {});
  d1.close();
  const d2 = await testConcurrentInit('6. 多进程同时升级同一旧库：同一升级只生效一次',
    path.join(tmpDir, 'concurrent-legacy.db'), createLegacyDb);
  checkLegacyDataPreserved(d2, '并发旧库');
  d2.close();

  testFailureRollback();
  await testServerAbortsOnMigrationFailure();
  await testHttpBehaviorOnUpgradedLegacy(legacyDb);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('迁移测试运行失败:', e);
  process.exit(1);
}).finally(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
