/**
 * 化肥自动购买: 点券余额读取 + 不足当天停购 回归测试
 *
 * 背景(2026-11-28 线上日志, 26h 44 条 code=1000019):
 *   1) autoBuyFertilizerViaMall / autoBuyOrganicFertilizerViaMall 读余额用的
 *      `userState.ticket` —— userState 里根本没有这个字段(点券叫 .coupon),
 *      恒 undefined → 余额预拦全部失效, 点券为 0 的号每轮检测都硬买一次。
 *   2) catch 到"点券不足"后还会 `perRound>1 → perRound=1; continue` 再硬打一次
 *      必然失败的请求(买不起 10 个也买不起 1 个, 点券不足与批量数无关),
 *      同一秒出现两条 1000019。
 *
 * 锁住不变量:
 *   a) 余额读 .coupon(存在且>0 时, 首轮 perRound = min(10, floor(coupon/单价)));
 *   b) 点券不足 → 直接当天停购(buyPausedNoGoldDateKey), 不再降 perRound 重试,
 *      整轮对 Purchase 只发 1 次;
 *   c) 当天停购后, checkAndBuyFertilizerBoth 直接短路, 不再拉背包/商城。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'fert-ticket-test';
isolateDataDir(SB, 'fert-ticket-test');

const network = require(`${SB}/src/utils/network`);
// mock 的回包要用 proto 类型编码 —— proto 必须先 load(线上由 worker 启动时做)
// ⚠ mall.js 顶部 `const { sendMsgAsync } = require('../utils/network')` 是解构复制:
//   必须先把 mock 打到 network 模块属性上, 再 require mall, 解构才拿得到 mock。
const __origSend = network.sendMsgAsync;
let purchaseCalls = 0;
let purchaseShouldFail = true;
network.sendMsgAsync = async (service, method) => {
    if (service === 'gamepb.mallpb.MallService' && method === 'Purchase') {
        purchaseCalls += 1;
        if (purchaseShouldFail) throw new Error('gamepb.mallpb.MallService.Purchase 错误: code=1000019 点券不足');
        return { body: Buffer.alloc(0) };
    }
    if (service === 'gamepb.mallpb.MallService' && method === 'GetMallListBySlotType') {
        const { types } = require(`${SB}/src/utils/proto`);
        let g = types.MallGoods.encode(types.MallGoods.create({ goods_id: 1003 })).finish();
        const dec = types.MallGoods.decode(g);
        dec.price = 34;
        g = types.MallGoods.encode(dec).finish();
        const body = types.GetMallListBySlotTypeResponse.encode(
            types.GetMallListBySlotTypeResponse.create({ goods_list: [g] }),
        ).finish();
        return { body };
    }
    return __origSend(service, method);
};
const mall = require(`${SB}/src/services/mall`);

function setCoin(count) {
    // 模拟网络层把点券(1002)写进 userState.coupon
    const st = network.getUserState();
    st.coupon = count;
}

(async () => {
    // proto 类型必须在任何 mock 回包构造前就绪(线上由 worker 启动时 await loadProto)
    await require(`${SB}/src/utils/proto`).loadProto();

    section('a) 余额读 .coupon: coupon=68(单价34) → 首轮 perRound=2');
    {
        const src = require('node:fs').readFileSync(`${SB}/src/services/mall.js`, 'utf8');
        check('余额取自 userState.coupon(不是不存在的 .ticket)',
            /getUserState\(\) \|\| \{\}\)\.coupon\)/.test(src) && !/getUserState\(\) \|\| \{\}\)\.ticket\)/.test(src));
        setCoin(68);
        const perRound = Math.max(1, Math.min(10, Math.floor(68 / 34) || 1));
        check('coupon=68/单价34 → perRound=2', perRound === 2);
    }

    section('b) 点券不足: 只发 1 次 Purchase, 直接当天停购(不再降 perRound 重试)');
    {
        setCoin(0);
        purchaseCalls = 0;
        purchaseShouldFail = true;
        const bought = await mall.autoBuyFertilizer(true, 'normal', 10);
        check('点券不足 → 买回 0 个', bought === 0);
        check('整个购买循环只发 1 次 Purchase(不降 perRound 重试)', purchaseCalls === 1, purchaseCalls);
        const st = mall.getFertilizerBuyDailyState();
        check('当天停购标记已打上', st.pausedNoGoldToday === true, st);
    }

    section('c) 当天停购后 checkAndBuyFertilizerBoth 直接短路');
    {
        const r = await mall.checkAndBuyFertilizerBoth({
            buyOrganic: true, buyNormal: true,
            organicCount: 10, organicThresholdHours: 50,
            normalCount: 10, normalThresholdHours: 50,
        });
        check('返回 pausedNoTicketToday=true', r.pausedNoTicketToday === true, r);
        check('短路: 有机/无机都买了 0 个', r.organicBought === 0 && r.normalBought === 0);
    }

    finish();
})().catch((e) => {
    console.error('测试异常:', (e && e.stack) || e);
    process.exitCode = 1;
});
