#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信桌面农场 Code 抓取器 (macOS, 独立工具)

原理: 用 frida attach 到微信小程序引擎 (WeChatAppEx) 的各进程, 注入 JS agent:
  1) hook BoringSSL SSL_write, 截获农场 WebSocket 握手请求里的 ?code=...
  2) 内存扫描 (Latin1 逐字节, 兼容 ASCII / UTF-16) 查找 gate-obt.nqf.qq.com 附近的 code

用法:
  python3 grab.py once            # 抓一次, 打印 code 后退出
  python3 grab.py loop            # 每 5 分钟抓一次并 POST 到服务器 (见下方 SERVER_URL)
  python3 grab.py once --timeout 40

前提: 已 pip3 install frida-tools; 微信里已打开「经典农场」小程序。
"""
import sys
import re
import json
import time
import argparse
import subprocess

try:
    import frida
except Exception as e:  # noqa: BLE001
    print('[grab] 需要 frida: pip3 install frida-tools  (' + str(e) + ')', flush=True)
    sys.exit(3)

# ============ 可配置 ============
SERVER_URL = ''          # 例: http://127.0.0.1:3000/api/wx-code   (loop 模式 POST 目标)
LOOP_INTERVAL_SEC = 300  # 5 分钟
DEFAULT_TIMEOUT = 35
LOG_FILE = '/tmp/wx_code_grabber.log'
# ================================

AGENT_JS = r"""
'use strict';
(function () {
  var TARGET = 'gate-obt.nqf.qq.com';

  function readLatin1(ptr, len) {
    try {
      var n = len | 0;
      if (n <= 0) return '';
      if (n > 2 * 1024 * 1024) n = 2 * 1024 * 1024;
      var b = new Uint8Array(ptr.readByteArray(n));
      var s = '';
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return s;
    } catch (e) { return ''; }
  }

  function reportFromText(text, source) {
    if (!text) return false;
    var m = text.match(/[?&]code=([A-Za-z0-9_%\-]{6,})/);
    if (m) { try { send({ code: decodeURIComponent(m[1]), source: source, pid: Process.id }); } catch (e) { send({ code: m[1], source: source, pid: Process.id }); } return true; }
    return false;
  }

  function findExport(name) {
    try { if (Module.findGlobalExportByName) { var p = Module.findGlobalExportByName(name); if (p) return p; } } catch (e) {}
    try { var q = Module.findExportByName(null, name); if (q) return q; } catch (e) {}
    var ms = Process.enumerateModules();
    for (var i = 0; i < ms.length; i++) {
      try { var m = ms[i]; if (m.findExportByName) { var r = m.findExportByName(name); if (r) return r; } } catch (e) {}
    }
    return null;
  }

  // hook SSL_write(SSL*, const void* buf, int num): 客户端发出的 WS 握手带 ?code=
  function hookWrite() {
    var addr = findExport('SSL_write');
    if (!addr) { console.log('[grab] SSL_write 未找到'); return; }
    Interceptor.attach(addr, {
      onEnter: function (args) {
        try {
          var len = args[2].toInt32();
          var txt = readLatin1(args[1], len);
          if (txt.indexOf('code=') >= 0) reportFromText(txt, 'SSL_write');
        } catch (e) {}
      }
    });
    console.log('[grab] SSL_write hooked');
  }

  function hexAscii(s) { var h = []; for (var i = 0; i < s.length; i++) h.push(('0' + s.charCodeAt(i).toString(16)).slice(-2)); return h.join(' '); }
  function hexU16(s) { var h = []; for (var i = 0; i < s.length; i++) { h.push(('0' + s.charCodeAt(i).toString(16)).slice(-2)); h.push('00'); } return h.join(' '); }

  function memScan(tag) {
    var pats = [hexAscii(TARGET), hexU16(TARGET)];
    var ranges = Process.enumerateRanges('rw-');
    var found = 0;
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (r.size > 128 * 1024 * 1024) continue;
      for (var k = 0; k < pats.length; k++) {
        var matches;
        try { matches = Memory.scanSync(r.base, r.size, pats[k]); } catch (e) { continue; }
        for (var j = 0; j < matches.length; j++) {
          var raw = readLatin1(matches[j].address, 1500).replace(/\u0000/g, '');
          if (reportFromText(raw, 'memscan')) found++;
        }
      }
    }
    console.log('[grab] memscan(' + tag + ') found=' + found);
  }

  hookWrite();
  setTimeout(function () { memScan('init'); }, 500);
  setInterval(function () { memScan('poll'); }, 15000);
})();
"""


def log(msg):
    line = time.strftime('%H:%M:%S ') + msg
    print(line, flush=True)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:  # noqa: BLE001
        pass


def get_wechat_pids():
    try:
        out = subprocess.check_output(['ps', '-Ao', 'pid=,command=']).decode('utf-8', 'ignore')
    except Exception as e:  # noqa: BLE001
        log('ps 失败: ' + str(e))
        return []
    pids = []
    for line in out.splitlines():
        if 'WeChatAppEx' not in line:
            continue
        if 'Helper (GPU)' in line:  # GPU 进程无数据
            continue
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        try:
            pids.append(int(parts[0]))
        except ValueError:
            pass
    return pids


def grab_once(timeout=DEFAULT_TIMEOUT):
    pids = get_wechat_pids()
    if not pids:
        log('未发现 WeChatAppEx 进程, 请在微信中打开「经典农场」')
        return None
    log('发现进程 ' + str(len(pids)) + ' 个: ' + ' '.join(str(p) for p in pids))

    result = {'code': None}

    def on_message(message, data):  # noqa: ARG001
        try:
            if message.get('type') == 'send':
                p = message.get('payload') or {}
                if isinstance(p, dict) and p.get('code') and not result['code']:
                    result['code'] = p
                    log('捕获 code: ' + str(p.get('code'))[:16] + '... (来源 ' + str(p.get('source')) + ', pid ' + str(p.get('pid')) + ')')
            elif message.get('type') == 'error':
                log('script error: ' + str(message.get('description')))
        except Exception as e:  # noqa: BLE001
            log('on_message exc: ' + str(e))

    def on_log(level, text):  # noqa: ARG001
        if '[grab]' in str(text):
            log(str(text))

    sessions = []
    for pid in pids:
        try:
            s = frida.attach(pid)
            sc = s.create_script(AGENT_JS)
            sc.on('message', on_message)
            try:
                sc.set_log_handler(on_log)
            except Exception:  # noqa: BLE001
                pass
            sc.load()
            sessions.append((pid, s))
        except Exception as e:  # noqa: BLE001
            log('attach 失败 pid=' + str(pid) + ': ' + str(e))

    if not sessions:
        log('全部 attach 失败: 权限不足。请用 sudo 运行:')
        log('  sudo ' + sys.executable + ' ' + __file__ + ' once')
        return None
    log('已注入 ' + str(len(sessions)) + ' 个进程, 等待 code (最多 ' + str(timeout) + 's)...')

    t0 = time.time()
    while time.time() - t0 < timeout and not result['code']:
        time.sleep(0.3)

    for _pid, s in sessions:
        try:
            s.detach()
        except Exception:  # noqa: BLE001
            pass

    if not result['code']:
        log('超时未捕获 code (农场可能已连接且无新握手, 尝试在微信里重新进入一次农场)')
    return result['code']


def send_to_server(payload):
    if not SERVER_URL:
        log('未配置 SERVER_URL, 跳过上报 (payload=' + json.dumps(payload, ensure_ascii=False) + ')')
        return
    try:
        import urllib.request
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(SERVER_URL, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            log('上报成功 status=' + str(resp.status))
    except Exception as e:  # noqa: BLE001
        log('上报失败: ' + str(e))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', nargs='?', default='once', choices=['once', 'loop'])
    parser.add_argument('--timeout', type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument('--interval', type=int, default=LOOP_INTERVAL_SEC)
    args = parser.parse_args()

    if args.mode == 'once':
        code = grab_once(args.timeout)
        if code:
            print('RESULT:' + json.dumps(code, ensure_ascii=False), flush=True)
            sys.exit(0)
        else:
            sys.exit(1)
    else:
        log('循环模式启动, 每 ' + str(args.interval) + 's 抓一次')
        while True:
            code = grab_once(args.timeout)
            if code:
                send_to_server(code)
            time.sleep(args.interval)


if __name__ == '__main__':
    main()
