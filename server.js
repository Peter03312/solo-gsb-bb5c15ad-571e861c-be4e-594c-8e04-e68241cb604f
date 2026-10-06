'use strict';

const express = require('express');
const path = require('path');
const { init, isReady } = require('./src/db');
const { ApiError } = require('./src/validation');
const apiRouter = require('./src/routes');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');

// 顺序执行版本化结构升级。任一升级失败都会抛出：该版本结构与登记已随事务回滚，
// 此处记录并以非零码退出，不进入 app.listen —— 服务不会以未完成升级的库对外提供请求。
try {
  init(DB_PATH);
} catch (err) {
  console.error('[fatal] 数据库升级失败，服务中止启动：');
  console.error(err);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// 防御性门禁：仅当全部结构升级完成（init 成功即满足）才放行 API
app.use('/api', (req, res, next) => {
  if (!isReady()) {
    res.status(503).json({ error: { code: 'db_unavailable', message: '数据库升级尚未完成，服务暂不可用' } });
    return;
  }
  next();
});
app.use('/api', apiRouter);
app.use(express.static(path.join(__dirname, 'public')));

// 统一错误响应：非法修改返回 422 与原因；修订冲突返回 409 与当前内容
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    return;
  }
  if (err && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: '请求体不是合法 JSON' } });
    return;
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    res.status(422).json({ error: { code: 'file_too_large', message: '视频文件超过上传大小上限（MAX_UPLOAD_MB）' } });
    return;
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'internal', message: '服务器内部错误' } });
});

app.listen(PORT, HOST, () => {
  console.log(`Subtitle Desk 已启动: http://localhost:${PORT}  (数据文件: ${DB_PATH})`);
});
