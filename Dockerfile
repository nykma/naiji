# syntax=docker/dockerfile:1
#
# 奶记 · 婴儿喂养记录 —— 生产镜像（后端 API + web 前端 + CLI）
#
# 设计要点：
# - 零第三方依赖：不需要 npm install，也没有构建步骤，直接复制代码即可运行
# - 基础镜像 Node 24（内置 node:sqlite，版本要求 ≥ 22.13）
# - server 默认同时托管 web/（单容器部署）；想前后端分离可用 SERVE_WEB=0
# - 非 root 运行；SQLite 数据放 /app/data（配命名卷持久化）
#
# 构建：docker build -t naiji:2.0.0 .
#   （可用 --build-arg NODE_IMAGE=node:24-alpine 指定基础镜像）

ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

# TZ 设置需要 tzdata 才能生效（CSV 导出、/api/state 省略 tzOffset 时的「今天」都按服务器本地时区）
RUN apk add --no-cache tzdata \
 && rm -rf /var/cache/apk/*

WORKDIR /app

# package.json 同时承担 "type": "module" 的 ESM 开关作用，必须复制
COPY package.json ./package.json
COPY server ./server
COPY web ./web
# 顺手把 CLI 也放进镜像：docker compose exec naiji naiji status
COPY cli ./cli

# 数据目录；命名卷首次挂载时会继承这里的属主（node:node）
# 同时把 naiji 命令放进 PATH：docker compose exec naiji naiji status
RUN mkdir -p /app/data \
 && printf '#!/bin/sh\nexec node /app/cli/bin/naiji.mjs "$@"\n' > /usr/local/bin/naiji \
 && chmod +x /usr/local/bin/naiji \
 && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SERVE_WEB=1 \
    WEB_DIR=/app/web \
    DB_PATH=/app/data/baby.db \
    TZ=Asia/Shanghai \
    NAIJI_SERVER=http://127.0.0.1:3000

# 声明数据卷，提醒使用者这里需要持久化
VOLUME ["/app/data"]
EXPOSE 3000

# 用 Node 内置 fetch 做健康检查，镜像里无需 curl/wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

LABEL org.opencontainers.image.title="奶记 · 婴儿喂养记录" \
      org.opencontainers.image.description="婴儿喂奶/大小便记录：Node.js API + SQLite + 静态 web 前端" \
      org.opencontainers.image.version="2.0.0" \
      org.opencontainers.image.licenses="UNLICENSED"

CMD ["node", "server/src/server.js"]
