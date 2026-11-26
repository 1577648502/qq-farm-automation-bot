/**
 * 以薯换福「分享暴击 每日自动一次」+「福气兑换按数量」回归测试
 *
 * 需求(2026-11-26 用户): 分享暴击每天自动跑一次(重启不重复发), 兑换要能一次兑多个。
 *
 * 锁住不变量:
 *   1) 分享状态落盘到 data/maple-share-state/<账号id>.json, 进程重启(丢内存)后仍按天去重;
 *   2) 成功当天 → hasSharedToday()=true, 自动流程跳过; 跨天自动失效;
 *   3) 失败重试封顶 MAX_SHARE_ATTEMPTS=3, 不会每 20 分钟无限刷;
 *   4) reportShareCrit() 去重命中时直接 skipped(不发协议, 因此无需 proto 环境);
 *   5) 兑换列表 #5 = 已购数量(sold), 剩余可兑 = limit - sold;
 *   6) 兑换请求把 count 编进 payload #2, 服务端一次兑多个(线上实测 count=2 扣两份)。
 */
const fs = require('node:fs');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'maple-share-test');

process.env.FARM_ACCOUNT_ID = 'test-acc';

const maple = require(`${SB}/src/services/maple-market`);
const T = maple.__testing;

(async () => {
    // ===== 1. 落盘路径 =====
    section('分享状态: 按账号落盘');
    check('路径含 maple-share-state', T.shareStateFile().includes('maple-share-state'));
    check('路径含账号 id', T.shareStateFile().includes('test-acc'));
    check('初始未分享', maple.hasSharedToday() === false);

    // ===== 2. 写入 → 重启后仍在 =====
    section('分享状态: 持久化(模拟重启)');
    const today = T.dayKey();
    T.saveShareState({ day: today, ok: true, attempts: 1, shareCount: 2, basePriceBefore: 167, basePriceAfter: 167 });
    check('文件已写入', fs.existsSync(T.shareStateFile()));
    const raw = JSON.parse(fs.readFileSync(T.shareStateFile(), 'utf8'));
    check('文件 day=今天', raw.day === today);
    check('文件 ok=true', raw.ok === true);
    check('文件 shareCount=2', raw.shareCount === 2);

    T.resetShareStateCache(); // 丢内存 → 从磁盘重读
    check('重启后仍判定今天已分享', maple.hasSharedToday() === true);
    check('重启后 shareCount 读回', maple.loadShareState().shareCount === 2);

    // ===== 3. 去重命中 → 直接 skipped =====
    section('分享上报: 去重命中直接 skipped');
    const r = await maple.reportShareCrit();
    check('返回 skipped', r && r.skipped === true);
    check('reason 提示今天已分享', String(r.reason || '').includes('今天已分享'));

    // ===== 4. 跨天失效 =====
    section('分享状态: 跨天失效');
    T.saveShareState({ day: '2000-1-1', ok: true, attempts: 1 });
    T.resetShareStateCache();
    check('昨天的记录不算今天', maple.hasSharedToday() === false);

    // ===== 5. 失败重试封顶 =====
    section('分享状态: 失败最多 3 次');
    T.saveShareState({ day: T.dayKey(), ok: false, attempts: 1 });
    T.resetShareStateCache();
    check('失败 1 次 → 还会重试', maple.hasSharedToday() === false);
    T.saveShareState({ day: T.dayKey(), ok: false, attempts: 3 });
    T.resetShareStateCache();
    check('失败 3 次 → 今天收手', maple.hasSharedToday() === true);
    const r2 = await maple.reportShareCrit();
    check('收手后不再发协议', r2 && r2.skipped === true && String(r2.reason || '').includes('未成功'));

    // ===== 6. 兑换列表: #5 = 已购 =====
    section('兑换列表: sold(#5) / limit(#4)');
    const hex = encodeExchangeList([
        { slot: 10, price: 7000, limit: 5, sold: 2, visible: 1 },
        { slot: 5, price: 12000, limit: 1, sold: 1, visible: 1 },
    ], 278560);
    const parsed = T.parseExchangeList(hex);
    check('解析出 2 个槽位', parsed.slots.length === 2);
    check('福气币余额 278560', parsed.coin === 278560);
    const s10 = parsed.slots.find(s => s.slot === 10);
    const s5 = parsed.slots.find(s => s.slot === 5);
    check('槽10 limit=5', s10.limit === 5);
    check('槽10 sold=2(#5 已购)', s10.sold === 2);
    check('槽10 剩余可兑 3', s10.limit - s10.sold === 3);
    check('槽5 已兑完(limit=sold=1)', s5.limit === 1 && s5.sold === 1);

    // ===== 7. 兑换请求: count 进 payload #2 =====
    section('兑换请求: count 编入 payload');
    const p3 = T.encodeExchangePayload(10, 3);
    check('payload #1 = 10(槽位)', hasVarint(p3, 1, 10));
    check('payload #2 = 3(数量)', hasVarint(p3, 2, 3));
    const p0 = T.encodeExchangePayload(5, 0);
    check('count=0 兜底成 1', hasVarint(p0, 2, 1));
    check('count=0 时不会带 #2=0', !hasVarint(p0, 2, 0));
    // 兑换结果回执: #1 花费 / #2{#1 id,#2 count} / #3 余额
    const resHex = Buffer.concat([
        fVarint(1, 14000),
        fBytes(2, Buffer.concat([fVarint(1, 80001), fVarint(2, 2)])),
        fVarint(3, 278560),
    ]).toString('hex');
    const res = T.parseExchangeResult(resHex);
    check('回执 spend=14000(两份)', res.spend === 14000);
    check('回执 got[0].count=2', res.got[0] && res.got[0].count === 2);
    check('回执余额 278560', res.coin === 278560);

    finish();
})().catch((e) => {
    console.error('测试异常:', (e && e.stack) || e);
    process.exitCode = 1;
});

// ===== 小工具(测试内自足, 不依赖被测实现) =====
function varint(n) {
    const out = [];
    let v = Number(n) >>> 0;
    while (v > 0x7F) { out.push((v & 0x7F) | 0x80); v >>>= 7; }
    out.push(v);
    return Buffer.from(out);
}
function fVarint(field, n) {
    return Buffer.concat([varint((field << 3) | 0), varint(n)]);
}
function fBytes(field, buf) {
    return Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf]);
}
/** 拼 cmd97 兑换列表回包: 外层 #1=槽位消息, #2=福气币 */
function encodeExchangeList(slots, coin) {
    const parts = slots.map(s => fBytes(1, Buffer.concat([
        fVarint(1, s.slot),
        fVarint(2, s.price),
        fVarint(3, 1),
        fVarint(4, s.limit),
        fVarint(5, s.sold),
        fVarint(7, s.visible || 0),
    ])));
    parts.push(fVarint(2, coin));
    return Buffer.concat(parts).toString('hex');
}
/** payload 里是否存在 field=N 且值=v 的 varint(按字段边界扫描, 不做子串硬匹配) */
function hasVarint(payload, field, value) {
    if (!payload) return false;
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let i = 0;
    while (i < buf.length) {
        const key = readVarint(buf, i);
        if (!key) return false;
        i = key.next;
        const f = Math.floor(key.value / 8);
        const w = key.value & 7;
        if (w === 0) {
            const v = readVarint(buf, i);
            if (!v) return false;
            i = v.next;
            if (f === field && v.value === value) return true;
        } else if (w === 2) {
            const len = readVarint(buf, i);
            if (!len) return false;
            i = len.next + len.value;
        } else if (w === 5) {
            i += 4;
        } else if (w === 1) {
            i += 8;
        } else {
            return false;
        }
    }
    return false;
}
function readVarint(buf, start) {
    let value = 0;
    let shift = 0;
    let i = start;
    while (i < buf.length) {
        const b = buf[i++];
        value += (b & 0x7F) * 2 ** shift;
        if (!(b & 0x80)) return { value, next: i };
        shift += 7;
        if (shift > 49) return null;
    }
    return null;
}
