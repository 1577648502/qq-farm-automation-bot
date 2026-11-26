#!/usr/bin/env bash
# 一键抓「当前登录的农场」code (对话里说一声"抓"就跑这个)
#
# 两种模式:
#   protocol (默认) —— 协议注入法: 往农场缓存 game.js 注入 qq.login() 嗅探,
#                     然后等你自己打开「QQ农场」(不自动唤起; 加 --reopen 可自动拉起)。
#                     无需系统代理、无需辅助功能权限, 注入完成后 3s 出 code。
#   mitm            —— mitmdump 代理抓包法: 开代理 + 拦截握手, 拿"未被消费"的握手 code。
#                     适合不想动小程序缓存的场景; 同样默认不唤起农场(--trigger 可开)。
#
# 用法:
#   ./grab-now.sh                    # 默认 protocol 模式，最多等 90s
#   ./grab-now.sh --timeout 180
#   ./grab-now.sh --reopen           # (protocol) 自动关掉并重新唤起农场(默认不唤起), 抓完再关掉
#   ./grab-now.sh --reopen --keep-open   # (protocol) 抓完把农场窗口留着
#   ./grab-now.sh --json             # (protocol) 只输出一行 JSON
#   ./grab-now.sh --submit           # (protocol) 抓到后提交到 submit.config.json 配置的接口
#   ./grab-now.sh --no-start         # (protocol) 提交后不自动启动账号（默认没在跑就会启动）
#   ./grab-now.sh --push             # (protocol) 同 --submit（旧名，保留兼容）
#   ./grab-now.sh --mode mitm        # 走代理抓包模式
#   ./grab-now.sh --show             # 只看上次 mitm 模式的结果
#
# mitm 模式的附加参数:
#   --trigger      自动唤起农场(默认不唤起, 自己手动打开)
#   --no-block     不拦截握手(被动观察, code 大概率已被消费)
#   --push         抓到后自动提交给机器人(需 WX_SERVER_URL/WX_ACCOUNT_ID/WX_ADMIN_TOKEN)
#   --keep-proxy   抓完不还原代理(调试用)
#
# 其它环境变量: WX_NET_SERVICE(默认 Wi-Fi) WX_PROXY_PORT(默认 38127)
#   WX_GRAB_TIMEOUT(默认 90) WX_TRIGGER_CMD WX_BLOCK
#
# 退出码: 0=抓到  2=超时  3=环境/端口问题
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ADDON="$DIR/mitm_addon.py"
MITM="${WX_MITMDUMP:-/opt/homebrew/bin/mitmdump}"
PY="${WX_PYTHON:-/usr/bin/python3}"
NODE_BIN="${WX_NODE:-$(command -v node || echo /Users/liufaguang/.workbuddy/binaries/node/versions/22.22.2-3/bin/node)}"

# QQ 农场小程序的官方唤起链接(项目 core 里用的就是它; actionParams 是
# {"sourceType":"open","appId":"1112386029","hostScene":"1246700100"} 的 urlencode)
FARM_URL='tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D'

SERVICE="${WX_NET_SERVICE:-Wi-Fi}"
PORT="${WX_PROXY_PORT:-38127}"
TIMEOUT="${WX_GRAB_TIMEOUT:-90}"
BLOCK="${WX_BLOCK:-1}"
RESULT_JSON="${WX_GRAB_RESULT:-/tmp/wx_grab_result.json}"

MODE=protocol
# 默认不自动唤起农场, 用户自己打开(2026-11-16 起); 要自动唤起加 --trigger
DO_TRIGGER=0
DO_PUSH=0
KEEP_PROXY=0
SHOW_ONLY=0
PASSTHRU=""

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)        MODE="${2:-protocol}"; shift 2 ;;
    --mode=*)      MODE="${1#*=}"; shift ;;
    --mitm)        MODE=mitm; shift ;;
    --protocol)    MODE=protocol; shift ;;
    --timeout)     TIMEOUT="${2:-90}"; shift 2 ;;
    --timeout=*)   TIMEOUT="${1#*=}"; shift ;;
    --reopen)      PASSTHRU="$PASSTHRU --reopen"; shift ;;
    --no-reopen)   PASSTHRU="$PASSTHRU --no-reopen"; shift ;;  # 兼容旧名(现在就是默认)
    --keep-open|--no-close) PASSTHRU="$PASSTHRU --keep-open"; shift ;;  # 抓完不关小程序
    --json)        PASSTHRU="$PASSTHRU --json"; shift ;;
    --submit)      PASSTHRU="$PASSTHRU --submit"; shift ;;
    --no-start)    PASSTHRU="$PASSTHRU --no-start"; shift ;;
    --trigger)     DO_TRIGGER=1; shift ;;
    --no-trigger)  DO_TRIGGER=0; shift ;;
    --no-block)    BLOCK=0; shift ;;
    --push)        DO_PUSH=1; shift ;;
    --keep-proxy)  KEEP_PROXY=1; shift ;;
    --show)        SHOW_ONLY=1; shift ;;
    -h|--help)     awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *)             echo "[grab] 未知参数: $1" >&2; exit 3 ;;
  esac
done

# ---------- protocol 模式: 交给 grab-code.js（注入 + 协议唤起，全程自动） ----------
if [ "$MODE" = "protocol" ]; then
  [ -x "$NODE_BIN" ] || { echo "[grab] ⚠️  找不到 node ($NODE_BIN)，protocol 模式需要 node" >&2; exit 3; }
  # --push 在 protocol 模式下等价于 --submit（提交到 submit.config.json 配置的接口）
  [ "$DO_PUSH" = "1" ] && PASSTHRU="$PASSTHRU --submit"
  exec "$NODE_BIN" "$DIR/grab-code.js" --timeout "$TIMEOUT" $PASSTHRU
fi

# 下面都是 mitm 模式的逻辑
[ "$PASSTHRU" = "" ] || { echo "[grab] ⚠️  --no-reopen/--json/--submit 只在 protocol 模式有效" >&2; exit 3; }

# ---------- --show: 只读上次结果 ----------
if [ "$SHOW_ONLY" = "1" ]; then
  if [ -f "$RESULT_JSON" ]; then cat "$RESULT_JSON"; exit 0; fi
  echo "[grab] 还没有抓取结果 ($RESULT_JSON)"; exit 2
fi

log()  { echo "[grab] $*"; }
warn() { echo "[grab] ⚠️  $*" >&2; }

# ---------- 前置检查 ----------
[ -x "$MITM" ] || { warn "找不到 mitmdump ($MITM)。装一个: brew install mitmproxy"; exit 3; }
[ -f "$ADDON" ] || { warn "找不到 addon: $ADDON"; exit 3; }

port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if port_listening "$PORT"; then
  warn "端口 $PORT 已被占用 —— 可能已有一个 mitmdump/抓包会话在跑:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sed 's/^/        /' >&2
  warn "先停掉它(Ctrl-C 原会话), 或换端口: WX_PROXY_PORT=38199 ./grab-now.sh"
  exit 3
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
SESSION_DIR="${WX_GRAB_DIR:-/tmp/wx_grab}/$STAMP"
mkdir -p "$SESSION_DIR"
CODE_LOG="$SESSION_DIR/code.log"
EVENTS_LOG="$SESSION_DIR/events.log"
MITM_LOG="$SESSION_DIR/mitmdump.log"
SNAP_DIR="$SESSION_DIR/proxy-backup"

# ---------- 系统代理: 快照 / 设置 / 还原 ----------
snapshot_proxy() {
  mkdir -p "$SNAP_DIR"
  networksetup -getwebproxy       "$SERVICE" > "$SNAP_DIR/web.txt"    2>&1 || true
  networksetup -getsecurewebproxy "$SERVICE" > "$SNAP_DIR/secure.txt" 2>&1 || true
  networksetup -getautoproxyurl   "$SERVICE" > "$SNAP_DIR/auto.txt"   2>&1 || true
}

field() { awk -F': ' -v k="$2" '$1==k {sub("^" k ": ", ""); print; exit}' "$1" 2>/dev/null; }

restore_proxy() {
  [ -d "$SNAP_DIR" ] || return 0
  log "还原系统代理 ($SERVICE) 到抓取前的状态..."
  local enabled server port
  # HTTP 代理: 先写回 server/port (该命令会顺带开启代理), 再按原状态开/关
  enabled="$(field "$SNAP_DIR/web.txt" Enabled)"
  server="$(field "$SNAP_DIR/web.txt" Server)"
  port="$(field "$SNAP_DIR/web.txt" Port)"
  if [ -n "${server:-}" ] && [ -n "${port:-}" ]; then
    networksetup -setwebproxy "$SERVICE" "$server" "$port" >/dev/null 2>&1 || true
  fi
  if [ "$enabled" = "Yes" ]; then
    networksetup -setwebproxystate "$SERVICE" on  >/dev/null 2>&1 || true
  else
    networksetup -setwebproxystate "$SERVICE" off >/dev/null 2>&1 || true
  fi
  # HTTPS 代理
  enabled="$(field "$SNAP_DIR/secure.txt" Enabled)"
  server="$(field "$SNAP_DIR/secure.txt" Server)"
  port="$(field "$SNAP_DIR/secure.txt" Port)"
  if [ -n "${server:-}" ] && [ -n "${port:-}" ]; then
    networksetup -setsecurewebproxy "$SERVICE" "$server" "$port" >/dev/null 2>&1 || true
  fi
  if [ "$enabled" = "Yes" ]; then
    networksetup -setsecurewebproxystate "$SERVICE" on  >/dev/null 2>&1 || true
  else
    networksetup -setsecurewebproxystate "$SERVICE" off >/dev/null 2>&1 || true
  fi
  # PAC 自动代理
  local url aenabled
  url="$(field "$SNAP_DIR/auto.txt" URL)"
  aenabled="$(field "$SNAP_DIR/auto.txt" Enabled)"
  if [ -n "${url:-}" ] && [ "$url" != "(null)" ]; then
    networksetup -setautoproxyurl "$SERVICE" "$url" >/dev/null 2>&1 || true
  fi
  if [ "$aenabled" = "Yes" ]; then
    networksetup -setautoproxystate "$SERVICE" on  >/dev/null 2>&1 || true
  else
    networksetup -setautoproxystate "$SERVICE" off >/dev/null 2>&1 || true
  fi
  log "已还原。"
}

set_proxy() {
  networksetup -setwebproxy       "$SERVICE" 127.0.0.1 "$PORT" >/dev/null 2>&1
  networksetup -setsecurewebproxy "$SERVICE" 127.0.0.1 "$PORT" >/dev/null 2>&1
  networksetup -setwebproxystate       "$SERVICE" on
  networksetup -setsecurewebproxystate "$SERVICE" on
  networksetup -setautoproxystate "$SERVICE" off >/dev/null 2>&1 || true
}

# ---------- 触发一次"全新的农场握手" (零权限, 自动) ----------
# 农场小程序如果已经开着, 它那条旧长连接不走新代理 → 必须先关掉, 再让 QQ 重新拉起。
# 拉起用 tencent://ntqq-open/... (项目 core 里就是这么做的), 不需要任何系统权限。
togglefarm() {
  if pgrep -f 'QQEXMiniProgram' >/dev/null 2>&1; then
    log "关掉已在运行的农场小程序（旧长连接不走新代理，必须重建）"
    pkill -f 'QQEXMiniProgram' >/dev/null 2>&1 || true
    sleep 1
  fi
}

trigger_reconnect() {
  if [ -n "${WX_TRIGGER_CMD:-}" ]; then
    log "执行自定义触发命令: $WX_TRIGGER_CMD"
    eval "$WX_TRIGGER_CMD" >/dev/null 2>&1 || true
    return 0
  fi
  togglefarm
  if open "$FARM_URL" >/dev/null 2>&1; then
    log "已用 tencent:// 链接唤起 QQ 农场小程序"
    return 0
  fi
  # 兜底: 微信小程序宿主（微信侧农场走同一个网关）
  if pgrep -f 'WeChatAppEx\.app' >/dev/null 2>&1; then
    open -b com.tencent.flue.WeChatAppEx >/dev/null 2>&1 && { log "已唤起微信小程序窗口"; return 0; }
  fi
  warn "自动唤起农场失败, 请手动打开 QQ 农场"
  return 1
}

# ---------- 读 code 日志 ----------
# 输出: 捕获到的 code 记录(JSON), 没有则退出码 1
read_code() {
  [ -s "$CODE_LOG" ] || return 1
  "$PY" - "$CODE_LOG" <<'PY'
import json, sys
last = None
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if '"code"' not in line:
                continue
            i = line.find('{')
            if i < 0:
                continue
            try:
                rec = json.loads(line[i:])
            except Exception:
                continue
            if rec.get('code'):
                last = rec
except FileNotFoundError:
    pass
if last:
    print(json.dumps(last, ensure_ascii=False))
    sys.exit(0)
sys.exit(1)
PY
}

# ---------- 清理 ----------
MITM_PID=""
CLEANED=0
cleanup() {
  [ "$CLEANED" = "1" ] && return 0
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
    warn "按 --keep-proxy 要求, 系统代理保持开启 (记得手动关: networksetup -setwebproxystate \"$SERVICE\" off)"
  else
    restore_proxy
  fi
}
trap cleanup EXIT INT TERM

# ---------- 主流程 ----------
echo "============================================================"
log "会话目录: $SESSION_DIR"
log "模式: $([ "$BLOCK" = "1" ] && echo '拦截握手(拿未消费 code)' || echo '被动放行(不拦截)')  最长等待 ${TIMEOUT}s"

snapshot_proxy
log "已备份系统代理配置 -> $SNAP_DIR"

# 默认不上报, 避免误触发账号重启; 显式 --push 才带上机器人参数
if [ "$DO_PUSH" = "1" ]; then
  if [ -z "${WX_SERVER_URL:-}" ] || [ -z "${WX_ACCOUNT_ID:-}" ]; then
    warn "--push 需要 WX_SERVER_URL / WX_ACCOUNT_ID (token 见 WX_ADMIN_TOKEN), 本次不上报"
  else
    log "抓到后将上报机器人: $WX_SERVER_URL (账号 $WX_ACCOUNT_ID)"
  fi
else
  unset WX_SERVER_URL
fi

log "启动 mitmdump (端口 $PORT)..."
MITM_ARGS=(
  -s "$ADDON"
  --listen-port "$PORT"
  --set termlog_verbosity=warn
  --set flow_detail=0
)
if [ "${WX_CAPTURE_HTTP_ALL:-0}" = "1" ]; then
  MITM_ARGS+=(--set 'allow_hosts=.*')
else
  MITM_ARGS+=(--set 'allow_hosts=nqf\.qq\.com' '~d nqf.qq.com')
fi
WX_BLOCK="$BLOCK" \
WX_REFRESH_SEC=0 \
WX_CAPTURE_WS=0 \
WX_CODE_LOG="$CODE_LOG" \
WX_EVENTS_LOG="$EVENTS_LOG" \
"$MITM" "${MITM_ARGS[@]}" > "$MITM_LOG" 2>&1 &
MITM_PID=$!

# 等端口就绪
READY=0
for _ in $(seq 1 40); do
  port_listening "$PORT" && { READY=1; break; }
  kill -0 "$MITM_PID" 2>/dev/null || break
  sleep 0.25
done
if [ "$READY" != "1" ]; then
  warn "mitmdump 没起来, 日志尾部:"
  tail -n 20 "$MITM_LOG" 2>/dev/null | sed 's/^/        /' >&2
  exit 3
fi
log "mitmdump 就绪."

set_proxy
if [ "${WX_CAPTURE_HTTP_ALL:-0}" = "1" ]; then
  log "系统代理已指向 127.0.0.1:$PORT (抓取所有 HTTP/HTTPS 域名)"
else
  log "系统代理已指向 127.0.0.1:$PORT (仅解密 nqf.qq.com, 其它域名透传)"
fi
sleep 0.5
echo "------------------------------------------------------------"

if [ "$DO_TRIGGER" = "1" ]; then
  trigger_reconnect
  log "农场已自动唤起，无需你操作 —— 在等它的新握手"
else
  log "请手动打开一次 QQ 农场 (要自动唤起可加 --trigger)"
fi
log "等待新的农场握手 (带 code)...  剩余 ${TIMEOUT}s"

# 递进式提示: 全自动流程下的兜底说明
HINTS=(
  "👉 农场已自动关掉并重开，等它加载完就会发起新握手（首次加载要十几秒，稍等）"
  "👉 还没握手: 确认 QQ 在跑且已登录；或代理没对 QQ 生效（旧连接不走代理）"
  "👉 仍然没有: 换 protocol 模式试试 —— ./grab-now.sh（默认就是它，走缓存注入，3s 出 code）"
  "👉 最后手段: 手动打开一次 QQ 农场，或 Ctrl-C 后重跑: ./grab-now.sh --mode mitm --timeout 180"
)
HINT_AT=(12 30 60 90)
HINT_I=0

DEADLINE=$(( $(date +%s) + TIMEOUT ))
NEXT_TICK=10
RETRIGGER_AT=30
FOUND=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if FOUND="$(read_code)"; then
    break
  fi
  ELAPSED=$(( TIMEOUT - (DEADLINE - $(date +%s)) ))
  if [ "$HINT_I" -lt "${#HINTS[@]}" ] && [ "$ELAPSED" -ge "${HINT_AT[$HINT_I]}" ]; then
    warn "还没抓到。${HINTS[$HINT_I]}"
    HINT_I=$(( HINT_I + 1 ))
  fi
  if [ "$DO_TRIGGER" = "1" ] && [ "$ELAPSED" -ge "$RETRIGGER_AT" ]; then
    RETRIGGER_AT=$(( RETRIGGER_AT + 45 ))
    log "再自动唤起一次小程序..."
    trigger_reconnect >/dev/null 2>&1 || true
  fi
  if [ "$ELAPSED" -ge "$NEXT_TICK" ]; then
    NEXT_TICK=$(( NEXT_TICK + 10 ))
    log "等待中... 已等 ${ELAPSED}s / ${TIMEOUT}s  剩余 $(( DEADLINE - $(date +%s) ))s"
  fi
  sleep 0.5
done

echo "------------------------------------------------------------"
if [ -n "$FOUND" ]; then
  "$PY" - "$FOUND" "$RESULT_JSON" "$SESSION_DIR" <<'PY'
import json, sys, time
rec = json.loads(sys.argv[1])
rec['session'] = sys.argv[3]
rec['grabbed_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    f.write(json.dumps(rec, ensure_ascii=False, indent=2))
PY
  CODE="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["code"])' "$FOUND")"
  UNUSED="$("$PY" -c 'import json,sys; r=json.loads(sys.argv[1]); print("是(未被消费, 可直接用)" if r.get("unused") else "否(可能已被客户端消费)")' "$FOUND")"
  echo ""
  echo "================= 抓到了 ================="
  echo "code      : $CODE"
  echo "host      : $("$PY" -c 'import json,sys; print(json.loads(sys.argv[1]).get("host",""))' "$FOUND")"
  echo "握手来源  : $("$PY" -c 'import json,sys; print(json.loads(sys.argv[1]).get("source",""))' "$FOUND")"
  echo "未消费    : $UNUSED"
  echo "结果文件  : $RESULT_JSON"
  echo "会话目录  : $SESSION_DIR"
  echo "=========================================="
  log "本次事件日志尾部:"
  tail -n 8 "$EVENTS_LOG" 2>/dev/null | sed 's/^/        /'
  exit 0
fi

warn "超时 ${TIMEOUT}s 没抓到新的 code。排查建议:"
echo "  1) 农场已自动关掉重开过; 若仍无握手, 说明它的连接没走代理(旧长连接不走新代理)"
echo "  2) 首次使用先信任证书: ./setup-cert.sh"
echo "  3) QQ/微信 若对 nqf.qq.com 做证书固定会解密失败(微信实测可解, QQ 待验证)"
echo "  4) 直接换默认模式更快更稳: ./grab-now.sh --timeout 120   # protocol 注入法, 3s 出 code"
echo ""
log "mitmdump 日志尾部 ($MITM_LOG):"
tail -n 20 "$MITM_LOG" 2>/dev/null | sed 's/^/        /'
log "事件日志尾部 ($EVENTS_LOG):"
tail -n 10 "$EVENTS_LOG" 2>/dev/null | sed 's/^/        /'
exit 2
