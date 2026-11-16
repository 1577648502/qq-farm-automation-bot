#!/usr/bin/env bash
# 每 N 秒把 WeChat 农场小程序进程 unhide → 触发 onShow (wx.login 出新 code) → 再 hide.
# 采用"进程级 hide/show" (Cmd+H 等价) 而非窗口最小化, 原因: macOS AX 从最小化窗口
# 里枚举不到, 一旦最小化就会"找不到窗口". hide 后进程仍在, 唤起可靠.
#
# 用法:
#   ./focus-refresh.sh                              # 每 300s 触发一次
#   WX_FOREGROUND_INTERVAL_SEC=180 ./focus-refresh.sh
#   WX_WINDOW_KEYWORD=农场 ./focus-refresh.sh       # 首次定位进程时的窗口标题关键字
#   WX_PROCESS_NAME='WeChatAppEx' ./focus-refresh.sh # 直接指定进程名, 跳过窗口扫描
#
# 前置:
#   系统设置 → 隐私与安全性 → 辅助功能, 允许运行此脚本的终端 (Terminal/iTerm).
#
# 注意:
#   Mac 待机(睡眠)时脚本会暂停, 唤醒后自动继续. 睡眠期间小程序也被系统挂起,
#   本来就不会产生新 code. 需要 7x24 保鲜可用 `caffeinate` 阻止睡眠.

set -uo pipefail

INTERVAL="${WX_FOREGROUND_INTERVAL_SEC:-10}"
KEYWORD="${WX_WINDOW_KEYWORD:-农场}"
CACHE="${WX_PROC_CACHE:-/tmp/wx_focus_proc.txt}"
PROC_NAME="${WX_PROCESS_NAME:-}"
# 最小化后停留时长(秒), 太短小程序还没走完 onHide 就被还原, onShow 也不会重新派发新 code.
MIN_HOLD="${WX_MIN_HOLD_SEC:-4}"

# 首次定位: 找一个包含关键字窗口的进程, 记住它的名字
find_proc_by_window() {
  osascript <<APPLESCRIPT 2>/dev/null
tell application "System Events"
  repeat with p in (every process)
    try
      if (count (windows of p whose name contains "${KEYWORD}")) > 0 then
        return name of p
      end if
    end try
  end repeat
end tell
return ""
APPLESCRIPT
}

# 复刻"手动最小化 → 从 Dock 还原"链路:
#   1) 找到农场窗口, AXMinimized=true → 收进 Dock (触发 onHide)
#   2) 停留 hold 秒 (太短小程序还没走完 onHide, 还原不会派发新 code)
#   3) AXMinimized=false + 激活进程 → 从 Dock 弹回 (触发 onShow, wx.login 出新 code)
#   4) 归还焦点给原前台 app
toggle_proc() {
  local pname="$1"
  local hold="$2"
  osascript <<APPLESCRIPT 2>/dev/null
tell application "System Events"
  try
    set prevApp to name of (first application process whose frontmost is true)

    tell process "${pname}"
      if visible is false then set visible to true
    end tell

    set targetWin to missing value
    set winNames to ""
    tell process "${pname}"
      repeat with w in windows
        try
          set wn to name of w
          set winNames to winNames & "[" & wn & "] "
          if wn contains "${KEYWORD}" then
            set targetWin to w
            exit repeat
          end if
        end try
      end repeat
    end tell
    if targetWin is missing value then return "err:no_window; seen=" & winNames

    -- 1) 最小化到 Dock
    tell process "${pname}"
      set value of attribute "AXMinimized" of targetWin to true
    end tell
    delay ${hold}

    -- 2) 还原并激活进程 (等价于点 Dock 里的图标)
    tell process "${pname}"
      set value of attribute "AXMinimized" of targetWin to false
      set frontmost to true
    end tell
    delay 0.6

    -- 3) 归还前台应用
    if prevApp is not "${pname}" and prevApp is not "" then
      try
        tell process prevApp to set frontmost to true
      end try
    end if
    return "ok"
  on error errMsg
    return "err:" & errMsg
  end try
end tell
APPLESCRIPT
}

# 判断进程是否还存在
proc_exists() {
  local pname="$1"
  local r
  r=$(osascript -e "tell application \"System Events\" to return (exists process \"${pname}\")" 2>/dev/null)
  [ "$r" = "true" ]
}

# 读取缓存的进程名
if [ -z "$PROC_NAME" ] && [ -f "$CACHE" ]; then
  PROC_NAME="$(cat "$CACHE" 2>/dev/null || true)"
fi

echo "[focus-refresh] 每 ${INTERVAL}s 触发一次, 窗口关键字='${KEYWORD}', 缓存=${CACHE}"
if [ -n "$PROC_NAME" ]; then
  echo "[focus-refresh] 使用缓存/指定进程: ${PROC_NAME}"
fi
echo "[focus-refresh] 按 Ctrl-C 退出"

while true; do
  TS="$(date '+%Y-%m-%d %H:%M:%S')"

  # 若无缓存进程名, 或缓存的进程已不存在, 重新按窗口关键字找
  if [ -z "$PROC_NAME" ] || ! proc_exists "$PROC_NAME"; then
    NEW="$(find_proc_by_window || true)"
    if [ -n "$NEW" ]; then
      PROC_NAME="$NEW"
      echo "$PROC_NAME" > "$CACHE"
      echo "[$TS] 定位到进程: $PROC_NAME (已缓存)"
    else
      echo "[$TS] 未找到含 '${KEYWORD}' 的窗口, 请先在微信里打开一次小程序"
      sleep "$INTERVAL"
      continue
    fi
  fi

  RESULT="$(toggle_proc "$PROC_NAME" "$MIN_HOLD" || true)"
  if [ "$RESULT" = "ok" ]; then
    echo "[$TS] 已触发 (proc=$PROC_NAME)"
  else
    echo "[$TS] 触发失败: ${RESULT:-unknown}; 下轮将重新定位进程"
    PROC_NAME=""   # 失效, 下轮重新扫描
    rm -f "$CACHE"
  fi

  sleep "$INTERVAL"
done
