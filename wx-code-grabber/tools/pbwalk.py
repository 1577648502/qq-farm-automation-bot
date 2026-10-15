#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
裸 protobuf 遍历工具（逆向抓包用）

为什么需要它：项目自带的 ws-capture-decode.js 对"字段未在 proto 里声明"的大 body
只打 hex，看不清结构；这个工具不依赖任何 .proto，按 wire type 走一遍就能看层级。

用法：
  # 1) 打印某帧的字段树（按 key 过滤）
  python3 pbwalk.py captures/xxx.jsonl --key ActivityService.List --depth 6

  # 2) 只抽可读字符串（含内嵌 JSON，活动规则文案常放在这里）
  python3 pbwalk.py captures/xxx.jsonl --key ActivityService.List --strings

  # 3) 扫描全文件：所有活动的 group/uid/名称/时间（活动盘点）
  python3 pbwalk.py captures/xxx.jsonl --activities

  # 4) 指定字段号取一段原始 hex/字节
  python3 pbwalk.py captures/xxx.jsonl --key ActivityService.List --field 115 --hex
"""
import argparse
import json
import io
import re
import sys


# ---------- 裸 protobuf ----------
def read_varint(b, i):
    r = 0
    s = 0
    while i < len(b):
        c = b[i]
        i += 1
        r += (c & 0x7F) * (2 ** s)
        s += 7
        if not (c & 0x80):
            break
    return r, i


def parse(b):
    """→ [{'f':字段号,'w':wire,'v':varint值 或 'raw':bytes}]"""
    out = []
    i = 0
    n = len(b)
    while i < n:
        try:
            tag, i = read_varint(b, i)
        except Exception:
            break
        f, w = tag >> 3, tag & 7
        if f == 0:
            break
        if w == 0:
            v, i = read_varint(b, i)
            out.append({'f': f, 'w': 0, 'v': v})
        elif w == 2:
            ln, i = read_varint(b, i)
            out.append({'f': f, 'w': 2, 'raw': b[i:i + ln]})
            i += ln
        elif w == 5:
            out.append({'f': f, 'w': 5, 'raw': b[i:i + 4]})
            i += 4
        elif w == 1:
            out.append({'f': f, 'w': 1, 'raw': b[i:i + 8]})
            i += 8
        else:
            break
    return out


def first(fields, no, wire=None):
    for x in fields:
        if x['f'] == no and (wire is None or x['w'] == wire):
            return x
    return None


def num(fields, no):
    x = first(fields, no, 0)
    return x['v'] if x else None


def blob(fields, no):
    x = first(fields, no, 2)
    return x['raw'] if x else None


def as_str(b):
    try:
        return b.decode('utf8')
    except Exception:
        return ''


def is_text(b):
    t = as_str(b)
    if len(t) < 1:
        return False
    return all(c.isprintable() or ord(c) > 127 for c in t)


def walk_strings(b, out, depth=0, max_depth=10):
    """递归抽可读字符串（内嵌 JSON 也会作为整串抽出来）"""
    if depth > max_depth:
        return
    for x in parse(bytes(b)):
        if x['w'] != 2:
            continue
        raw = bytes(x['raw'])
        if is_text(raw):
            out.append(raw.decode('utf8'))
        else:
            walk_strings(raw, out, depth + 1, max_depth)


# ---------- 抓包文件 ----------
def load_frames(path):
    rows = []
    with io.open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                j = json.loads(line)
            except Exception:
                continue
            if not j.get('ev') and j.get('hex') and j.get('dir') == 'S->C':
                rows.append(j)
    return rows


def envelope_body(hexstr):
    env = parse(bytes.fromhex(hexstr))
    b = blob(env, 2)
    return b if b is not None else b''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--key', default='', help='按 service.Method 关键字过滤')
    ap.add_argument('--depth', type=int, default=4)
    ap.add_argument('--strings', action='store_true', help='只抽可读字符串')
    ap.add_argument('--activites', action='store_true', dest='activities', help='活动盘点')
    ap.add_argument('--activities', action='store_true', help='活动盘点')
    ap.add_argument('--field', type=int, default=0, help='只看某个字段')
    ap.add_argument('--hex', action='store_true', help='输出原始 hex')
    ap.add_argument('--limit', type=int, default=5, help='最多处理几帧(默认5)')
    args = ap.parse_args()

    frames = load_frames(args.file)
    if args.key:
        frames = [f for f in frames if args.key in str(f.get('key', ''))]
    if not frames:
        print('没有匹配的帧')
        return
    print(f'匹配 {len(frames)} 帧')

    for fr in frames[:args.limit]:
        body = envelope_body(fr['hex'])
        print(f"\n===== [{fr.get('idx')}] {fr.get('key')} ({len(body)}B) =====")
        if args.strings:
            out = []
            walk_strings(body, out)
            seen = set()
            for t in out:
                if len(t) < 2 or t in seen:
                    continue
                seen.add(t)
                print('  ' + t.replace('\n', ' ')[:400])
            continue
        if args.field:
            node = blob(body, args.field)
            if node is None:
                print(f'  #{args.field} 不存在')
            elif args.hex:
                print(f'  #{args.field} hex = {bytes(node).hex()}')
            else:
                sub = parse(bytes(node))
                print(f'  #{args.field} ({len(node)}B): ' +
                      str([(x['f'], x['w'], x['v'] if x['w'] == 0 else len(x['raw'])) for x in sub]))
            continue
        show_tree(body, 0, args.depth)


def show_tree(b, depth, max_depth, label='body'):
    pad = '  ' * depth
    for x in parse(bytes(b)):
        if x['w'] == 0:
            print(f'{pad}#{x["f"]} = {x["v"]}')
        else:
            raw = bytes(x['raw'])
            if is_text(raw) and len(raw) < 200:
                print(f'{pad}#{x["f"]} = {raw.decode("utf8")!r}')
            elif depth + 1 <= max_depth:
                print(f'{pad}#{x["f"]} ({len(raw)}B):')
                show_tree(raw, depth + 1, max_depth)
            else:
                print(f'{pad}#{x["f"]} ({len(raw)}B)')


if __name__ == '__main__':
    main()
