# 小团队本机字幕校对服务
FROM node:20-bookworm-slim

# better-sqlite3 使用预编译二进制；保留构建工具链以备无预编译包时本地编译
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p data/videos && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/app.db \
    UPLOAD_DIR=/app/data/videos

EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "server.js"]
