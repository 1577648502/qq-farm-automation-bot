#!/usr/bin/env bash
# 一条命令完成活动抓包：
#   启动代理 -> 自动重开 QQ 农场 -> 等新 WS 连接 -> 定时停止 -> 恢复代理
#   -> 自动解密落盘 -> 生成接口 summary
#
# 用法:
#   ./capture-activity.sh <活动名>
#   ./capture-activity.sh <活动名> --duration 240
#   ./capture-activity.sh <活动名> --no-trigger
#   ./capture-activity.sh <活动名> --duration 0        # 只用 Ctrl-C 手动停止
#   ./capture-activity.sh --decode captures/xxx.jsonl  # 只对已有原始包解密
#   ./capture-activity.sh --decode-latest              # 解密最新原始包
#   ./capture-activity.sh --summarize-http captures/xxx.http.jsonl
#                                                       # 只分析已有 HTTP 抓包
#
# 默认行为:
#   - 抓包 180s 后自动停止 (从检测到第一条 ws_open 开始计时)
#   - macOS 上如果 QQ 在运行, 自动关闭 QQEXMiniProgram 并用 tencent:// 重开农场
#   - 微信农场无法可靠自动重开, 请加 --no-trigger 后手动退出/重进农场
#   - 原始帧写到 <活动>.jsonl, 解密帧写到 <活动>.decoded.jsonl
#   - 接口清单写到 <活动>.summary.txt
#
# 环境变量:
#   WX_CAPTURE_SECONDS     抓到连接后的抓取时长, 默认 180; 0=手动停止
#   WX_CONNECT_TIMEOUT     等待新 WS 连接的超时, 默认 60
#   WX_AUTO_TRIGGER        默认 0 (不自动唤起, 自己打开农场); 1 等同 --trigger
#   WX_LIVE_DECODE         默认 1; 实时解码显示
#   WX_AUTO_DECODE         默认 1; 结束后解密并生成 summary
#   WX_CAPTURE_HTTP_ALL    默认 1; 同时抓所有 HTTP/HTTPS (微信宿主/游戏圈接口)
#   WX_NET_SERVICE / WX_PROXY_PORT / WX_MARKER_FILE / WX_CAPTURE_DIR
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$DIR/../core"
FARM_URL='tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D'
NODE_BIN="${WX_NODE:-$(command -v node 2>/dev/null || true)}"
PY="${WX_PYTHON:-/usr/bin/python3}"

DURATION="${WX_CAPTURE_SECONDS:-180}"
CONNECT_TIMEOUT="${WX_CONNECT_TIMEOUT:-60}"
TRIGGER_RETRY_SEC="${WX_TRIGGER_RETRY_SEC:-25}"
# 2026-11-16 起默认不自动唤起农场, 用户自己打开; 要旧行为加 --trigger
AUTO_TRIGGER="${WX_AUTO_TRIGGER:-0}"
LIVE_DECODE="${WX_LIVE_DECODE:-1}"
AUTO_DECODE="${WX_AUTO_DECODE:-1}"
HTTP_CAPTURE="${WX_CAPTURE_HTTP_ALL:-1}"
NAME=""
DECODE_INPUT=""
DECODE_LATEST=0
HTTP_SUMMARY_INPUT=""
CAPTURE_DIR_ARG=""

usage() {
  awk 'NR > 1 && /^#/ {sub(/^# ?/, ""); print; next} NR > 1 {exit}' "$0"
}

require_int() {
  case "$2" in
    ''|*[!0-9]*) echo "[capture] $1 必须是非负整数: $2" >&2; exit 3 ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --duration)
      [ "$#" -ge 2 ] || { echo "[capture] --duration 缺少秒数" >&2; exit 3; }
      DURATION="$2"
      shift 2
      ;;
    --duration=*)
      DURATION="${1#*=}"
      shift
      ;;
    --wait)
      [ "$#" -ge 2 ] || { echo "[capture] --wait 缺少秒数" >&2; exit 3; }
      CONNECT_TIMEOUT="$2"
      shift 2
      ;;
    --wait=*)
      CONNECT_TIMEOUT="${1#*=}"
      shift
      ;;
    --trigger)
      AUTO_TRIGGER=1
      shift
      ;;
    --no-trigger)
      AUTO_TRIGGER=0
      shift
      ;;
    --live)
      LIVE_DECODE=1
      shift
      ;;
    --no-live)
      LIVE_DECODE=0
      shift
      ;;
    --summary)
      AUTO_DECODE=1
      shift
      ;;
    --no-summary)
      AUTO_DECODE=0
      shift
      ;;
    --http-all)
      HTTP_CAPTURE=1
      shift
      ;;
    --no-http-all)
      HTTP_CAPTURE=0
      shift
      ;;
    --decode)
      [ "$#" -ge 2 ] || { echo "[capture] --decode 缺少抓包文件" >&2; exit 3; }
      DECODE_INPUT="$2"
      shift 2
      ;;
    --decode=*)
      DECODE_INPUT="${1#*=}"
      shift
      ;;
    --decode-latest)
      DECODE_LATEST=1
      shift
      ;;
    --summarize-http)
      [ "$#" -ge 2 ] || { echo "[capture] --summarize-http 缺少 HTTP 抓包文件" >&2; exit 3; }
      HTTP_SUMMARY_INPUT="$2"
      shift 2
      ;;
    --summarize-http=*)
      HTTP_SUMMARY_INPUT="${1#*=}"
      shift
      ;;
    --captures-dir)
      [ "$#" -ge 2 ] || { echo "[capture] --captures-dir 缺少目录" >&2; exit 3; }
      CAPTURE_DIR_ARG="$2"
      shift 2
      ;;
    --captures-dir=*)
      CAPTURE_DIR_ARG="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "[capture] 未知参数: $1" >&2
      usage >&2
      exit 3
      ;;
    *)
      if [ -n "$NAME" ]; then
        echo "[capture] 只能指定一个活动名: $NAME / $1" >&2
        exit 3
      fi
      NAME="$1"
      shift
      ;;
  esac
done

if [ -n "$DECODE_INPUT" ] && [ "$DECODE_LATEST" = "1" ]; then
  echo "[capture] --decode 与 --decode-latest 只能使用一个" >&2
  exit 3
fi
if [ -n "$HTTP_SUMMARY_INPUT" ] &&
   { [ -n "$DECODE_INPUT" ] || [ "$DECODE_LATEST" = "1" ] || [ -n "$NAME" ]; }; then
  echo "[capture] --summarize-http 只能单独使用" >&2
  exit 3
fi
if { [ -n "$DECODE_INPUT" ] || [ "$DECODE_LATEST" = "1" ]; } && [ -n "$NAME" ]; then
  echo "[capture] 离线解密模式不能同时指定活动名: $NAME" >&2
  exit 3
fi
if [ -z "$NAME" ] && [ -z "$DECODE_INPUT" ] && [ -z "$HTTP_SUMMARY_INPUT" ] &&
   [ "$DECODE_LATEST" != "1" ]; then
  usage >&2
  exit 3
fi
require_int "WX_CAPTURE_SECONDS/--duration" "$DURATION"
require_int "WX_CONNECT_TIMEOUT/--wait" "$CONNECT_TIMEOUT"
require_int "WX_TRIGGER_RETRY_SEC" "$TRIGGER_RETRY_SEC"

CAPTURE_DIR="${CAPTURE_DIR_ARG:-${WX_CAPTURE_DIR:-$DIR/captures}}"
mkdir -p "$CAPTURE_DIR"

log()  { echo "[capture] $*"; }
warn() { echo "[capture] ⚠️  $*" >&2; }

has_node() {
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] && [ -d "$CORE_DIR/node_modules" ]
}

find_latest_capture() {
  local dir="$1"
  [ -d "$dir" ] || return 1
  find "$dir" -maxdepth 1 -type f -name '*.jsonl' \
    ! -name '*.decoded.jsonl' ! -name '*.http.jsonl' \
    -exec stat -f '%m %N' {} + 2>/dev/null \
    | sort -nr \
    | head -n 1 \
    | cut -d' ' -f2-
}

frame_count_file() {
  local file="$1"
  [ -s "$file" ] || { echo 0; return; }
  local n
  n="$(grep -Ec '"hex"[[:space:]]*:' "$file" 2>/dev/null || true)"
  echo "${n:-0}"
}

http_count_file() {
  local file="$1"
  [ -s "$file" ] || { echo 0; return; }
  local n
  n="$(grep -Ec '"ev"[[:space:]]*:[[:space:]]*"http"' "$file" 2>/dev/null || true)"
  echo "${n:-0}"
}

summarize_http_capture() {
  local input="$1"
  local summary="${input%.jsonl}.summary.txt"
  [ -s "$input" ] || return 2
  "$PY" - "$input" "$summary" <<'PY'
import collections
import json
import sys
import time
from urllib.parse import unquote, urlsplit

source, target = sys.argv[1:3]
records = []
with open(source, encoding='utf-8') as f:
    for line in f:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get('ev') == 'http':
            records.append(rec)


def decode_jsonish(value, depth=3):
    """Decode URL-encoded JSON layers used by WeChat's report payload."""
    current = value
    for _ in range(depth):
        if not isinstance(current, str):
            return current
        decoded = unquote(current)
        try:
            return json.loads(decoded)
        except Exception:
            if decoded == current:
                break
            current = decoded
    return None


def wechat_gift_actions(rec):
    """Extract acsactionexec reward handoffs hidden in reportgamewebruntime."""
    req = rec.get('request') or {}
    body_text = req.get('body_text') or ''
    if 'acsactionexec' not in body_text and 'action_send_reward' not in body_text:
        return []
    try:
        payload = json.loads(body_text)
    except Exception:
        return []

    actions = []
    for batch in payload.get('batchdata') or []:
        if not isinstance(batch, dict):
            continue
        target = unquote(str(batch.get('Target') or ''))
        params = decode_jsonish(batch.get('Params'))
        result = decode_jsonish(batch.get('Result')) or {}
        req_params = (params or {}).get('req') or {}
        action_map = req_params.get('comm_action_params_map') or {}
        if 'acsactionexec' not in target and 'action_send_reward' not in action_map:
            continue
        for action_name, action_value in action_map.items():
            action_value = action_value if isinstance(action_value, dict) else {}
            action_params = decode_jsonish(action_value.get('param')) or {}
            actions.append({
                'ts': float(rec.get('ts') or 0),
                'host': rec.get('host') or '',
                'method': rec.get('method') or '',
                'target': target.split('?', 1)[0],
                'action': action_name,
                'reward_id': action_params.get('reward_id'),
                'key': action_value.get('key'),
                'appid': action_params.get('appid'),
                'ck': action_params.get('ck'),
                'amount': action_params.get('amount'),
                'errcode': result.get('errcode'),
                'err_msg': result.get('err_msg'),
                'fetchtype': result.get('fetchtype'),
                'webtransfer': result.get('webtransfer'),
            })
    return actions


gift_actions = []
for rec in records:
    gift_actions.extend(wechat_gift_actions(rec))

direct_action_requests = []
for rec in records:
    path = urlsplit(rec.get('url') or '').path
    if path.endswith('/acsactionexec'):
        direct_action_requests.append(rec)

groups = collections.Counter()
for rec in records:
    req = rec.get('request') or {}
    resp = rec.get('response') or {}
    host = rec.get('host') or ''
    path = urlsplit(rec.get('url') or '').path or '/'
    groups[(rec.get('method') or '', host, path, resp.get('status_code'))] += 1

keywords = (
    'claim', 'gift', 'reward', 'email', 'fertilizer', 'daily', 'weekend',
    '领取', '礼包', '邮件', '化肥', '每日', '周末',
)
hits = []
for rec in records:
    searchable = json.dumps(rec, ensure_ascii=False).lower()
    matched = [word for word in keywords if word in searchable]
    if not matched:
        continue
    req = rec.get('request') or {}
    resp = rec.get('response') or {}
    body = ((req.get('body_text') or '') + ' ' + (resp.get('body_text') or '')).lower()
    if not any(word in body for word in matched) and not any(
        word in (rec.get('url') or '').lower() for word in matched
    ):
        continue
    hits.append((rec, matched))


def preview_text(value, limit=500):
    text = str(value or '')
    text = ''.join(ch if ch in '\t\n\r' or ord(ch) >= 32 else ' ' for ch in text)
    return text[:limit].replace('\n', ' ')


with open(target, 'w', encoding='utf-8') as out:
    out.write('HTTP/HTTPS capture summary\n')
    out.write('records: %d\n' % len(records))
    if records:
        start = min(float(r.get('ts') or 0) for r in records)
        end = max(float(r.get('ts') or 0) for r in records)
        out.write('time range: %.3f .. %.3f (%.1fs)\n' % (start, end, max(0, end - start)))
    out.write('\nWeChat gift/reward handoffs: %d\n' % len(gift_actions))
    for action in gift_actions:
        stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(action['ts']))
        out.write(
            '  %s  action=%s reward_id=%s key=%s appid=%s amount=%s\n'
            % (
                stamp, action['action'] or '?', action['reward_id'] or '?',
                action['key'] or '?', action['appid'] or '?', action['amount'],
            )
        )
        out.write(
            '    via=%s %s  errcode=%s webTransfer=%s fetchtype=%s\n'
            % (
                action['method'] or '?', action['host'] or '?',
                action['errcode'], action['webtransfer'], action['fetchtype'] or '?',
            )
        )
    if gift_actions:
        out.write(
            '  note: webTransfer means the WeChat host performs the final request; '
            'the mini program only reports this handoff.\n'
        )
    out.write('Direct acsactionexec HTTP requests: %d\n' % len(direct_action_requests))
    for rec in direct_action_requests[:20]:
        resp = rec.get('response') or {}
        out.write('  %-6s %-3s %s\n' % (
            rec.get('method') or '?',
            resp.get('status_code') if resp.get('status_code') is not None else '-',
            rec.get('url') or '',
        ))

    out.write('\nEndpoints (top 80 of %d):\n' % len(groups))
    for (method, host, path, status), count in groups.most_common(80):
        out.write('  %4d  %-6s %-3s %s%s\n' % (
            count, method or '?', status if status is not None else '-', host, path))
    out.write('\nGift/email/fertilizer candidates: %d\n' % len(hits))
    for rec, matched in hits[-100:]:
        req = rec.get('request') or {}
        resp = rec.get('response') or {}
        marker = rec.get('marker')
        out.write('  %-6s %-3s %s  matched=%s%s\n' % (
            rec.get('method') or '?',
            resp.get('status_code') if resp.get('status_code') is not None else '-',
            rec.get('url') or '',
            ','.join(matched),
            ('  marker=' + marker) if marker else '',
        ))
        body = (req.get('body_text') or '')[:500]
        if body:
            out.write('    request: %s\n' % preview_text(body))
        body = (resp.get('body_text') or '')[:500]
        if body:
            out.write('    response: %s\n' % preview_text(body))
print(target)
PY
}

decode_capture() {
  local input="$1"
  local decoded summary status frames
  if ! has_node; then
    warn "未检测到 node 或 core/node_modules，无法自动解密"
    return 3
  fi
  if [ ! -f "$input" ]; then
    warn "抓包文件不存在: $input"
    return 2
  fi
  if [ ! -s "$input" ]; then
    warn "抓包文件为空，原始包保留: $input"
    return 2
  fi
  frames="$(frame_count_file "$input")"
  if [ "$frames" -eq 0 ]; then
    warn "抓包中没有游戏帧，跳过解密；原始包保留: $input"
    return 2
  fi

  input="$(cd "$(dirname "$input")" && pwd)/$(basename "$input")"
  decoded="${input%.jsonl}.decoded.jsonl"
  summary="${input%.jsonl}.summary.txt"
  log "自动解密并生成接口清单..."
  (
    cd "$CORE_DIR" &&
    "$NODE_BIN" scripts/ws-capture-decode.js --capture "$input"
  )
  status=$?
  if [ "$status" -ne 0 ]; then
    warn "解密失败，退出码 $status；原始包已保留: $input"
    warn "可重试: cd \"$CORE_DIR\" && \"$NODE_BIN\" scripts/ws-capture-decode.js --capture \"$input\""
    return 3
  fi
  if [ ! -s "$decoded" ]; then
    warn "没有生成有效解密帧；原始包已保留: $input"
    return 3
  fi
  if [ ! -s "$summary" ]; then
    warn "没有生成接口清单；原始包已保留: $input"
    return 3
  fi
  log "解密帧: $decoded ($(wc -l < "$decoded" | tr -d ' ') 行)"
  log "接口清单: $summary"
  return 0
}

if [ -n "$HTTP_SUMMARY_INPUT" ]; then
  if [ ! -f "$HTTP_SUMMARY_INPUT" ]; then
    warn "HTTP 抓包文件不存在: $HTTP_SUMMARY_INPUT"
    exit 2
  fi
  summarize_http_capture "$HTTP_SUMMARY_INPUT"
  exit $?
fi

if [ -n "$DECODE_INPUT" ] || [ "$DECODE_LATEST" = "1" ]; then
  if [ "$DECODE_LATEST" = "1" ]; then
    DECODE_INPUT="$(find_latest_capture "$CAPTURE_DIR" || true)"
    if [ -z "$DECODE_INPUT" ]; then
      warn "目录中没有原始 .jsonl 抓包: $CAPTURE_DIR"
      exit 2
    fi
    log "最新原始抓包: $DECODE_INPUT"
  fi
  decode_capture "$DECODE_INPUT"
  DECODE_STATUS=$?
  HTTP_SIDECAR="${DECODE_INPUT%.jsonl}.http.jsonl"
  if [ -s "$HTTP_SIDECAR" ]; then
    log "同时分析 HTTP 抓包..."
    summarize_http_capture "$HTTP_SIDECAR" >/dev/null || DECODE_STATUS=3
    log "HTTP 清单: ${HTTP_SIDECAR%.jsonl}.summary.txt"
  fi
  exit "$DECODE_STATUS"
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
SAFE_NAME="$(printf '%s' "$NAME" | tr '/:' '__')"
BASE="$CAPTURE_DIR/${STAMP}_${SAFE_NAME}"
SUFFIX=1
while [ -e "$BASE.jsonl" ]; do
  BASE="$CAPTURE_DIR/${STAMP}_${SAFE_NAME}_$SUFFIX"
  SUFFIX=$(( SUFFIX + 1 ))
done
OUT="$BASE.jsonl"
DECODED="$BASE.decoded.jsonl"
SUMMARY="$BASE.summary.txt"
HTTP_OUT="$BASE.http.jsonl"
HTTP_SUMMARY="$BASE.http.summary.txt"
PROXY_BACKUP="$BASE.proxy-backup"

RUNTIME_DIR="${TMPDIR:-/tmp}/wx_activity_capture_${STAMP}_$$"
mkdir -p "$RUNTIME_DIR"
READY_FILE="$RUNTIME_DIR/ready"
MARKER_FILE="${WX_MARKER_FILE:-$RUNTIME_DIR/marker}"

export WX_CAPTURE_WS=1
export WX_WS_CAPTURE_LOG="$OUT"
export WX_SESSION="$NAME"
export WX_REFRESH_SEC=0
export WX_BLOCK=0
export WX_RUN_DURATION=0
export WX_READY_FILE="$READY_FILE"
export WX_MARKER_FILE="$MARKER_FILE"
export WX_PROXY_SNAPSHOT_DIR="$PROXY_BACKUP"
export WX_CAPTURE_HTTP_ALL="$HTTP_CAPTURE"
export WX_HTTP_CAPTURE_LOG="$HTTP_OUT"

RUN_PID=""
LIVE_PID=""
MANUAL_STOP=0
RUN_DIED=0
WS_CONNECTED=0
STOP_REASON=""

has_event() {
  [ -s "$OUT" ] || return 1
  grep -Eq "\"ev\"[[:space:]]*:[[:space:]]*\"$1\"" "$OUT"
}

frame_count() {
  frame_count_file "$OUT"
}

trigger_farm() {
  if [ "$AUTO_TRIGGER" != "1" ]; then
    return 1
  fi

  if [ -n "${WX_TRIGGER_CMD:-}" ]; then
    log "执行自定义触发命令"
    eval "$WX_TRIGGER_CMD" >/dev/null 2>&1 || true
    return 0
  fi

  if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
    warn "自动触发目前只实现 macOS/QQ；请手动重开农场"
    return 1
  fi
  if ! pgrep -x QQ >/dev/null 2>&1 && ! pgrep -f 'QQEXMiniProgram' >/dev/null 2>&1; then
    warn "未检测到运行中的 QQ；为避免误拉起，请手动打开 QQ 农场"
    return 1
  fi

  if pgrep -f 'QQEXMiniProgram' >/dev/null 2>&1; then
    log "关闭旧 QQ 农场小程序，强制建立新的 WS 连接"
    pkill -f 'QQEXMiniProgram' >/dev/null 2>&1 || true
    sleep 1
  fi
  if open "$FARM_URL" >/dev/null 2>&1; then
    log "已让 QQ 自动重开农场"
    return 0
  fi

  warn "tencent:// 唤起失败，请手动重开 QQ 农场"
  return 1
}

stop_capture() {
  [ -n "$RUN_PID" ] || return 0
  if kill -0 "$RUN_PID" 2>/dev/null; then
    kill -TERM "$RUN_PID" 2>/dev/null || true
  fi
  wait "$RUN_PID" 2>/dev/null || true
  RUN_PID=""
}

on_signal() {
  MANUAL_STOP=1
  STOP_REASON="手动停止"
  stop_capture
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_capture
  if [ -n "$LIVE_PID" ] && kill -0 "$LIVE_PID" 2>/dev/null; then
    kill -TERM "$LIVE_PID" 2>/dev/null || true
    wait "$LIVE_PID" 2>/dev/null || true
    LIVE_PID=""
  fi
  exit "$status"
}

trap cleanup EXIT
trap on_signal INT TERM

echo "============================================================"
log "会话: $NAME"
log "原始帧: $OUT"
log "解密帧: $DECODED"
log "接口清单: $SUMMARY"
if [ "$HTTP_CAPTURE" = "1" ]; then
  log "HTTP/HTTPS: $HTTP_OUT"
fi
log "抓取时长: $([ "$DURATION" -gt 0 ] && echo "${DURATION}s (检测到 WS 连接后计时)" || echo '手动 Ctrl-C')"
log "等待连接: ${CONNECT_TIMEOUT}s"
log "自动触发: $([ "$AUTO_TRIGGER" = "1" ] && echo '开 (仅 macOS/QQ)' || echo '关')"
echo "============================================================"

"$DIR/run.sh" &
RUN_PID=$!

READY=0
for _ in $(seq 1 80); do
  if [ -f "$READY_FILE" ]; then
    READY=1
    break
  fi
  if ! kill -0 "$RUN_PID" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [ "$READY" != "1" ]; then
  RUN_STATUS=0
  wait "$RUN_PID" 2>/dev/null || RUN_STATUS=$?
  RUN_PID=""
  warn "抓包代理没有就绪 (run.sh 退出码 $RUN_STATUS)"
  exit 3
fi

if has_node && [ "$LIVE_DECODE" = "1" ]; then
  log "实时解密已开启"
  (cd "$CORE_DIR" && exec "$NODE_BIN" scripts/ws-capture-decode.js --follow --in "$OUT") &
  LIVE_PID=$!
elif [ "$LIVE_DECODE" = "1" ]; then
  warn "未检测到 node 或 core/node_modules，跳过实时解密"
fi

TRIGGERED=0
if trigger_farm; then
  TRIGGERED=1
else
  log "请手动退出并重新进入农场；连接建立后会开始倒计时"
  log "打标记: WX_MARKER_FILE='$MARKER_FILE' ./mark.sh \"操作说明\""
fi

WAIT_START="$(date +%s)"
NEXT_RETRY="$TRIGGER_RETRY_SEC"
NEXT_HINT=10
while :; do
  if [ "$MANUAL_STOP" = "1" ]; then
    STOP_REASON="手动停止"
    break
  fi
  if has_event ws_open; then
    WS_CONNECTED=1
    break
  fi
  if ! kill -0 "$RUN_PID" 2>/dev/null; then
    RUN_DIED=1
    STOP_REASON="抓包进程意外退出"
    break
  fi
  ELAPSED=$(( $(date +%s) - WAIT_START ))
  if [ "$ELAPSED" -ge "$CONNECT_TIMEOUT" ]; then
    STOP_REASON="等待新 WS 连接超时"
    break
  fi
  if [ "$ELAPSED" -ge "$NEXT_HINT" ]; then
    warn "仍在等待 WS 连接... ${ELAPSED}s / ${CONNECT_TIMEOUT}s"
    NEXT_HINT=$(( NEXT_HINT + 15 ))
  fi
  if [ "$AUTO_TRIGGER" = "1" ] && [ "$TRIGGERED" = "1" ] &&
     [ "$TRIGGER_RETRY_SEC" -gt 0 ] && [ "$ELAPSED" -ge "$NEXT_RETRY" ]; then
    log "连接仍未建立，自动重开农场再试一次"
    trigger_farm >/dev/null 2>&1 || true
    NEXT_RETRY=$(( NEXT_RETRY + TRIGGER_RETRY_SEC ))
  fi
  sleep 0.5
done

if [ "$WS_CONNECTED" = "1" ]; then
  log "检测到新 WS 连接，开始抓活动数据"
  if [ "$DURATION" -gt 0 ]; then
    DEADLINE=$(( $(date +%s) + DURATION ))
    NEXT_TICK=15
    while :; do
      if [ "$MANUAL_STOP" = "1" ]; then
        STOP_REASON="手动停止"
        break
      fi
      if ! kill -0 "$RUN_PID" 2>/dev/null; then
        RUN_DIED=1
        STOP_REASON="抓包进程意外退出"
        break
      fi
      NOW="$(date +%s)"
      if [ "$NOW" -ge "$DEADLINE" ]; then
        STOP_REASON="达到抓取时长"
        break
      fi
      REMAIN=$(( DEADLINE - NOW ))
      if [ "$REMAIN" -le "$NEXT_TICK" ]; then
        log "正在抓取，剩余 ${REMAIN}s（已抓 $(frame_count) 帧）"
        NEXT_TICK=$(( REMAIN - 15 ))
      fi
      sleep 0.5
    done
  else
    log "手动停止模式：操作完成后按 Ctrl-C"
    while kill -0 "$RUN_PID" 2>/dev/null; do
      if [ "$MANUAL_STOP" = "1" ]; then
        break
      fi
      sleep 0.5
    done
    if [ "$MANUAL_STOP" != "1" ]; then
      RUN_DIED=1
      STOP_REASON="抓包进程意外退出"
    fi
  fi
fi

STOP_REASON="${STOP_REASON:-停止抓包}"
log "停止抓包: $STOP_REASON"
stop_capture

if [ -n "$LIVE_PID" ] && kill -0 "$LIVE_PID" 2>/dev/null; then
  kill -TERM "$LIVE_PID" 2>/dev/null || true
  wait "$LIVE_PID" 2>/dev/null || true
  LIVE_PID=""
fi

RAW_LINES=0
if [ -f "$OUT" ]; then
  RAW_LINES="$(wc -l < "$OUT" | tr -d ' ')"
fi
FRAMES="$(frame_count)"
HTTP_RECORDS="$(http_count_file "$HTTP_OUT")"
log "原始记录: ${RAW_LINES} 行 / ${FRAMES} 帧 / ${HTTP_RECORDS} 条 HTTP"

FINAL_STATUS=0
if [ "$MANUAL_STOP" = "1" ] && [ "$WS_CONNECTED" != "1" ]; then
  FINAL_STATUS=130
elif [ "$WS_CONNECTED" != "1" ] || [ "$RUN_DIED" = "1" ]; then
  FINAL_STATUS=2
fi

if [ "$AUTO_DECODE" = "1" ]; then
  if [ "$FRAMES" -eq 0 ]; then
    warn "没有抓到游戏帧，跳过解密"
  else
    echo "------------------------------------------------------------"
    decode_capture "$OUT"
    DECODE_STATUS=$?
    if [ "$DECODE_STATUS" -ne 0 ]; then
      FINAL_STATUS=3
    fi
    echo "------------------------------------------------------------"
  fi
  if [ "$HTTP_RECORDS" -gt 0 ]; then
    log "生成 HTTP/HTTPS 接口清单..."
    if summarize_http_capture "$HTTP_OUT" >/dev/null; then
      log "HTTP 清单: $HTTP_SUMMARY"
    else
      warn "HTTP 清单生成失败: $HTTP_OUT"
      [ "$FINAL_STATUS" -eq 0 ] && FINAL_STATUS=3
    fi
  fi
  if [ "$FRAMES" -eq 0 ] && [ "$HTTP_RECORDS" -eq 0 ]; then
    [ "$FINAL_STATUS" -eq 0 ] && FINAL_STATUS=2
  fi
else
  log "按配置跳过自动解密"
fi

echo ""
echo "=================== 抓包产物 ==================="
echo "原始帧    : $OUT"
if [ -s "$DECODED" ]; then
  echo "解密帧    : $DECODED ($(wc -l < "$DECODED" | tr -d ' ') 行)"
fi
if [ -s "$SUMMARY" ]; then
  echo "接口清单  : $SUMMARY"
fi
if [ -s "$HTTP_OUT" ]; then
  echo "HTTP 抓包 : $HTTP_OUT ($HTTP_RECORDS 条)"
fi
if [ -s "$HTTP_SUMMARY" ]; then
  echo "HTTP 清单 : $HTTP_SUMMARY"
fi
echo "抓取状态  : $STOP_REASON"
echo "================================================"
if has_node; then
  echo "详细字段:"
  echo "  cd \"$CORE_DIR\" && \"$NODE_BIN\" scripts/ws-capture-decode.js --in \"$OUT\" --filter <接口名>"
fi

exit "$FINAL_STATUS"
