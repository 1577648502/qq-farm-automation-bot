# -*- coding: utf-8 -*-
"""
mitmproxy addon: 抓取微信经典农场 WebSocket 握手 URL 里的 code, 并可定时强制重连。

匹配 host 含 nqf.qq.com 的请求 (含 wss 握手), 提取 ?code=..., 去重后:
  - 写入 /tmp/wx_mitm_code.log
  - 若设置了环境变量 WX_SERVER_URL, 则 POST {code, host, source, ts} 过去

自动刷新原理:
  新 code 只在小程序发起新 WS 握手时才产生。小程序连上后保持同一条长连接不再握手。
  本 addon 记录农场 WS 建立时间, 每隔 WX_REFRESH_SEC 秒 (默认 300) 把该连接 kill 掉,
  小程序检测到断线会自动重连, 重连时 wx.login 生成新 code -> 被捕获。无需手动重开农场。

环境变量:
  WX_REFRESH_SEC  强制重连周期秒数, 默认 300 (0 = 关闭定时重连)
  WX_BLOCK        是否拦截握手使 code 不被消费, 默认 0 (关)。注意: 开启后小程序无法
                  建立长连接, 定时重连机制失效, 二者互斥。
  WX_SERVER_URL   非空则把每个新 code POST 过去
  WX_CAPTURE_WS   开启 WS 帧抓取 (逆向新接口/新活动用), 默认 0
  WX_WS_CAPTURE_LOG  WS 帧抓包输出文件, 默认 /tmp/wx_ws_capture.jsonl
  WX_MARKER_FILE  时间线标记文件, 默认 /tmp/wx_ws_marker; mark.sh 写入 label,
                  本 addon 轮询到后写一条 {"ev":"mark"} 进抓包文件
  WX_CODE_LOG     捕获的 code 落盘路径, 默认 /tmp/wx_mitm_code.log
  WX_EVENTS_LOG   事件日志路径, 默认 /tmp/wx_mitm_events.log
                  (grab-now.sh 会把这两个指到会话目录, 实现多会话日志隔离)

抓包文件里除 hex 帧外, 还会写入事件行 (无 hex 字段, 用 "ev" 字段标识):
  session_start / ws_open / ws_close / mark
解码端 ws-capture-decode.js 会把它们还原成时间线, 便于定位操作边界。

启动:
  mitmdump -s mitm_addon.py --listen-port 38127
"""
import os
import re
import json
import time
import asyncio
import threading
import base64
import urllib.request
import urllib.error
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

from mitmproxy import ctx, http

# 日志路径可用环境变量覆盖 (grab-now.sh 按会话隔离, 避免多会话日志混在一起)
CODE_LOG = os.environ.get('WX_CODE_LOG', '/tmp/wx_mitm_code.log')
EVENTS_LOG = os.environ.get('WX_EVENTS_LOG', '/tmp/wx_mitm_events.log')
# WS 帧抓包输出 (原始 hex, 由 Node 侧 scripts/ws-capture-decode.js 解密+解析)
WS_CAPTURE_LOG = os.environ.get('WX_WS_CAPTURE_LOG', '/tmp/wx_ws_capture.jsonl')
# HTTP/HTTPS 全量抓包输出。微信宿主/游戏圈页面的领取请求通常不经过农场 WS，
# 排查这类功能时需要开启 WX_CAPTURE_HTTP_ALL=1。
HTTP_CAPTURE_LOG = os.environ.get('WX_HTTP_CAPTURE_LOG', '/tmp/wx_http_capture.jsonl')
# 标记文件: mark.sh 往里写 label, 本 addon 轮询到后写一条 {"ev":"mark"} 进抓包时间线
MARKER_FILE = os.environ.get('WX_MARKER_FILE', '/tmp/wx_ws_marker')
CODE_RE = re.compile(r'[?&]code=([^&\s"\'#]+)')
HTTP_BODY_LIMIT = max(1024, int(os.environ.get('WX_HTTP_BODY_LIMIT', str(2 * 1024 * 1024)) or 0))
SENSITIVE_KEY_RE = re.compile(
    r'(^|[-_.])(code|token|ticket|session|secret|password|passwd|pwd|'
    r'authorization|cookie|access_token|refresh_token|auth_code)($|[-_.])',
    re.I,
)
REDACTED = '<redacted>'


def _pb_fields(buf):
    """极简 protobuf wire 解析 (无依赖): 返回 [(field_no, wire, value)]。
    wire 0 -> varint(int), wire 2 -> bytes; 其余跳过。解析失败就地截断。"""
    out = []
    i, n = 0, len(buf)
    try:
        while i < n:
            tag = 0
            shift = 0
            while True:
                b = buf[i]
                i += 1
                tag |= (b & 0x7F) << shift
                shift += 7
                if not (b & 0x80):
                    break
                if shift > 63:
                    raise ValueError('tag too long')
            field_no = tag >> 3
            wire = tag & 7
            if wire == 0:
                v = 0
                shift = 0
                while True:
                    b = buf[i]
                    i += 1
                    v |= (b & 0x7F) << shift
                    shift += 7
                    if not (b & 0x80):
                        break
                    if shift > 63:
                        raise ValueError('varint too long')
                out.append((field_no, 0, v))
            elif wire == 2:
                ln = 0
                shift = 0
                while True:
                    b = buf[i]
                    i += 1
                    ln |= (b & 0x7F) << shift
                    shift += 7
                    if not (b & 0x80):
                        break
                    if shift > 63:
                        raise ValueError('len too long')
                out.append((field_no, 2, bytes(buf[i:i + ln])))
                i += ln
            elif wire == 1:
                out.append((field_no, 1, bytes(buf[i:i + 8])))
                i += 8
            elif wire == 5:
                out.append((field_no, 5, bytes(buf[i:i + 4])))
                i += 4
            else:
                raise ValueError('bad wire %d' % wire)
    except Exception:  # noqa: BLE001
        pass
    return out


def extract_frame_key(content):
    """从 GateMessage 帧提取接口 key。meta 不加密, 通用 wire 解析即可, 不需要游戏 proto。
    请求/响应 -> 'service.method'; Notify -> 'notify:事件类型'。失败返回 None。
    帧结构: Message{ meta=1(Meta), body=2 }  Meta{ service_name=1, method_name=2, message_type=3 }
            Notify body 是 EventMessage{ message_type=1(string), body=2 }"""
    try:
        buf = bytes(content)
        top = {}
        for f, w, v in _pb_fields(buf):
            if w == 2 and f not in top:
                top[f] = v
        meta = top.get(1)
        if not meta:
            return None
        svc = ''
        method = ''
        mtype = 0
        for f, w, v in _pb_fields(meta):
            if f == 1 and w == 2:
                svc = v.decode('utf-8', 'replace')
            elif f == 2 and w == 2:
                method = v.decode('utf-8', 'replace')
            elif f == 3 and w == 0:
                mtype = v
        if mtype == 3:
            body = top.get(2)
            if body:
                for f, w, v in _pb_fields(body):
                    if f == 1 and w == 2:
                        return 'notify:' + v.decode('utf-8', 'replace')
            return 'notify:(未知)'
        if svc and method:
            return svc + '.' + method
        return None
    except Exception:  # noqa: BLE001
        return None


def _env_bool(name, default):
    v = os.environ.get(name)
    if v is None or v == '':
        return default
    return v.strip().lower() not in ('0', 'false', 'no', 'off')


def _is_sensitive_key(key):
    return bool(key and SENSITIVE_KEY_RE.search(str(key)))


def _sanitize_json(value):
    if isinstance(value, dict):
        return {
            k: (REDACTED if _is_sensitive_key(k) else _sanitize_json(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_json(v) for v in value]
    return value


def _sanitize_text(text):
    """兜底脱敏非 JSON/表单 body 中的常见凭据键值。"""
    if not text:
        return text
    pattern = re.compile(
        r'(?i)(\b(?:code|token|ticket|session|secret|password|passwd|pwd|'
        r'authorization|cookie|access_token|refresh_token|auth_code)=)[^&\s,;"\']+'
    )
    return pattern.sub(lambda m: m.group(1) + REDACTED, text)


def _sanitize_url(url):
    try:
        parts = urlsplit(url or '')
        query = []
        for key, value in parse_qsl(parts.query, keep_blank_values=True):
            query.append((key, REDACTED if _is_sensitive_key(key) else value))
        safe_query = urlencode(query, doseq=True)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, safe_query, parts.fragment))
    except Exception:  # noqa: BLE001
        return _sanitize_text(url or '')


def _sanitize_headers(headers):
    out = []
    for key, value in headers.items(multi=True):
        out.append({
            'name': key,
            'value': REDACTED if _is_sensitive_key(key) else _sanitize_text(str(value)),
        })
    return out


def _looks_textual(content, content_type):
    ctype = (content_type or '').lower()
    if any(token in ctype for token in (
        'json', 'text/', 'javascript', 'xml', 'x-www-form-urlencoded',
        'graphql', 'protobuf', 'octet-stream',
    )):
        return True
    if not content:
        return True
    sample = content[:2048]
    printable = sum(
        b in (9, 10, 13) or 32 <= b <= 126 or b >= 128
        for b in sample
    )
    return printable / max(1, len(sample)) >= 0.92


def _body_for_log(content, content_type):
    raw = bytes(content or b'')
    truncated = len(raw) > HTTP_BODY_LIMIT
    selected = raw[:HTTP_BODY_LIMIT]
    result = {
        'body_bytes': len(raw),
        'body_truncated': truncated,
    }
    if not raw:
        return result
    if _looks_textual(selected, content_type):
        text = selected.decode('utf-8', 'replace')
        try:
            parsed = json.loads(text)
        except Exception:  # noqa: BLE001
            if 'x-www-form-urlencoded' in (content_type or '').lower():
                pairs = parse_qsl(text, keep_blank_values=True)
                text = urlencode([
                    (k, REDACTED if _is_sensitive_key(k) else v)
                    for k, v in pairs
                ], doseq=True)
            else:
                text = _sanitize_text(text)
        else:
            text = json.dumps(_sanitize_json(parsed), ensure_ascii=False)
        result['body_text'] = text
    else:
        result['body_base64'] = base64.b64encode(selected).decode('ascii')
    return result


class WxCodeGrabber:
    def __init__(self):
        self.server_url = os.environ.get('WX_SERVER_URL', '').strip()
        # 上报到机器人 /api/qr/check 所需的头
        self.admin_token = os.environ.get('WX_ADMIN_TOKEN', '').strip()
        self.account_id = os.environ.get('WX_ACCOUNT_ID', '').strip()
        # 只上报未消费(被拦截)的 code, 默认开; 置 0 则所有捕获都上报
        self.post_unused_only = _env_bool('WX_POST_UNUSED_ONLY', True)
        # 上报成功后是否额外 POST /api/accounts/<id>/start, 默认开
        self.start_after_post = _env_bool('WX_START_AFTER_POST', True)
        # 上报节流: 拦截后小程序会疯狂重连吐一堆新 code, 冷却窗口内只提交 1 个, 防止刷爆机器人
        try:
            self.post_cooldown = int(os.environ.get('WX_POST_COOLDOWN_SEC', '30') or '30')
        except ValueError:
            self.post_cooldown = 30
        self.last_post_ts = 0.0
        # 拦截: 拦下农场 WS 握手, 使 code 不被消费。默认关 (与定时重连互斥)。
        self.block = _env_bool('WX_BLOCK', False)
        # 定时强制重连周期 (秒), 0 = 关闭
        try:
            self.refresh_sec = int(os.environ.get('WX_REFRESH_SEC', '300') or '300')
        except ValueError:
            self.refresh_sec = 300
        self.last_code = None
        self.last_ts = 0.0
        # 活动的农场 WS 连接: flow.id -> {'flow': flow, 'ts': 建立时间}
        self.active = {}
        self._task = None
        # 武装标志: 掐断后置 True, 下一次农场握手将被拦截(捕获未消费 code)后自动解除
        self.armed = False
        # 是否抓 WS 游戏帧到 WS_CAPTURE_LOG (默认关, 不影响抓 code 主流程)
        self.capture_ws = _env_bool('WX_CAPTURE_WS', False)
        # 是否记录所有 HTTP/HTTPS 请求 (含微信宿主、游戏圈、静态资源 API)
        self.capture_http_all = _env_bool('WX_CAPTURE_HTTP_ALL', False)
        self.http_started = {}
        self.last_marker = ''
        self.last_marker_ts = 0.0
        # 自动标记: 命中这些子串的 C->S 请求每次都打 auto_mark (逗号分隔, 空=关)
        self.automark_keys = [p.strip() for p in os.environ.get(
            'WX_AUTOMARK_KEYS', 'Operate,GetGroup,Share,Claim,Buy,Report,Use').split(',') if p.strip()]
        self.seen_keys = set()      # 本会话已出现过的接口 key (首次出现自动标记)
        self.last_automark = {}     # key -> ts, 同 key 1s 内去重
        # 帧计数 (用于周期性提示, 确认正在抓)
        self.frame_count = {'C->S': 0, 'S->C': 0}
        self.last_report_ts = 0.0

    def load(self, loader):
        ctx.log.info(
            '[wxcode] addon loaded. server_url=' + (self.server_url or '(none)')
            + ' account_id=' + (self.account_id or '(none)')
            + ' block=' + ('on' if self.block else 'off')
            + ' refresh_sec=' + str(self.refresh_sec)
            + ' capture_ws=' + ('on -> ' + WS_CAPTURE_LOG if self.capture_ws else 'off')
            + ' capture_http_all=' + ('on -> ' + HTTP_CAPTURE_LOG if self.capture_http_all else 'off')
        )
        if self.capture_ws:
            self._capture_event('session_start',
                                label=os.environ.get('WX_SESSION', ''),
                                capture_log=WS_CAPTURE_LOG)
            self._event('WS 帧抓取已开启 -> ' + WS_CAPTURE_LOG
                        + ' (标记文件: ' + MARKER_FILE + ')')
        if self.capture_http_all:
            self._event('HTTP/HTTPS 全量抓取已开启 -> ' + HTTP_CAPTURE_LOG)

    def running(self):
        # 在 mitmproxy 的事件循环上启动周期巡检任务
        if self._task is None:
            try:
                loop = asyncio.get_running_loop()
                self._task = loop.create_task(self._ticker())
                ctx.log.info('[wxcode] 巡检任务已启动 (1s 周期: 定时重连 + 标记轮询)')
            except RuntimeError as e:
                ctx.log.warn('[wxcode] 无法启动定时任务: ' + str(e))

    async def _ticker(self):
        while True:
            await asyncio.sleep(1)
            try:
                self._check_marker()
                self._kill_expired()
            except Exception as e:  # noqa: BLE001
                ctx.log.warn('[wxcode] ticker err: ' + str(e))

    def _check_marker(self):
        # mark.sh 写入标记文件 -> 立刻转成抓包时间线里的一条 {"ev":"mark"} 记录
        label = ''
        try:
            with open(MARKER_FILE, 'r', encoding='utf-8') as f:
                label = f.read().strip()
        except FileNotFoundError:
            return
        except Exception:  # noqa: BLE001
            return
        try:
            os.remove(MARKER_FILE)
        except Exception:  # noqa: BLE001
            pass
        if not label:
            label = '(未命名标记)'
        self.last_marker = label
        self.last_marker_ts = time.time()
        if self.capture_ws:
            self._capture_event('mark', label=label)
            ctx.log.alert('[wxcode] 时间线标记: ' + label)

    def _capture_event(self, ev, **kw):
        # 把连接/标记等事件写进抓包文件, 供解码端还原时间线。capture 未开启时丢弃。
        if not self.capture_ws:
            return
        record = {'ts': time.time(), 'ev': ev}
        record.update(kw)
        try:
            with open(WS_CAPTURE_LOG, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        except Exception:  # noqa: BLE001
            pass

    def _kill_expired(self):
        if self.refresh_sec <= 0 or not self.active:
            return
        now = time.time()
        for fid, item in list(self.active.items()):
            age = now - item['ts']
            if age < self.refresh_sec:
                continue
            self._event('农场 WS 存活 %ds 到期, 掐断以触发重连 (flow=%s)' % (int(age), fid))
            try:
                item['flow'].kill()
            except Exception as e:  # noqa: BLE001
                self._event('kill 失败: ' + str(e))
            self.active.pop(fid, None)
            # 武装: 下一次重连握手将被拦截, 使该 code 不被客户端消费, 留给机器人
            self.armed = True
            self._event('已武装 armed=True, 将拦截下一次重连握手')

    def _event(self, msg):
        ctx.log.alert('[wxcode] ' + msg)
        try:
            with open(EVENTS_LOG, 'a', encoding='utf-8') as f:
                f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + msg + '\n')
        except Exception:  # noqa: BLE001
            pass

    def _extract(self, url):
        m = CODE_RE.search(url or '')
        if not m:
            return None
        return unquote(m.group(1))

    def _sanitize(self, url):
        """把 code 值替换成 <code> 后返回, 用于记日志(不泄露 code, 又能看清是哪个客户端/参数)"""
        return CODE_RE.sub(lambda m: m.group(0)[:len(m.group(0)) - len(m.group(1))] + '<code>', url or '')

    def request(self, flow):
        try:
            host = flow.request.pretty_host or ''
            if self.capture_http_all:
                self.http_started[flow.id] = time.time()
            if 'nqf.qq.com' not in host:
                return
            code = self._extract(flow.request.pretty_url)
            if not code:
                return
            # 需要拦截的两种情形: 常开拦截(WX_BLOCK) 或 刚掐断后武装的这一次
            should_block = self.block or self.armed
            self._event('nqf 握手请求 armed=%s block=%s -> %s' % (
                self.armed, self.block, '拦截' if should_block else '放行'))
            self._event('握手 URL: ' + self._sanitize(flow.request.pretty_url)[:400])
            self._handle(code, host, 'request', unused=should_block)
            if should_block:
                # 在转发到真实服务器之前短路本次请求, 握手到不了服务端, code 不被消费
                flow.response = http.Response.make(
                    403,
                    b'blocked by wxcode grabber',
                    {'Content-Type': 'text/plain', 'Connection': 'close'},
                )
                if self.armed:
                    self.armed = False
                    self._event('已拦截重连握手, 捕获未消费 code (可交给机器人)')
                else:
                    self._event('已拦截客户端握手 (WX_BLOCK), code 未被消费')
        except Exception as e:  # noqa: BLE001
            ctx.log.warn('[wxcode] request err: ' + str(e))

    def response(self, flow):
        if self.capture_http_all:
            self._capture_http(flow, phase='response')

    def error(self, flow):
        if self.capture_http_all:
            self._capture_http(flow, phase='error')

    def _capture_http(self, flow, phase):
        try:
            req = flow.request
            resp = getattr(flow, 'response', None)
            started = self.http_started.pop(flow.id, None)
            req_type = req.headers.get('content-type', '')
            resp_type = resp.headers.get('content-type', '') if resp else ''
            now = time.time()
            record = {
                'ts': now,
                'ev': 'http',
                'phase': phase,
                'flow': flow.id,
                'host': req.pretty_host or '',
                'method': req.method,
                'url': _sanitize_url(req.pretty_url),
                'request': {
                    'http_version': req.http_version,
                    'headers': _sanitize_headers(req.headers),
                    **_body_for_log(req.content, req_type),
                },
            }
            if started is not None:
                record['elapsed_ms'] = round((now - started) * 1000, 1)
            if self.last_marker:
                record['marker'] = self.last_marker
                record['marker_age_sec'] = round(now - self.last_marker_ts, 3)
            if resp is not None:
                record['response'] = {
                    'status_code': resp.status_code,
                    'reason': resp.reason,
                    'http_version': resp.http_version,
                    'headers': _sanitize_headers(resp.headers),
                    **_body_for_log(resp.content, resp_type),
                }
            err = getattr(flow, 'error', None)
            if err:
                record['error'] = str(err)
            with open(HTTP_CAPTURE_LOG, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        except Exception as e:  # noqa: BLE001
            ctx.log.warn('[wxcode] http capture err: ' + str(e))

    def websocket_start(self, flow):
        try:
            host = flow.request.pretty_host or ''
            if 'nqf.qq.com' not in host:
                return
            code = self._extract(flow.request.pretty_url)
            if code:
                self._handle(code, host, 'websocket')
            # 记录这条农场长连接, 供定时重连使用
            if not self.block:
                self.active[flow.id] = {'flow': flow, 'ts': time.time()}
                self._event('农场 WS 已建立 (flow=%s), 计时 %ss 后重连' % (flow.id, self.refresh_sec))
            if self.capture_ws:
                self._capture_event('ws_open', flow=flow.id, host=host,
                                    url=flow.request.pretty_url[:300])
                ctx.log.alert('[wxcode] 连接已建立, 开始记录游戏帧 (flow=%s)' % flow.id)
        except Exception as e:  # noqa: BLE001
            ctx.log.warn('[wxcode] ws err: ' + str(e))

    def websocket_end(self, flow):
        try:
            host = flow.request.pretty_host or ''
            if 'nqf.qq.com' in host and self.capture_ws:
                self._capture_event('ws_close', flow=flow.id,
                                    frames=dict(self.frame_count))
            self.active.pop(flow.id, None)
        except Exception:  # noqa: BLE001
            pass

    def _maybe_automark(self, key, direction, now):
        """自动打标记: 每个接口首次出现必标; 命中 WX_AUTOMARK_KEYS 的请求每次都标(1s 去重)"""
        if not key:
            return
        is_new = key not in self.seen_keys
        self.seen_keys.add(key)
        hit = any(p in key for p in self.automark_keys)
        if not is_new and not (hit and direction == 'C->S'):
            return
        if now - self.last_automark.get(key, 0.0) < 1.0:
            return
        self.last_automark[key] = now
        label = ('首次 ' if is_new else '') + key
        self._capture_event('auto_mark', label=label, key=key)
        ctx.log.alert('[wxcode] 自动标记: ' + label)

    def websocket_message(self, flow):
        # 抓每一帧 WS 游戏消息 (mitmproxy 已解密 TLS)。只落原始 hex, 解密/解析交给 Node 侧。
        if not self.capture_ws:
            return
        try:
            host = flow.request.pretty_host or ''
            if 'nqf.qq.com' not in host:
                return
            msg = flow.websocket.messages[-1]
            content = msg.content
            if not isinstance(content, (bytes, bytearray)):
                return
            direction = 'C->S' if msg.from_client else 'S->C'
            now = time.time()
            # meta 不加密, 直接提取接口 key (写进记录 + 自动标记)
            key = extract_frame_key(content)
            record = {
                'ts': now,
                'flow': flow.id,
                'host': host,
                'dir': direction,
                'idx': len(flow.websocket.messages) - 1,
                'opcode': getattr(msg, 'opcode', None),
                'len': len(content),
                'hex': bytes(content).hex(),
            }
            if key:
                record['key'] = key
            with open(WS_CAPTURE_LOG, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
            self._maybe_automark(key, direction, now)
            # 帧计数 + 每 5s 打一条提示, 抓活动时确认"正在抓"
            self.frame_count[direction] = self.frame_count.get(direction, 0) + 1
            if now - self.last_report_ts >= 5:
                self.last_report_ts = now
                total = self.frame_count['C->S'] + self.frame_count['S->C']
                ctx.log.alert('[wxcode] 已抓 %d 帧 (上行 %d / 下行 %d) -> %s'
                              % (total, self.frame_count['C->S'], self.frame_count['S->C'],
                                 WS_CAPTURE_LOG))
        except Exception as e:  # noqa: BLE001
            ctx.log.warn('[wxcode] ws_msg err: ' + str(e))

    def _handle(self, code, host, source, unused=False):
        now = time.time()
        if code == self.last_code and (now - self.last_ts) < 3:
            return
        self.last_code = code
        self.last_ts = now
        tag = '未消费' if unused else '已消费'
        ctx.log.alert('[wxcode] 捕获 code=' + code[:20] + '... host=' + host + ' src=' + source + ' (' + tag + ')')
        payload = {'code': code, 'host': host, 'source': source, 'unused': bool(unused), 'ts': int(now)}
        self._write_log(payload)
        if self.server_url and (unused or not self.post_unused_only):
            if (now - self.last_post_ts) < self.post_cooldown:
                ctx.log.info('[wxcode] 冷却中(%ss), 跳过本次上报' % self.post_cooldown)
            else:
                self.last_post_ts = now
                threading.Thread(target=self._post, args=(code,), daemon=True).start()

    def _write_log(self, payload):
        try:
            with open(CODE_LOG, 'a', encoding='utf-8') as f:
                f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + json.dumps(payload, ensure_ascii=False) + '\n')
        except Exception:  # noqa: BLE001
            pass

    def _log_thread(self, msg):
        # 子线程内 ctx.log 不可靠, 用 print + 写文件保证可见
        try:
            print('[wxcode] ' + msg, flush=True)
        except Exception:  # noqa: BLE001
            pass
        try:
            with open(EVENTS_LOG, 'a', encoding='utf-8') as f:
                f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + msg + '\n')
        except Exception:  # noqa: BLE001
            pass

    def _post(self, code):
        # 默认按 /api/accounts 端点提交: {id, code}; 也兼容 /api/qr/check 场景(只需要 code)
        body = {'code': code}
        if self.account_id:
            body['id'] = self.account_id
        data = json.dumps(body).encode('utf-8')
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            # Cloudflare 会拦 python-urllib 默认 UA (error 1010), 用普通浏览器 UA
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        }
        if self.admin_token:
            headers['x-admin-token'] = self.admin_token
        if self.account_id:
            headers['x-account-id'] = self.account_id
        self._log_thread('上报 POST ' + self.server_url + ' body=' + json.dumps(body)[:200])
        # 系统代理已被 run.sh 指到本机 mitmproxy, 若走代理会被 mitmproxy 重签
        # 导致证书校验失败, 因此强制绕过代理直连.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        ok = False
        try:
            req = urllib.request.Request(self.server_url, data=data, headers=headers)
            with opener.open(req, timeout=15) as resp:
                resp_body = resp.read().decode('utf-8', 'replace')[:400]
                self._log_thread('上报 status=' + str(resp.status) + ' resp=' + resp_body)
                ok = 200 <= resp.status < 300
        except urllib.error.HTTPError as e:  # noqa: BLE001
            resp_body = ''
            try:
                resp_body = e.read().decode('utf-8', 'replace')[:400]
            except Exception:  # noqa: BLE001
                pass
            self._log_thread('上报 HTTP ' + str(e.code) + ' resp=' + resp_body)
        except Exception as e:  # noqa: BLE001
            self._log_thread('上报失败: ' + repr(e))

        if ok and self.start_after_post and self.account_id:
            self._post_start(opener, headers)

    def _post_start(self, opener, headers):
        # 触发 /api/accounts/<id>/start, 让机器人用新 code 启动实例
        try:
            parts = urlsplit(self.server_url)
            start_url = urlunsplit((parts.scheme, parts.netloc,
                                    '/api/accounts/' + self.account_id + '/start',
                                    '', ''))
        except Exception as e:  # noqa: BLE001
            self._log_thread('start URL 构造失败: ' + repr(e))
            return
        start_headers = dict(headers)
        # start 端点无 body, 明确 content-length: 0
        start_headers['Content-Length'] = '0'
        self._log_thread('触发 START ' + start_url)
        try:
            req = urllib.request.Request(start_url, data=b'', headers=start_headers, method='POST')
            with opener.open(req, timeout=15) as resp:
                resp_body = resp.read().decode('utf-8', 'replace')[:400]
                self._log_thread('START status=' + str(resp.status) + ' resp=' + resp_body)
        except urllib.error.HTTPError as e:  # noqa: BLE001
            resp_body = ''
            try:
                resp_body = e.read().decode('utf-8', 'replace')[:400]
            except Exception:  # noqa: BLE001
                pass
            self._log_thread('START HTTP ' + str(e.code) + ' resp=' + resp_body)
        except Exception as e:  # noqa: BLE001
            self._log_thread('START 失败: ' + repr(e))


addons = [WxCodeGrabber()]
