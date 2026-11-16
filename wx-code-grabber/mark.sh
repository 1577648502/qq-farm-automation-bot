#!/usr/bin/env bash
# 抓包时间线打标记 (配合 capture-activity.sh 使用)
#
# 用法 (另开终端执行):
#   ./mark.sh 进入活动页
#   ./mark.sh 领取奖励1
#   ./mark.sh                  # 不带参数则用当前时间作为标记
#
# 原理: 往标记文件写 label, mitm_addon.py 每秒轮询, 读到后写一条
# {"ev":"mark"} 事件进抓包文件; ws-capture-decode.js 会把它显示成时间线分隔线。
set -uo pipefail

MARKER_FILE="${WX_MARKER_FILE:-/tmp/wx_ws_marker}"
LABEL="${1:-标记 $(date '+%H:%M:%S')}"

printf '%s' "$LABEL" > "$MARKER_FILE"
echo "[mark] 已写入标记: $LABEL (文件: $MARKER_FILE)"
