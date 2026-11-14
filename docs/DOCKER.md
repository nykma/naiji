# 奶记 · Docker 部署

单容器同时打包**后端 API（Node.js + SQLite）**和**web 前端**：容器里跑一个 Node 进程，既提供 `/api/*`，也托管 `web/` 静态页面；数据落在 Docker 命名卷里。

- 基础镜像：`node:24-alpine`（Node ≥ 22.13 即可，内置 `node:sqlite`）
- **零第三方依赖**：没有 `npm install`、没有构建步骤，构建过程只是复制代码（约 10 秒）
- 镜像约 173 MB（几乎全是基础镜像；应用代码 < 2 MB）
- 非 root 运行（`node`，uid/gid 1000）；镜像内置 `HEALTHCHECK`
- 镜像里也带了 CLI，方便排查：`docker compose exec naiji naiji status`
- 支持 amd64 / arm64（基础镜像多架构）

---

## 1. 快速开始

```bash
cd baby-milk-tracker
docker compose up -d --build      # 首次构建并启动
docker compose ps                 # 等 STATUS 出现 (healthy)
docker compose logs -f            # 看启动日志（含局域网访问地址）
```

打开 `http://127.0.0.1:3000`；手机连同一 WiFi 打开 `http://<电脑局域网 IP>:3000`。

- 数据在命名卷里（容器内 `/app/data/baby.db`），**`docker compose down` 不会删数据**，只有 `docker compose down -v` 才会。
- 镜像名 `naiji:2.0.0`；容器由 compose 自动命名（`naiji-naiji-1`），日常用服务名即可：`docker compose ps / exec naiji / logs -f`。

### 改端口 / 时区

```bash
NAIJI_PORT=8080 docker compose up -d      # 宿主机 8080 → 容器 3000（端口被占时用这个）
TZ=Asia/Tokyo docker compose up -d        # 容器时区（CSV 导出等按此时区）
```

容器内固定监听 `3000`，只改宿主机映射端口即可。

---

## 2. 数据持久化 / 备份 / 恢复

### 数据在哪

| | |
| --- | --- |
| 命名卷 | `naiji_naiji-data`（= Compose 项目名 `naiji` + volume key；用 `docker volume ls` 可查） |
| 容器内路径 | `/app/data/`（`baby.db` + `-wal`/`-shm`） |

> ⚠️ **不要直接 `docker cp` 运行中的 `baby.db` 当备份**：数据库开着 WAL，新数据可能只写进 `baby.db-wal`，主库文件本身可能还是空的（实测 4KB 且没有表）。请用下面的「停服打包」或「在线 `backup()`」两种方式。

### 备份（推荐停服拷贝，最稳）

```bash
docker compose stop
docker run --rm -v naiji_naiji-data:/data -v "$PWD":/backup alpine:3.20 \
  tar czf /backup/naiji-backup-$(date +%F).tgz -C /data .
docker compose start
```

### 在线备份（不停服，用 SQLite backup API）

```bash
docker compose exec -T naiji node -e "
const { DatabaseSync, backup } = require('node:sqlite');
const db = new DatabaseSync('/app/data/baby.db');
backup(db, '/app/data/backup.db').then(() => { db.close(); console.log('backup ok'); });
"
docker compose cp naiji:/app/data/backup.db ./naiji-backup.db
docker compose exec -T naiji rm -f /app/data/backup.db
```

### 恢复

```bash
docker compose stop
docker run --rm -v naiji_naiji-data:/data -v "$PWD":/backup alpine:3.20 \
  sh -c 'rm -rf /data/* && tar xzf /backup/naiji-backup-XXXX-XX-XX.tgz -C /data && chown -R 1000:1000 /data'
docker compose start
```

### 从宿主机版本迁移数据（含 v1 老库）

宿主机跑过 `npm start` 的数据在仓库 `data/baby.db`。搬进容器：

```bash
docker compose up -d          # 先创建卷
docker compose stop
docker run --rm -v naiji_naiji-data:/data -v "$PWD/data":/src alpine:3.20 \
  sh -c 'rm -f /data/baby.db*; cp /src/baby.db /data/baby.db && chown -R 1000:1000 /data'
docker compose start
```

> v1（单类型 `feed_type` 列）的旧库在容器首次启动时会**自动迁移到 v2（多选标签）**，`user_version` 置 2，记录不丢；已实测。

---

## 3. 前后端分离（可选）

默认单容器里 server 同时托管 web，够用。如果要「API 容器 + 静态 web 分开」：

1. compose 里给服务加环境变量 `SERVE_WEB: "0"`（或 `docker run -e SERVE_WEB=0`）；
2. 把仓库 `web/` 目录内容放到任意静态主机（nginx / Caddy / GitHub Pages…）；
3. 让前端指向后端 API：打开页面时加 `?api=http://<后端地址>:3000`（会持久化到 localStorage），或直接改 `web/config.js` 的 `apiBase`；
4. 若前端与 API **不同源**，后端默认 `CORS_ORIGINS=*` 已放行；生产环境建议收紧：
   `CORS_ORIGINS=http://192.168.1.23:8080`（逗号分隔多个）。

同源反代示例（nginx 同时托管静态和反代 API，无需 CORS）：

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;          # 放 web/ 的内容
  location / { try_files $uri $uri/ /index.html; }
  location /api/ { proxy_pass http://naiji:3000; }
}
```

---

## 4. 常用运维

| 操作 | 命令 |
| --- | --- |
| 更新到最新代码 | `git pull && docker compose up -d --build` |
| 看日志 | `docker compose logs -f --tail=100` |
| 健康状态 | `docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q naiji)"` |
| 进容器 shell | `docker compose exec naiji sh` |
| 用容器内 CLI 看状态 | `docker compose exec naiji naiji status` |
| 宿主机 CLI 连容器 | `naiji status --server http://127.0.0.1:3000` |
| 重启 | `docker compose restart` |
| 停止（保留数据） | `docker compose down` |
| 停止并删除数据（危险） | `docker compose down -v` |
| 删除镜像 | `docker rmi naiji:2.0.0` |

资源限制示例（写进 compose 的 `deploy.resources`）：

```yaml
    deploy:
      resources:
        limits:
          memory: 256M
```

---

## 5. 环境变量

容器内可用变量与 `server/` 完全一致（compose 里按需加 `environment:`）：

| 变量 | 镜像默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 容器内监听；一般不改，改宿主机映射用 `NAIJI_PORT` |
| `DB_PATH` | `/app/data/baby.db` | SQLite 路径（在数据卷里） |
| `SERVE_WEB` | `1` | `0` = 只跑 API |
| `WEB_DIR` | `/app/web` | 静态目录 |
| `CORS_ORIGINS` | `*` | 允许的跨源来源，逗号分隔 |
| `TZ` | `Asia/Shanghai` | 时区（CSV、服务端「今天」回退） |
| `NAIJI_SERVER` | `http://127.0.0.1:3000` | 容器内 CLI 默认连的地址 |

---

## 6. 常见问题

**Q：启动报 `failed to bind host port 0.0.0.0:3000: address already in use`**
宿主机 3000 被占用（比如之前 `npm start` 起的服务）。先停掉宿主机服务，或换端口：`NAIJI_PORT=8080 docker compose up -d`。

**Q：`docker ps` 里一直 `(unhealthy)`**
先看日志 `docker compose logs`。最常见的原因是用 bind mount 挂了宿主机目录但属主不对（容器内是 uid 1000）。处理：`sudo chown -R 1000:1000 ./data`，或改用命名卷（默认就是）。

**Q：想用 bind mount 把数据放宿主机目录**
compose 里改成 `- ./data:/app/data`，并确保该目录属主为 1000:1000，或在服务里加 `user: "${UID:-1000}:${GID:-1000}"`。

**Q：手机访问不了**
用电脑局域网 IP（启动日志会打印，如 `http://192.168.1.23:3000`），确认手机同一 WiFi、电脑防火墙放行该端口。

**Q：CSV 导出的时间是 UTC？**
设置 `TZ`（默认 `Asia/Shanghai`）。CSV 用容器本地时区格式化。

**Q：镜像能小一点吗？**
基础镜像占绝大部分。可以用更精简的基础镜像（例如 `node:24-alpine` 已是最常用的小体积官方镜像；也可自行替换为 `node:24-slim` 等），通过 `--build-arg NODE_IMAGE=...` 或在 compose 里设 `NODE_IMAGE`。
