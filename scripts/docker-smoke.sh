#!/usr/bin/env bash
#
# 奶记 · Docker 冒烟测试（构建镜像 → 用 compose 起一个隔离实例 → 断言 → 清理）
#
# 用法：
#   bash scripts/docker-smoke.sh              # 构建 + 测试 + 清理
#   SKIP_BUILD=1 bash scripts/docker-smoke.sh # 复用已有镜像，只测试
#
# 说明：用独立 compose 项目名（默认 naiji-smoke）和随机空闲端口，不会碰你正在运行的
# `naiji` 容器和数据卷；退出码 0 = 全部通过。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

PROJECT="${SMOKE_PROJECT:-naiji-smoke}"
PASS=0
FAIL=0
API_ONLY_CONTAINER="naiji-smoke-apionly"

pass() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
check() { # check <名称> <命令...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

pick_port() {
  local port
  for _ in $(seq 1 30); do
    port=$(( (RANDOM % 20000) + 20000 ))
    if ! ss -ltn 2>/dev/null | grep -q ":$port "; then echo "$port"; return 0; fi
  done
  return 1
}

cleanup() {
  docker rm -f "$API_ONLY_CONTAINER" >/dev/null 2>&1 || true
  NAIJI_PORT="${PORT:-3000}" docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

PORT="$(pick_port)" || { echo "找不到空闲端口"; exit 1; }
BASE="http://127.0.0.1:$PORT"

echo "== 1/5 构建镜像 =="
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "  跳过构建（SKIP_BUILD=1）"
else
  if ! docker compose -p "$PROJECT" build; then echo "镜像构建失败"; exit 1; fi
fi

echo "== 2/5 启动隔离实例（宿主机端口 $PORT）=="
if ! NAIJI_PORT="$PORT" docker compose -p "$PROJECT" up -d; then echo "启动失败"; exit 1; fi

CID="$(NAIJI_PORT="$PORT" docker compose -p "$PROJECT" ps -q naiji)"
if [ -z "$CID" ]; then echo "找不到容器"; exit 1; fi

echo "== 3/5 等待健康检查 =="
status=""
for _ in $(seq 1 40); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$CID" 2>/dev/null)"
  [ "$status" = "healthy" ] && break
  sleep 1
done
if [ "$status" = "healthy" ]; then pass "健康检查为 healthy"; else fail "健康检查为 healthy（当前: ${status:-unknown}）"; fi

echo "== 4/5 功能与运行时断言 =="
check "GET /api/health → ok" bash -c "curl -fsS -m 3 '$BASE/api/health' | grep -q '\"ok\":true'"
check "GET / 返回 web 页面" bash -c "curl -fsS -m 3 '$BASE/' | grep -q '奶记'"
check "GET /app.js → 200" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -m 3 '$BASE/app.js')\" = '200' ]"
check "GET /config.js → 200" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -m 3 '$BASE/config.js')\" = '200' ]"
check "多选标签记录 → 201 且 feedTypes 正确" bash -c "
  curl -fsS -m 3 -X POST '$BASE/api/feedings' -H 'Content-Type: application/json' \
    -d '{\"feedTypes\":[\"formula\",\"breast_milk\"],\"amountMl\":120}' | grep -q '\"feedTypes\":\\[\"formula\",\"breast_milk\"\\]'"
check "GET /api/state 汇总正确" bash -c "
  curl -fsS -m 3 '$BASE/api/state?tzOffset=-480' | grep -q '\"feedCount\":1.*\"totalMl\":120'"
check "记录大小便" bash -c "
  curl -fsS -m 3 -X POST '$BASE/api/diapers' -H 'Content-Type: application/json' -d '{\"diaperKind\":\"poop\"}' | grep -q '\"diaperKind\":\"poop\"'"
check "CSV 导出含 BOM + 多标签项目名" bash -c "
  curl -fsS -m 3 '$BASE/api/export.csv' | grep -q '奶粉 + 母乳（瓶喂）'"
check "容器内 naiji CLI 可用" bash -c "
  docker compose -p '$PROJECT' exec -T naiji naiji status --no-color | grep -q '距离上次喂奶'"
check "容器内 CLI 能看到刚记录的数据" bash -c "
  docker compose -p '$PROJECT' exec -T naiji naiji status --no-color | grep -q '120 ml'"
check "容器时区为 Asia/Shanghai" bash -c "
  docker compose -p '$PROJECT' exec -T naiji date | grep -qE 'CST|CST\+'"
check "容器以非 root（node, uid 1000）运行" bash -c "
  docker compose -p '$PROJECT' exec -T naiji id | grep -q 'uid=1000(node)'"
check "SQLite 落在数据卷 /app/data" bash -c "
  docker compose -p '$PROJECT' exec -T naiji test -f /app/data/baby.db"
check "数据卷已创建且挂在容器内" bash -c "
  docker inspect '$CID' --format '{{range .Mounts}}{{.Destination}} {{end}}' | grep -q '/app/data'"

echo "== 5/5 重启后数据持久化 =="
NAIJI_PORT="$PORT" docker compose -p "$PROJECT" restart naiji >/dev/null 2>&1
status=""
for _ in $(seq 1 40); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$CID" 2>/dev/null)"
  [ "$status" = "healthy" ] && break
  sleep 1
done
check "重启后记录仍在（数据持久化）" bash -c "
  curl -fsS -m 3 '$BASE/api/state?tzOffset=-480' | grep -q '\"feedCount\":1'"

echo "== 额外：SERVE_WEB=0 纯 API 模式 =="
if docker run --rm -d --name "$API_ONLY_CONTAINER" -e SERVE_WEB=0 -e DB_PATH=/tmp/x.db \
     -p "$((PORT + 1)):3000" naiji:2.0.0 >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    curl -fsS -m 2 "http://127.0.0.1:$((PORT + 1))/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  check "SERVE_WEB=0 时 /api/health 正常" bash -c "
    curl -fsS -m 3 'http://127.0.0.1:$((PORT + 1))/api/health' | grep -q '\"ok\":true'"
  check "SERVE_WEB=0 时 / 返回 web_disabled" bash -c "
    curl -s -m 3 'http://127.0.0.1:$((PORT + 1))/' | grep -q 'web_disabled'"
else
  fail "SERVE_WEB=0 容器启动"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mDocker 冒烟测试：%d/%d PASS\033[0m\n' "$PASS" "$((PASS + FAIL))"
  exit 0
else
  printf '\033[31mDocker 冒烟测试：%d PASS / %d FAIL\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
