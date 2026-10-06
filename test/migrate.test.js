'use strict';

// 版本化升级流程测试（不依赖外部框架）：
// 1. 空库顺序升级到当前结构；重复启动不重复执行
// 2. 各代旧库首次升级：识别并登记已有结构，缺什么补什么，不重建、不丢数据
// 3. 多进程同时启动：同一升级只生效一次（up 恰好一次）
// 4. 升级失败：该版本结构与登记同事务回滚；随后重试可成功
// 5. 服务进程遇升级失败不监听端口、退出码非零；升级完成前 isReady 不放行
// 6. 旧库升级后 HTTP API 行为与数据保持不变
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { migrate } = require('../src/migrate');
const { migrations } = require('../src/migrations');
const { init, get, isReady, getMigrationInfo, close } = require('../src/db');

const root = path.join(__dirname, '..');
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

const dirs = [];
function newDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sd-mig-${label}-`));
  dirs.push(dir);
  return path.join(dir, 'app.db');
}
function openRaw(dbPath) {
  const conn = new Database(dbPath);
  conn.pragma('foreign_keys = ON');
  return conn;
}
function tableNames(conn) {
  return new Set(
    conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );
}
function columns(conn, table) {
  return conn.prepare(`PRAGMA table_info(${table})`).all();
}
function colNames(conn, table) {
  return columns(conn, table).map((c) => c.name);
}
function registry(conn) {
  return conn.prepare('SELECT version, name, applied_kind FROM schema_migrations ORDER BY version').all();
}

// ---- 各代旧库结构（对应旧版本 init() 建出来的库，无 schema_migrations）----

const V1_SCHEMA = `
  CREATE TABLE videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, storage_name TEXT NOT NULL,
    original_name TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0), created_at INTEGER NOT NULL
  );
  CREATE TABLE segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0), end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    text TEXT NOT NULL DEFAULT '', reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, UNIQUE (video_id, id)
  );
  CREATE INDEX idx_segments_video ON segments(video_id, start_ms);
  CREATE TABLE publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, snapshot TEXT NOT NULL, segment_count INTEGER NOT NULL,
    published_at INTEGER NOT NULL, UNIQUE (video_id, version)
  );
  CREATE INDEX idx_publications_video ON publications(video_id, version);
`;

function buildV1(dbPath, withData) {
  const conn = openRaw(dbPath);
  conn.exec(V1_SCHEMA);
  if (withData) {
    conn.prepare('INSERT INTO videos (id,title,storage_name,original_name,mime_type,size_bytes,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(1, '旧库视频', 'stored.bin', 'old.mp4', 'video/mp4', 1234, 60000, 1000);
    conn.prepare('INSERT INTO segments (id,video_id,start_ms,end_ms,text,reviewed,revision,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(1, 1, 0, 1500, '旧字幕', 1, 3, 2000);
    conn.prepare('INSERT INTO publications (id,video_id,version,snapshot,segment_count,published_at) VALUES (?,?,?,?,?,?)')
      .run(1, 1, 1, '[{"start_ms":0,"end_ms":1500,"text":"旧字幕"}]', 1, 3000);
  }
  conn.close();
}

function buildV2(dbPath) {
  buildV1(dbPath, false);
  const conn = openRaw(dbPath);
  conn.exec('ALTER TABLE videos ADD COLUMN translation_lang TEXT');
  conn.exec(`
    CREATE TABLE translations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE, text TEXT NOT NULL DEFAULT '',
      reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)), revision INTEGER NOT NULL DEFAULT 1,
      source_start_ms INTEGER NOT NULL, source_end_ms INTEGER NOT NULL, source_text TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (video_id, segment_id)
    );
    CREATE INDEX idx_translations_video ON translations(video_id);
  `);
  conn.close();
}

function buildV3(dbPath) {
  buildV2(dbPath);
  const conn = openRaw(dbPath);
  conn.exec(`
    CREATE TABLE qc_rules (
      video_id INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
      source_max_cps REAL, source_max_line_chars INTEGER, translation_max_cps REAL,
      translation_max_line_chars INTEGER, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    CREATE TABLE qc_waivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      track TEXT NOT NULL CHECK (track IN ('source', 'translation')),
      rule TEXT NOT NULL CHECK (rule IN ('max_cps', 'max_line_chars')),
      language TEXT, reason TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      bound_start_ms INTEGER NOT NULL, bound_end_ms INTEGER NOT NULL, bound_text TEXT NOT NULL,
      bound_rules_revision INTEGER NOT NULL, bound_source_max_cps REAL, bound_source_max_line_chars INTEGER,
      bound_translation_max_cps REAL, bound_translation_max_line_chars INTEGER,
      created_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE INDEX idx_qc_waivers_video ON qc_waivers(video_id, segment_id);
  `);
  conn.close();
}

// 旧版应用最后一代结构：建表 + 补列全部完成（升级前线上库的典型形态）
function buildV4FullLegacy(dbPath) {
  buildV3(dbPath);
  const conn = openRaw(dbPath);
  conn.exec(`
    CREATE TABLE speakers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (video_id, name)
    );
    CREATE INDEX idx_speakers_video ON speakers(video_id, id);
  `);
  conn.exec('ALTER TABLE segments ADD COLUMN speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL');
  conn.exec('CREATE INDEX idx_segments_speaker ON segments(speaker_id)');
  conn.exec('ALTER TABLE videos ADD COLUMN speakers_revision INTEGER NOT NULL DEFAULT 0');
  conn.exec('ALTER TABLE publications ADD COLUMN translation_snapshot TEXT');
  conn.exec('ALTER TABLE publications ADD COLUMN translation_lang TEXT');
  conn.exec('ALTER TABLE publications ADD COLUMN qc_rules_snapshot TEXT');
  conn.exec('ALTER TABLE publications ADD COLUMN qc_report_snapshot TEXT');
  conn.exec('ALTER TABLE publications ADD COLUMN speaker_snapshot TEXT');
  conn.close();
}

// 中间形态：v1 库只补了部分列（模拟旧应用补列过程中断/被打断）
function buildPartialLegacy(dbPath) {
  buildV1(dbPath, false);
  const conn = openRaw(dbPath);
  conn.exec('ALTER TABLE videos ADD COLUMN translation_lang TEXT'); // v2 做了一半：列有了，translations 表没有
  conn.exec('ALTER TABLE publications ADD COLUMN speaker_snapshot TEXT'); // v4 的列零星存在
  conn.close();
}

function runWorker(dbPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'migrate-worker.js'), dbPath, ...args], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('exit', (code) => {
      let parsed = null;
      try { parsed = out ? JSON.parse(out) : null; } catch (_) { parsed = null; }
      resolve({ code, out: parsed, raw: out, stderr: errOut });
    });
  });
}

async function tests() {
  // ---------- 1. 空库顺序升级 ----------
  console.log('1. 空库顺序升级到当前结构');
  {
    const dbPath = newDbPath('fresh');
    init(dbPath);
    const info = getMigrationInfo();
    const conn = get();
    eq('返回当前版本 v4', info.currentVersion, 4);
    const regs = registry(conn);
    eq('登记 4 个版本', regs.map((r) => r.version), [1, 2, 3, 4]);
    check('空库全部为执行升级(up)', regs.every((r) => r.applied_kind === 'up'), JSON.stringify(regs));
    const tables = tableNames(conn);
    for (const t of ['videos', 'segments', 'publications', 'translations', 'qc_rules', 'qc_waivers', 'speakers']) {
      check(`表存在: ${t}`, tables.has(t));
    }
    check('segments.speaker_id 存在', colNames(conn, 'segments').includes('speaker_id'));
    check('videos 译文/名单列存在',
      ['translation_lang', 'speakers_revision'].every((c) => colNames(conn, 'videos').includes(c)));
    check('publications 五列快照存在',
      ['translation_snapshot', 'translation_lang', 'qc_rules_snapshot', 'qc_report_snapshot', 'speaker_snapshot']
        .every((c) => colNames(conn, 'publications').includes(c)));
    const indexes = conn.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
    eq('全部业务索引就位', indexes, [
      'idx_publications_video', 'idx_qc_waivers_video', 'idx_segments_speaker',
      'idx_segments_video', 'idx_speakers_video', 'idx_translations_video',
    ]);
    // 外键关系仍在（segments -> videos 级联）
    conn.prepare('INSERT INTO videos (id,title,storage_name,original_name,size_bytes,duration_ms,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(99, 'x', 's', 'o', 1, 1000, 1);
    conn.prepare('INSERT INTO segments (video_id,start_ms,end_ms,text,updated_at) VALUES (?,?,?,?,?)')
      .run(99, 0, 500, 't', 1);
    conn.prepare('DELETE FROM videos WHERE id = 99').run();
    eq('外键级联仍生效：删视频后片段级联消失', conn.prepare('SELECT COUNT(*) n FROM segments').get().n, 0);
    check('升级完成 isReady', isReady() === true);
    await close();

    // 重复启动：幂等，无新增执行
    init(dbPath);
    const again = getMigrationInfo();
    eq('再次启动无版本执行', again.applied, []);
    eq('版本仍为 v4', again.currentVersion, 4);
    eq('登记仍恰为 4 行', registry(get()).length, 4);
    await close();
  }

  // ---------- 2. 各代旧库首次升级 ----------
  console.log('2. 旧库识别登记与缺失补齐');
  {
    const dbPath = newDbPath('v1');
    buildV1(dbPath);
    const info = migrate(openRaw(dbPath), migrations);
    check('识别为无登记旧库', info.legacy === true);
    const conn = openRaw(dbPath);
    const regs = registry(conn);
    eq('v1 旧库：v1 登记为 baseline', regs.find((r) => r.version === 1).applied_kind, 'baseline');
    eq('v1 旧库：v2~v4 登记为 up', [2, 3, 4].map((v) => regs.find((r) => r.version === v).applied_kind), ['up', 'up', 'up']);
    check('补 translations/qc/speakers 等全部结构',
      ['translations', 'qc_rules', 'qc_waivers', 'speakers'].every((t) => tableNames(conn).has(t))
      && colNames(conn, 'segments').includes('speaker_id'));
    conn.close();
  }
  {
    const dbPath = newDbPath('v2');
    buildV2(dbPath);
    const conn0 = openRaw(dbPath);
    migrate(conn0, migrations);
    conn0.close();
    const conn = openRaw(dbPath);
    const regs = registry(conn);
    eq('v2 旧库：v1~v2 为 baseline', [1, 2].map((v) => regs.find((r) => r.version === v).applied_kind), ['baseline', 'baseline']);
    eq('v2 旧库：v3~v4 为 up', [3, 4].map((v) => regs.find((r) => r.version === v).applied_kind), ['up', 'up']);
    conn.close();
  }
  {
    const dbPath = newDbPath('v3');
    buildV3(dbPath);
    const conn0 = openRaw(dbPath);
    migrate(conn0, migrations);
    conn0.close();
    const conn = openRaw(dbPath);
    const regs = registry(conn);
    eq('v3 旧库：v1~v3 为 baseline', [1, 2, 3].map((v) => regs.find((r) => r.version === v).applied_kind),
      ['baseline', 'baseline', 'baseline']);
    eq('v3 旧库：v4 为 up', regs.find((r) => r.version === 4).applied_kind, 'up');
    conn.close();
  }
  {
    const dbPath = newDbPath('v4full');
    buildV4FullLegacy(dbPath);
    const info = migrate(openRaw(dbPath), migrations);
    check('全结构旧库识别为旧库', info.legacy === true);
    const conn = openRaw(dbPath);
    const regs = registry(conn);
    eq('全结构旧库：4 个版本全部 baseline 登记（不执行结构变更）',
      regs.map((r) => r.applied_kind), ['baseline', 'baseline', 'baseline', 'baseline']);
    conn.close();
    // 再次启动视为普通已登记库
    const info2 = migrate(openRaw(dbPath), migrations);
    eq('再次启动无执行', info2.applied, []);
  }
  {
    // 中间形态：部分列已补 -> 不重建，幂等补齐并登记
    const dbPath = newDbPath('partial');
    buildPartialLegacy(dbPath);
    migrate(openRaw(dbPath), migrations);
    const conn = openRaw(dbPath);
    const regs = registry(conn);
    // v1 有表 -> baseline；v2 predicate 要求 translations 表存在（缺失）-> 执行 up 补齐
    eq('部分库 v1 baseline', regs.find((r) => r.version === 1).applied_kind, 'baseline');
    check('部分库 v2 补建 translations', tableNames(conn).has('translations'));
    check('部分库已存在的 translation_lang 列保留未重复添加',
      colNames(conn, 'videos').filter((c) => c === 'translation_lang').length === 1);
    check('部分库已存在的 speaker_snapshot 列保留未重复添加',
      colNames(conn, 'publications').filter((c) => c === 'speaker_snapshot').length === 1);
    check('部分库最终结构齐全',
      ['qc_rules', 'qc_waivers', 'speakers'].every((t) => tableNames(conn).has(t))
      && colNames(conn, 'segments').includes('speaker_id')
      && ['translation_snapshot', 'translation_lang', 'qc_rules_snapshot', 'qc_report_snapshot']
        .every((c) => colNames(conn, 'publications').includes(c)));
    conn.close();
  }

  // ---------- 2b. 旧库数据零丢失（库内直接核对）----------
  console.log('3. 旧库升级不丢失视频/字幕/发布快照');
  {
    const dbPath = newDbPath('v1data');
    buildV1(dbPath, true);
    migrate(openRaw(dbPath), migrations);
    const conn = openRaw(dbPath);
    const v = conn.prepare('SELECT * FROM videos WHERE id = 1').get();
    check('视频记录保留', v && v.title === '旧库视频' && v.storage_name === 'stored.bin' && v.duration_ms === 60000,
      JSON.stringify(v));
    const s = conn.prepare('SELECT * FROM segments WHERE id = 1').get();
    check('字幕记录保留（含待审/修订号）', s && s.text === '旧字幕' && s.reviewed === 1 && s.revision === 3,
      JSON.stringify(s));
    const p = conn.prepare('SELECT * FROM publications WHERE id = 1').get();
    check('发布快照保留', p && p.version === 1 && /旧字幕/.test(p.snapshot) && p.segment_count === 1,
      JSON.stringify(p));
    conn.close();
  }

  // ---------- 3. 多进程并发：同一升级只生效一次 ----------
  console.log('4. 多进程同时启动的升级去重');
  {
    const dbPath = newDbPath('concurrent-fresh');
    const results = await Promise.all([
      runWorker(dbPath, []), runWorker(dbPath, []), runWorker(dbPath, []), runWorker(dbPath, []),
    ]);
    check('4 个进程均成功退出', results.every((r) => r.code === 0), JSON.stringify(results.map((r) => r.code)));
    const first = results.find((r) => r.out && r.out.applied.length > 0);
    const others = results.filter((r) => r !== first);
    check('仅 1 个进程执行升级', !!first && others.every((r) => r.out && r.out.applied.length === 0),
      `applied 长度分布: ${results.map((r) => r.out && r.out.applied.length).join(',')}`);
    eq('执行升级的进程恰好顺序跑 v1~v4', first.out.applied.map((a) => a.version), [1, 2, 3, 4]);
    const conn = openRaw(dbPath);
    const regs = registry(conn);
    eq('登记恰为 4 行（无重复）', regs.map((r) => [r.version, r.applied_kind]),
      [[1, 'up'], [2, 'up'], [3, 'up'], [4, 'up']]);
    conn.close();
  }
  {
    // 旧库并发：baseline 识别与 up 补齐合计每版本恰好一次
    const dbPath = newDbPath('concurrent-v3');
    buildV3(dbPath);
    const results = await Promise.all([runWorker(dbPath, []), runWorker(dbPath, []), runWorker(dbPath, [])]);
    check('3 个进程均成功', results.every((r) => r.code === 0), JSON.stringify(results.map((r) => r.code)));
    const conn = openRaw(dbPath);
    const regs = registry(conn);
    eq('旧库并发：v1~v3 baseline、v4 up，各一次',
      regs.map((r) => [r.version, r.applied_kind]),
      [[1, 'baseline'], [2, 'baseline'], [3, 'baseline'], [4, 'up']]);
    check('仅一个进程实际做事',
      results.filter((r) => r.out && r.out.applied.length > 0).length === 1);
    conn.close();
  }

  // ---------- 4. 失败回滚 ----------
  console.log('5. 升级失败回滚该版本结构与登记');
  {
    const dbPath = newDbPath('rollback-fresh');
    // 空库 + 在 v2 注入失败：v1 应已提交（独立事务），v2 的建表与登记整体回滚
    const r1 = await runWorker(dbPath, ['--fail-at', '2']);
    eq('失败进程退出码非零', r1.code, 2);
    check('报错信息传播', r1.out && /注入失败/.test(r1.out.error), JSON.stringify(r1.out));
    const conn = openRaw(dbPath);
    const regs = registry(conn);
    eq('v2 未登记', regs.map((x) => x.version), [1]);
    check('v2 建表随事务回滚（translations 不存在）', !tableNames(conn).has('translations'));
    check('v1 结构保留', tableNames(conn).has('segments') && tableNames(conn).has('publications'));
    conn.close();

    // 不修复不能继续？—— 修复后（正常清单）重试可成功，结构到 v4
    const r2 = await runWorker(dbPath, []);
    eq('修复后重试退出 0', r2.code, 0);
    const conn2 = openRaw(dbPath);
    eq('重试后登记补齐到 v4', registry(conn2).map((x) => x.version), [1, 2, 3, 4]);
    check('translations 已补建', tableNames(conn2).has('translations'));
    conn2.close();
  }
  {
    // 在 v4 注入失败：v3 已提交，v4 的表/列/登记全部回滚
    const dbPath = newDbPath('rollback-v4');
    const r1 = await runWorker(dbPath, ['--fail-at', '4']);
    eq('v4 失败退出码非零', r1.code, 2);
    const conn = openRaw(dbPath);
    eq('登记停在 v3', registry(conn).map((x) => x.version), [1, 2, 3]);
    const tables = tableNames(conn);
    check('speakers 表随 v4 事务回滚', !tables.has('speakers'));
    check('segments.speaker_id 列回滚', !colNames(conn, 'segments').includes('speaker_id'));
    check('publications.speaker_snapshot 列回滚', !colNames(conn, 'publications').includes('speaker_snapshot'));
    conn.close();
    const r2 = await runWorker(dbPath, []);
    eq('重试成功', r2.code, 0);
    const conn2 = openRaw(dbPath);
    eq('登记到 v4', registry(conn2).length, 4);
    conn2.close();
  }

  // ---------- 5. 服务进程：升级失败不监听端口、非零退出 ----------
  console.log('6. 服务进程遇升级失败中止启动');
  {
    const dbPath = newDbPath('broken');
    // 构造一个无法继续的库：已登记 v4 但缺失 v4 表（predicate/up 均无法掩盖时，收尾校验拦截）。
    // 这里用直接手段制造：跑到 v3，然后手写一条假的 v4 登记（模拟登记与结构不一致的损坏库）。
    buildV3(dbPath);
    const conn = openRaw(dbPath);
    conn.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL,
        applied_kind TEXT NOT NULL CHECK (applied_kind IN ('up','baseline')), applied_at INTEGER NOT NULL
      );
    `);
    for (const [v, n] of [[1, 'initial_schema'], [2, 'translation_track'], [3, 'quality_control']]) {
      conn.prepare('INSERT INTO schema_migrations (version,name,applied_kind,applied_at) VALUES (?,?,?,?)')
        .run(v, n, 'baseline', 1);
    }
    conn.prepare('INSERT INTO schema_migrations (version,name,applied_kind,applied_at) VALUES (?,?,?,?)')
      .run(4, 'speakers_and_publish_snapshots', 'up', 1); // 谎称 v4 已完成
    conn.close();

    const PORT = 8911;
    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOAD_DIR: path.join(path.dirname(dbPath), 'v') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stderr.on('data', (d) => { log += d; });
    child.stdout.on('data', (d) => { log += d; });

    let exitCode = null;
    let exited = false;
    child.on('exit', (code) => { exited = true; exitCode = code; });
    // 最多等 8 秒：未完成升级的库必须让进程快速退出；超时则杀掉并判失败（不能挂住测试）
    for (let i = 0; i < 80 && !exited; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!exited) {
      child.kill('SIGKILL');
      await new Promise((r) => child.on('exit', r));
    }
    try {
      check('服务以非零码退出', exitCode !== null && exitCode !== 0, `exit=${exitCode}`);
      check('日志含升级失败/不完整',
        /数据库升级失败|版本登记不一致|升级不完整/.test(log), log.slice(-300));
      // 端口未监听：连接应被拒绝（若进程仍活着且监听了，这里会拿到响应）
      let refused = false;
      try {
        await fetch(`http://127.0.0.1:${PORT}/api/videos`);
      } catch (_) { refused = true; }
      check('未监听端口，请求失败', refused);
    } finally {
      if (!exited) { child.kill('SIGKILL'); }
    }
  }

  // ---------- 6. 旧库升级后 HTTP API 行为不变 ----------
  console.log('7. 旧库升级后经 HTTP API 读取既有数据并继续业务');
  {
    const dbPath = newDbPath('httplegacy');
    buildV1(dbPath, true);
    const PORT = 8912;
    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOAD_DIR: path.join(path.dirname(dbPath), 'vids') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stderr.on('data', (d) => { log += d; });
    child.stdout.on('data', (d) => { log += d; });

    async function waitReady(retries = 40) {
      for (let i = 0; i < retries; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}/api/videos`);
          if (res.ok) return;
        } catch (_) { /* 等待 */ }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('服务器启动超时：\n' + log);
    }

    try {
      await waitReady();

      const list = await (await fetch(`http://127.0.0.1:${PORT}/api/videos`)).json();
      check('API 列出旧库视频', Array.isArray(list.videos) && list.videos.some((x) => x.title === '旧库视频'),
        JSON.stringify(list).slice(0, 200));
      const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/videos/1`)).json();
      check('API 读回旧字幕文本与修订号',
        detail.segments && detail.segments.length === 1
        && detail.segments[0].text === '旧字幕' && detail.segments[0].revision === 3
        && detail.segments[0].reviewed === true,
        JSON.stringify(detail.segments));

      // 在升级后的库上继续走新结构业务：先启用译文轨道（v2 列），再给旧片段加译文
      const track = await fetch(`http://127.0.0.1:${PORT}/api/videos/1/translation/track`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'en' }),
      });
      check('旧视频可启用译文轨道（v2 列可用）', track.status === 201, `status=${track.status}`);
      const tr = await fetch(`http://127.0.0.1:${PORT}/api/videos/1/segments/1/translation`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Old subtitle', segment_revision: 3 }),
      }).then((r) => r.json());
      check('旧片段可新增译文（v2 结构可用）', tr.translation && tr.translation.text === 'Old subtitle',
        JSON.stringify(tr));
      // 质检规则（v3 结构）：当前无规则，revision=0 首次创建
      const qc = await fetch(`http://127.0.0.1:${PORT}/api/videos/1/qc/rules`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_max_cps: 20, rules_revision: 0 }),
      });
      check('质检规则接口可用（v3 结构）', qc.status === 200, `status=${qc.status}`);
      // 说话人 + 归属（v4 结构）
      const sp = await fetch(`http://127.0.0.1:${PORT}/api/videos/1/speakers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '主播', list_revision: 0 }),
      }).then((r) => r.json());
      check('说话人接口可用（v4 结构）', sp.speaker && sp.speaker.name === '主播', JSON.stringify(sp));

      // 数据复核：升级后经新结构写入的译文可再次读回，且旧视频原字段未变
      const detail2 = await (await fetch(`http://127.0.0.1:${PORT}/api/videos/1`)).json();
      check('二次读取：视频仍是旧标题、时长与旧字幕',
        detail2.video && detail2.video.title === '旧库视频' && detail2.video.duration_ms === 60000
        && detail2.segments[0].text === '旧字幕',
        JSON.stringify({ title: detail2.video && detail2.video.title, duration: detail2.video && detail2.video.duration_ms }));
    } finally {
      child.kill();
      await new Promise((r) => child.on('exit', r));
    }
  }
}

tests()
  .then(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('测试运行失败:', e);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(1);
  });
