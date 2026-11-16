#!/usr/bin/env bash
# 启动 mitmdump 抓微信/QQ 农场流量。会临时把系统代理指向本机 mitmdump,
# 退出时恢复抓包前的 HTTP/HTTPS、自动代理和 bypass 配置。
#
# 用法:
#   ./run.sh                                  # 默认 Wi-Fi, 端口 38127, Ctrl-C 停止
#   WX_RUN_DURATION=120 ./run.sh              # 启动后 120s 自动停止
#   WX_NET_SERVICE=Ethernet WX_PROXY_PORT=38199 ./run.sh
#   WX_KEEP_PROXY=1 ./run.sh                  # 调试时保留代理设置
#
# 相关环境变量:
#   WX_BLOCK=1               拦截握手使 code 不被消费 (提交给机器人时建议开)
#   WX_SERVER_URL            机器人提交端点, 建议 https://<域名>/api/accounts
#   WX_ACCOUNT_ID            目标账号 id (会作为 body.id 和 x-account-id 头)
#   WX_ADMIN_TOKEN           管理 token (x-admin-token 头, /api/accounts 必须)
#   WX_POST_UNUSED_ONLY      默认 1, 只上报被拦截的未消费 code; 置 0 则全部上报
#   WX_POST_COOLDOWN_SEC     上报节流, 默认 30s
#   WX_CAPTURE_WS            置 1 抓 WS 游戏帧原始 hex
#   WX_WS_CAPTURE_LOG        WS 抓帧输出路径, 默认 /tmp/wx_ws_capture.jsonl
#   WX_CAPTURE_HTTP_ALL      置 1 抓所有 HTTP/HTTPS 请求 (微信宿主/游戏圈接口)
#   WX_HTTP_CAPTURE_LOG      HTTP 抓包输出路径, 默认 /tmp/wx_http_capture.jsonl
#   WX_RUN_DURATION          自动停止秒数, 0=手动 Ctrl-C, 默认 0
#   WX_READY_FILE            就绪后 touch 的文件, 供上层脚本等待
#   WX_PROXY_SNAPSHOT_DIR    原有代理配置备份目录
#   WX_KEEP_PROXY=1          退出时不恢复系统代理 (仅调试)
#
# 注意: 首次使用前先执行一次 ./setup-cert.sh 信任 mitmproxy 证书。
set -uo pipefail

SERVICE="${WX_NET_SERVICE:-Wi-Fi}"
PORT="${WX_PROXY_PORT:-38127}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ADDON="$DIR/mitm_addon.py"
MITM="${WX_MITMDUMP:-/opt/homebrew/bin/mitmdump}"
DURATION="${WX_RUN_DURATION:-0}"
READY_FILE="${WX_READY_FILE:-}"
KEEP_PROXY="${WX_KEEP_PROXY:-0}"
CAPTURE_HTTP_ALL="${WX_CAPTURE_HTTP_ALL:-0}"
SNAP_DIR="${WX_PROXY_SNAPSHOT_DIR:-/tmp/wx_proxy_backup_${PORT}_$$}"
MITM_PID=""
CLEANED=0

log() { echo "[run] $*"; }
warn() { echo "[run] ⚠️  $*" >&2; }

port_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

field() {
  awk -F': ' -v k="$2" '$1==k {sub("^" k ": ", ""); print; exit}' "$1" 2>/dev/null
}

snapshot_proxy() {
  mkdir -p "$SNAP_DIR"
  networksetup -getwebproxy "$SERVICE" > "$SNAP_DIR/web.txt" 2>&1 || true
  networksetup -getsecurewebproxy "$SERVICE" > "$SNAP_DIR/secure.txt" 2>&1 || true
  networksetup -getautoproxyurl "$SERVICE" > "$SNAP_DIR/auto.txt" 2>&1 || true
  if networksetup -getproxybypassdomains "$SERVICE" > "$SNAP_DIR/bypass.txt" 2>&1; then
    if grep -Eq "(aren't|are no) bypass domains" "$SNAP_DIR/bypass.txt"; then
      : > "$SNAP_DIR/bypass-empty"
    fi
  fi
}

restore_proxy() {
  [ -d "$SNAP_DIR" ] || return 0
  log "恢复系统代理 ($SERVICE)..."

  local enabled server port url auto_enabled bypass_line
  enabled="$(field "$SNAP_DIR/web.txt" Enabled)"
  server="$(field "$SNAP_DIR/web.txt" Server)"
  port="$(field "$SNAP_DIR/web.txt" Port)"
  if [ -n "$server" ] && [ -n "$port" ]; then
    networksetup -setwebproxy "$SERVICE" "$server" "$port" >/dev/null 2>&1 || true
  fi
  if [ "$enabled" = "Yes" ]; then
    networksetup -setwebproxystate "$SERVICE" on >/dev/null 2>&1 || true
  else
    networksetup -setwebproxystate "$SERVICE" off >/dev/null 2>&1 || true
  fi

  enabled="$(field "$SNAP_DIR/secure.txt" Enabled)"
  server="$(field "$SNAP_DIR/secure.txt" Server)"
  port="$(field "$SNAP_DIR/secure.txt" Port)"
  if [ -n "$server" ] && [ -n "$port" ]; then
    networksetup -setsecurewebproxy "$SERVICE" "$server" "$port" >/dev/null 2>&1 || true
  fi
  if [ "$enabled" = "Yes" ]; then
    networksetup -setsecurewebproxystate "$SERVICE" on >/dev/null 2>&1 || true
  else
    networksetup -setsecurewebproxystate "$SERVICE" off >/dev/null 2>&1 || true
  fi

  url="$(field "$SNAP_DIR/auto.txt" URL)"
  auto_enabled="$(field "$SNAP_DIR/auto.txt" Enabled)"
  if [ -n "$url" ] && [ "$url" != "(null)" ]; then
    networksetup -setautoproxyurl "$SERVICE" "$url" >/dev/null 2>&1 || true
  fi
  if [ "$auto_enabled" = "Yes" ]; then
    networksetup -setautoproxystate "$SERVICE" on >/dev/null 2>&1 || true
  else
    networksetup -setautoproxystate "$SERVICE" off >/dev/null 2>&1 || true
  fi

  if [ -f "$SNAP_DIR/bypass-empty" ]; then
    networksetup -setproxybypassdomains "$SERVICE" Empty >/dev/null 2>&1 || true
  elif [ -s "$SNAP_DIR/bypass.txt" ]; then
    local -a bypass_domains=()
    while IFS= read -r bypass_line; do
      [ -n "$bypass_line" ] && bypass_domains+=("$bypass_line")
    done < "$SNAP_DIR/bypass.txt"
    if [ "${#bypass_domains[@]}" -gt 0 ]; then
      networksetup -setproxybypassdomains "$SERVICE" "${bypass_domains[@]}" >/dev/null 2>&1 || true
    fi
  fi
  log "系统代理已恢复。"
}

set_proxy() {
  local failed=0
  networksetup -setwebproxy "$SERVICE" 127.0.0.1 "$PORT" || failed=1
  networksetup -setsecurewebproxy "$SERVICE" 127.0.0.1 "$PORT" || failed=1
  networksetup -setwebproxystate "$SERVICE" on || failed=1
  networksetup -setsecurewebproxystate "$SERVICE" on || failed=1
  networksetup -setautoproxystate "$SERVICE" off >/dev/null 2>&1 || failed=1
  return "$failed"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$CLEANED" = "1" ]; then
    exit "$status"
  fi
  CLEANED=1

  if [ -n "$MITM_PID" ]; then
    kill -TERM "$MITM_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$MITM_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$MITM_PID" 2>/dev/null || true
    wait "$MITM_PID" 2>/dev/null || true
    MITM_PID=""
  fi

  if [ "$KEEP_PROXY" = "1" ]; then
    warn "按 WX_KEEP_PROXY=1 保留系统代理；稍后手动关闭:"
    warn "networksetup -setwebproxystate \"$SERVICE\" off && networksetup -setsecurewebproxystate \"$SERVICE\" off"
  else
    restore_proxy
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[ -x "$MITM" ] || { warn "找不到 mitmdump: $MITM"; warn "安装: brew install mitmproxy"; exit 3; }
[ -f "$ADDON" ] || { warn "找不到 addon: $ADDON"; exit 3; }
command -v networksetup >/dev/null 2>&1 || { warn "networksetup 不存在, 当前脚本仅支持 macOS"; exit 3; }
networksetup -getwebproxy "$SERVICE" >/dev/null 2>&1 || {
  warn "找不到网络服务: $SERVICE"
  warn "可用: networksetup -listallnetworkservices"
  exit 3
}

if port_listening "$PORT"; then
  warn "端口 $PORT 已被占用，可能已有抓包会话在运行:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sed 's/^/        /' >&2
  warn "先停止旧会话，或换端口: WX_PROXY_PORT=38199 $0"
  exit 3
fi

case "$DURATION" in
  ''|*[!0-9]*) warn "WX_RUN_DURATION 必须是非负整数秒"; exit 3 ;;
esac

snapshot_proxy
log "已备份原代理配置 -> $SNAP_DIR"

log "启动 mitmdump (端口 $PORT)..."
MITM_ARGS=(
  -s "$ADDON"
  --listen-port "$PORT"
  --set termlog_verbosity=warn \
  --set flow_detail=0
)
if [ "$CAPTURE_HTTP_ALL" = "1" ]; then
  MITM_ARGS+=(--set 'allow_hosts=.*')
else
  MITM_ARGS+=(--set 'allow_hosts=nqf\.qq\.com' '~d nqf.qq.com')
fi
"$MITM" "${MITM_ARGS[@]}" &
MITM_PID=$!

READY=0
for _ in $(seq 1 40); do
  if port_listening "$PORT"; then
    READY=1
    break
  fi
  kill -0 "$MITM_PID" 2>/dev/null || break
  sleep 0.25
done
if [ "$READY" != "1" ]; then
  warn "mitmdump 启动失败。"
  exit 3
fi

log "mitmdump 就绪。"
if ! set_proxy; then
  warn "设置系统代理失败，停止 mitmdump 并恢复原代理。"
  exit 3
fi
if [ "$CAPTURE_HTTP_ALL" = "1" ]; then
  log "系统代理: $SERVICE -> 127.0.0.1:$PORT (抓取所有 HTTP/HTTPS 域名)"
else
  log "系统代理: $SERVICE -> 127.0.0.1:$PORT (仅解密 nqf.qq.com)"
fi
if [ -n "$READY_FILE" ]; then
  mkdir -p "$(dirname "$READY_FILE")"
  : > "$READY_FILE"
fi

echo "-------------------------------------------------------------"
if [ "$DURATION" -gt 0 ]; then
  log "抓包已开始，${DURATION}s 后自动停止。"
  DEADLINE=$(( $(date +%s) + DURATION ))
  NEXT_TICK=$(( DURATION < 30 ? DURATION : 30 ))
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if ! kill -0 "$MITM_PID" 2>/dev/null; then
      wait "$MITM_PID"
      exit $?
    fi
    REMAIN=$(( DEADLINE - $(date +%s) ))
    if [ "$REMAIN" -le "$NEXT_TICK" ]; then
      log "抓包中... 剩余 ${REMAIN}s"
      NEXT_TICK=$(( REMAIN - 30 ))
    fi
    sleep 0.5
  done
  log "抓包时间到，正在停止。"
  exit 0
fi

if [ -n "$READY_FILE" ]; then
  log "抓包已开始；停止时机由上层脚本控制，退出后自动恢复代理。"
else
  log "抓包已开始。按 Ctrl-C 停止 (退出后自动恢复代理)。"
fi
wait "$MITM_PID"
STATUS=$?
MITM_PID=""
exit "$STATUS"
