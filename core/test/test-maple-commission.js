/**
 * 以薯换福「摊位提成自动领取」回归测试 (2026-11-28)
 *
 * 协议(抓包 wx-code-grabber/captures/20261128-101021_蜜薯.decoded.jsonl 实证):
 *   好友卖蜜薯到你的摊, 摊主抽 2% 提成, 挂在 #130#11(待领金额)/#130#13(待领笔数);
 *   CMD 99 空请求(#199 "")一次性领走 → 回执 #199 {#1 提成金额, #3 笔数, #4 领取后福币余额},
 *   领后 #130#11/#13 清零, #130#3(福气币) 涨到回执 #4 值。
 *   实测帧: #130 {#11: 6450, #13: 11} → cmd99 → #199 {#1: 6450, #3: 11, #4: 599170}。
 *
 * 锁住不变量:
 *   1) parseMainState 能从 #130 读出 commissionPending/commissionCount(含清零帧=0);
 *   2) claimCommission: #11=0 时跳过不发请求;
 *   3) claimCommission: 有待领时发空请求 cmd99, 解析回执 #199 金额/笔数/余额;
 *   4) runAuto 默认带提成分支且不挡卖(cfg.claimCommission=false 可关)。
 */
const { setupSandbox, isolateDataDir, createChecker, makeCaptureReplayer } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'maple-commission-test');

const maple = require(`${SB}/src/services/maple-market`);
const T = maple.__testing;

// ===== protobuf 编码小工具(测试内自足) =====
function varint(v) {
    const out = [];
    let n = BigInt(v);
    do {
        let b = Number(n & 0x7Fn);
        n >>= 7n;
        if (n > 0n) b |= 0x80;
        out.push(b);
    } while (n > 0n);
    return Buffer.from(out);
}
function f(field, val) { // varint 字段
    return Buffer.concat([varint((field << 3) | 0), varint(val)]);
}
function fm(field, buf) { // message 字段
    return Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf]);
}
function fs(field, str) { // string 字段
    const b = Buffer.from(str, 'utf8');
    return Buffer.concat([varint((field << 3) | 2), varint(b.length), b]);
}

// ===== 抓包同构帧构造 =====
// #130 主状态: #3 福币, #5 基础价, #6 摊上存量, #7 累计收益, #11 待领提成, #13 笔数
function mainState({ coin = 592720, base = 166, holding = 66, income = 13975, pending = 0, count = 0 } = {}) {
    const parts = [
        fm(1, f(1, 1)),                       // #1 种子已领
        f(3, coin), f(5, base), f(6, holding), f(7, income),
    ];
    if (pending > 0) parts.push(f(11, pending));
    if (count > 0) parts.push(f(13, count));
    return Buffer.concat(parts);
}
// Operate 回包: activity 容器(#3)里装 #130; resultHex = 顶层第一个 f>100 字段值
function operateReply({ st130, resultFieldsBuf } = {}) {
    const activity = fm(130, st130);
    const body = fm(1, f(1, 2026111708));
    // 顶层: #1 组id, #2 cmd, #3 activity, #1xx result
    const parts = [f(1, 2026111708)];
    if (resultFieldsBuf) parts.push(fm(2, f(2, 92)), fm(3, activity), fm(192, resultFieldsBuf));
    else parts.push(fm(2, f(2, 92)), fm(3, activity));
    return Buffer.concat(parts);
}

section('parseMainState 提成字段');
{
    const withP = T.parseMainState(mainState({ pending: 6450, count: 11 }));
    check(withP.ok && withP.commissionPending === 6450, `#11 读出待领提成 6450 (实际 ${withP.commissionPending})`);
    check(withP.commissionCount === 11, `#13 读出笔数 11 (实际 ${withP.commissionCount})`);
    check(withP.coin === 592720, '福气币不串位');

    const clean = T.parseMainState(mainState({ coin: 599170 }));
    check(clean.commissionPending === 0 && clean.commissionCount === 0, '领后清零帧 → 0/0, 不误读其它字段');
}

(async () => {
section('claimCommission: 无待领 → 跳过不发请求');
{
    let sent = 0;
    maple.__testing.op = async (cmd) => { sent += 1; return { ok: false, reason: '不应发请求' }; };
    const r = await (async () => maple.claimCommission())();
    check(r.ok && r.skipped && sent === 0, `#11=0 跳过 (sent=${sent})`);
}

section('claimCommission: 有待领 → cmd99 空请求 + 解析 #199');
{
    let seenCmd = null;
    let seenPayload = null;
    maple.__testing.op = async (cmd, payloadField, payloadBytes) => {
        seenCmd = cmd;
        seenPayload = payloadBytes;
        // 回执 #199 {#1: 6450, #3: 11, #4: 599170}
        const rsp199 = Buffer.concat([f(1, 6450), f(3, 11), f(4, 599170)]);
        return { ok: true, errorCode: 0, resultHex: rsp199.toString('hex'), activity: mainState({ coin: 599170 }) };
    };
    const r = await (async () => maple.claimCommission())();
    check(seenCmd === 99, `发的是 cmd99 (实际 ${seenCmd})`);
    check(Buffer.isBuffer(seenPayload) && seenPayload.length === 0, '请求体为空(抓包同构)');
    check(r.ok && r.amount === 6450, `金额 6450 (实际 ${r.amount})`);
    check(r.count === 11, `笔数 11 (实际 ${r.count})`);
    check(r.coinAfter === 599170, `领取后余额 599170 (实际 ${r.coinAfter})`);
}

section('runAuto 默认带提成分支 + 可关');
{
    const calls = [];
    maple.__testing.op = async (cmd) => { calls.push(cmd); return { ok: false, reason: 'stop', errorCode: 1 }; };
    // claimSeeds 先查状态会失败 → runAuto 早退, 但提成在领种子之后, 用 claimSeed:false 跳过
    const r1 = await (async () => maple.runAuto({ claimSeed: false, plant: false, sell: false }))();
    check(calls.includes(99), '默认会尝试领提成(cmd99)');
    check(r1.commission === 0, '失败时 commission 保持 0 不脏数据');

    calls.length = 0;
    await (async () => maple.runAuto({ claimSeed: false, plant: false, sell: false, claimCommission: false }))();
    check(!calls.includes(99), 'claimCommission=false 不发 cmd99');
}
finish();
})().catch((e) => { console.error(e); process.exit(1); });
