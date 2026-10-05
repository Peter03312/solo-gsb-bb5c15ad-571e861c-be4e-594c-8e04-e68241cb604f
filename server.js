'use strict';

const express = require('express');
const path = require('path');
const { init } = require('./src/db');
const { ApiError } = require('./src/validation');
const apiRouter = require('./src/routes');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');

init(DB_PATH);

const app = express();
app.use(express.json({ limit: '2mb' }));
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
