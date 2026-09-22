/**
 * 每日购买中级挑战书 端到端测试
 *
 * 用真实抓包(20260918)回放商城的 MallService 响应, 驱动 mall.checkAndBuyChallengeBooks:
 *   1. 首次调用应买满目标数量(150 金豆豆/个, goodsId=1050)
 *   2. 同日再次调用应跳过(不重复买)
 *   3. 状态落盘, "重启"(清模块缓存重新 require)后仍然不重复买
 *   4. 金豆豆不足时只买够的部分
 *   5. readJsonFile 等依赖真的存在(防止把不存在的导出当函数调用)
 *
 * 运行: node /tmp/test_buy_book.js
 */
const path = require('node:path');
const fs = require('node:fs');

let pass = 0; const fails = [];
function check(name, cond, extra) {
    if (cond) pass += 1;
    else fails.push(`${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
}
function section(t) { console.log(`\n── ${t}`); }

const { setupSandbox, isolateDataDir } = require('./harness');
const SB = setupSandbox();
const CAP = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20260918-081639_萌宠游记.jsonl');

// 数据目录重定向(必须在 require mall 之前)
process.env.FARM_ACCOUNT_ID = 'buy-book-test';
const TMP = isolateDataDir(SB, 'buy-book-test');

// 从抓包里取 MallListBySlotType 的响应体
function capturedReply(key) {
    const lines = fs.readFileSync(CAP, 'utf8').split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.ev || j.dir !== 'S->C' || j.key !== key || !j.hex) continue;
        const { types } = require(`${SB}/src/utils/proto`);
        const msg = types.GateMessage.decode(Buffer.from(j.hex, 'hex'));
        return Buffer.from(msg.body || []);
    }
    return null;
}

// stub 网络(抽成函数, 便于"重启"后重新打桩)
const calls = [];
const stubSendMsg = async (service, method, body) => {
    const key = `${service}.${method}`;
    calls.push({ service, method, body });
    if (method === 'GetMallListBySlotType') {
        const reply = capturedReply('gamepb.mallpb.MallService.GetMallListBySlotType');
        if (!reply) throw new Error('抓包里没有商城响应');
        return { body: reply };
    }
    if (method === 'Purchase') {
        // 购买成功: 返回一个空 PurchaseResponse
        const { types } = require(`${SB}/src/utils/proto`);
        return { body: types.PurchaseResponse.encode(types.PurchaseResponse.create({})).finish() };
    }
    throw new Error(`未 stub 的接口: ${key}`);
};
let net = require(`${SB}/src/utils/network`);
net.sendMsgAsync = stubSendMsg;

/** 模拟"进程重启": 清模块缓存 → 重新打桩 → 重新 require mall */
function restartMall(goldBean, sendMsgImpl = stubSendMsg) {
    for (const k of Object.keys(require.cache)) {
        if (k.includes(SB + '/src/') && !k.includes('/utils/proto')) delete require.cache[k];
    }
    // ⚠ 必须重新给 runtime-paths 打桩: 否则新实例会指回真实数据目录
    //   (本测试第一版就踩了这个坑, 把状态写进了 core/data/mall-state)
    const rp2 = require(`${SB}/src/config/runtime-paths`);
    rp2.getDataFile = (f) => path.join(TMP, f);
    net = require(`${SB}/src/utils/network`);
    // ⚠ 打桩必须在 require mall 之前: mall 在 require 时就解构了 sendMsgAsync,
    //   之后再改 net.sendMsgAsync 对它无效(本测试第二版踩的坑)
    net.sendMsgAsync = sendMsgImpl;
    net.getUserState().goldBean = goldBean;
    return require(`${SB}/src/services/mall`);
}

(async () => {
    const { loadProto } = require(`${SB}/src/utils/proto`);
    await loadProto();
    const mall = require(`${SB}/src/services/mall`);
    check('导出了 checkAndBuyChallengeBooks', typeof mall.checkAndBuyChallengeBooks === 'function');

    section('1. 首次购买: 目标 2 本');
    {
        net.getUserState().goldBean = 5000;
        calls.length = 0;
        const r = await mall.checkAndBuyChallengeBooks(false, 2);
        check('ok', r.ok === true, r);
        check('本次买 2 本', r.boughtNow === 2, r);
        check('累计 2/2', r.bought === 2 && r.target === 2, r);
        const buys = calls.filter(c => c.method === 'Purchase');
        check('发了 2 次购买请求', buys.length === 2, buys.length);
        // 校验请求体的 goods_id=1050 / count=1
        const { types } = require(`${SB}/src/utils/proto`);
        const req = types.PurchaseRequest.decode(buys[0].body);
        check('购买 goodsId=1050(中级挑战书)', Number(req.goods_id) === 1050, Number(req.goods_id));
        check('每次买 1 个', Number(req.count) === 1, Number(req.count));
        // 游戏自身的每日限购(实测 #7 = {1:每日, 3:2}) 必须被识别, 否则会买超被服务端拒
        check('识别出游戏每日限购 = 2', r.gameDailyLimit === 2, r.gameDailyLimit);
    }

    section('2. 同日再调用: 应跳过, 不重复买');
    {
        calls.length = 0;
        const r = await mall.checkAndBuyChallengeBooks(false, 2);
        check('未再购买', r.boughtNow === 0, r);
        check('给出跳过原因(按计划买满)', String(r.skipped).includes('按计划买满'), r.skipped);
        check('没有发购买请求', calls.filter(c => c.method === 'Purchase').length === 0, calls.length);
    }

    section('3. 不落盘(以接口为准) + 进程内防重复');
    {
        // 已按用户要求去掉本地进度文件: 判断以接口的 已购/限购 为准, 内存只做防重复
        const stateFile = path.join(TMP, 'mall-state', 'buy-challenge-book.json');
        check('不再生成本地进度文件', !fs.existsSync(stateFile), stateFile);

        // 同进程内再调 → 被内存计数拦住(不发请求)
        calls.length = 0;
        const r = await mall.checkAndBuyChallengeBooks(false, 2);
        check('进程内不重复买', r.boughtNow === 0 && r.bought === 2, r);
        check('进程内不发请求', calls.filter(c => c.method === 'Purchase').length === 0, calls.length);
        check('原因提到本进程', String(r.skipped).includes('本进程'), r.skipped);
    }

    section('4. 金豆豆不足: 只买够的部分');
    {
        const mall3 = restartMall(200);   // 只够 1 本(150)
        calls.length = 0;
        const r = await mall3.checkAndBuyChallengeBooks(false, 2);
        check('金豆豆 200 → 只买 1 本', r.boughtNow === 1, r);

        const mall4 = restartMall(100);   // 一本都买不起
        calls.length = 0;
        const r2 = await mall4.checkAndBuyChallengeBooks(false, 2);
        check('余额 100 < 150 → 不买', r2.boughtNow === 0, r2);
        check('给出"金豆豆不足"原因', String(r2.skipped).includes('金豆豆不足'), r2.skipped);
    }

    section('5. 依赖导出存在性(本轮踩的坑)');
    {
        const db = require(`${SB}/src/services/json-db`);
        check('json-db 导出 readJsonFile', typeof db.readJsonFile === 'function');
        check('json-db 有 writeJsonFileAtomic', typeof db.writeJsonFileAtomic === 'function');
        const store = require(`${SB}/src/models/store`);
        check('store 导出 getBuyBookConfig', typeof store.getBuyBookConfig === 'function');
    }

// ---------- 6. 限购解析(#7) ----------
section('6. 限购解析 #7 = {周期, 已购, 限购数}');
{
    const mall = require(`${SB}/src/services/mall`);
    check('导出了 parseMallLimit', typeof mall.parseMallLimit === 'function');

    // 中级挑战书 {#1=1(每日), #3=2} → 每日限购 2
    const book = mall.parseMallLimit(Buffer.from('08011802', 'hex'), '中级挑战书');
    check('中级挑战书 = 每日 2', book && book.limitCount === 2 && book.limitType === 'daily' && book.remaining === 2, book);

    // 每日福利 {#1=1, #2=1(已购), #3=1} → 剩余 0
    const daily = mall.parseMallLimit(Buffer.from('080110011801', 'hex'), '每日福利');
    check('每日福利 = 每日 1 已购 1 → 剩 0', daily && daily.limitCount === 1 && daily.boughtNum === 1 && daily.remaining === 0, daily);

    // 时装礼包 {#1=4(总计), #3=1}
    const pack = mall.parseMallLimit(Buffer.from('08041801', 'hex'), '绅士时装礼包');
    check('时装礼包 = 永久 1', pack && pack.limitCount === 1 && pack.limitType === 'permanent', pack);

    // 比熊点券礼包 {#1=4, #2=3, #3=3}
    const coupon = mall.parseMallLimit(Buffer.from('080410031803', 'hex'), '比熊点券礼包');
    check('比熊点券礼包 = 永久 3 已购 3 → 剩 0', coupon && coupon.limitCount === 3 && coupon.remaining === 0, coupon);

    // 不传 limit(#7 缺省) → null(不限购)
    check('无 #7 → null(不限购)', mall.parseMallLimit(Buffer.alloc(0), '10小时化肥') === null);

    // 已购 > 限购(脏数据)也要夹住
    const dirty = mall.parseMallLimit(Buffer.from('080110051801', 'hex'), 'x');
    check('已购超过限购时 remaining 不为负', dirty.remaining === 0 && dirty.boughtNum === 1, dirty);
}

// ---------- 7. 手动购买(force) + 游戏每日限购拦截 ----------
section('7. 手动购买与游戏限购');
{
    // 自造商城响应: 中级挑战书 已购 2 / 限购 2(#7 = {1:1, 2:2, 3:2}) → 应直接跳过
    // ⚠ goods_list 是 repeated bytes, 必须传"编码好的 MallGoods 字节", 直接传对象会编码成空
    const { types } = require(`${SB}/src/utils/proto`);
    const goodsBytes = types.MallGoods.encode(types.MallGoods.create({
        goods_id: 1050,
        name: '中级挑战书',
        type: 1,
        item_ids: [Buffer.from('08e6f1041001', 'hex')],       // {80102, 1}
        price: Buffer.from('08f907109601', 'hex'),            // {1005(金豆豆), 150}
        limit: Buffer.from('080110021802', 'hex'),            // {1:每日, 2:已购2, 3:限购2}
        is_limited: true,
    })).finish();
    const limitReached = types.GetMallListBySlotTypeResponse.encode(types.GetMallListBySlotTypeResponse.create({
        goods_list: [goodsBytes],
    })).finish();

    const mall = restartMall(5000, async (service, method) => {
        if (method === 'GetMallListBySlotType') return { body: limitReached };
        if (method === 'Purchase') {
            const { types: t } = require(`${SB}/src/utils/proto`);
            return { body: t.PurchaseResponse.encode(t.PurchaseResponse.create({})).finish() };
        }
        throw new Error('未 stub: ' + service + '.' + method);
    });
    calls.length = 0;
    const r = await mall.checkAndBuyChallengeBooks(true, 2);     // force=true 也不能突破游戏限购
    check('游戏限购买满时不购买', r.boughtNow === 0, r);
    check('原因写明游戏侧限购', String(r.skipped).includes('游戏侧今日限购已满'), r.skipped);
    check('no purchase request', calls.filter(c => c.method === 'Purchase').length === 0, calls.length);
}

// ---------- 7b. force 语义: 机器人自己记的"已买满"不该拦住手动购买 ----------
section('7b. 手动购买不被自身计数拦住');
{
    // 用真实抓包(游戏侧 已购 0 / 限购 2)
    const mall = restartMall(5000);
    calls.length = 0;
    // 先把"今天"用自动路径买满
    const first = await mall.checkAndBuyChallengeBooks(false, 2);
    check('自动路径先买 2 本', first.boughtNow === 2, first);

    // 自动路径再调 → 应被我们自己的计数拦住
    calls.length = 0;
    const auto = await mall.checkAndBuyChallengeBooks(false, 2);
    check('自动路径: 已买满就跳过', auto.boughtNow === 0, auto);
    check('自动路径: 原因说明"按计划买满"', String(auto.skipped).includes('按计划买满'), auto.skipped);
    check('自动路径: 没有发请求', calls.filter(c => c.method === 'Purchase').length === 0, calls.length);

    // 手动(force) → 应继续买(受游戏侧限购约束, 这里游戏侧允许 2 本)
    calls.length = 0;
    const manual = await mall.checkAndBuyChallengeBooks(true, 2);
    check('手动路径: 仍会购买', manual.boughtNow === 2, manual);
    check('手动路径: force 标记', manual.force === true, manual.force);
    check('手动路径: 有请求', calls.filter(c => c.method === 'Purchase').length === 2, calls.length);
    check('返回诊断: 买后本进程计数 4', manual.bought === 4 && manual.todayBoughtByBot === 4, { pre: manual.todayBoughtByBot, after: manual.bought });
    check('返回诊断: 游戏侧已购 0/2', manual.gameBought === 0 && manual.gameDailyLimit === 2, manual);
}

// ---------- 8. 默认值三处一致(踩过的坑) ----------
section('8. 默认开启的一致性');
{
    const store = require(`${SB}/src/models/store`);
    const cfg = store.getBuyBookConfig('never-configured-account');
    check('未配置账号默认开启', cfg.enabled === true, cfg);
    check('默认数量 2', cfg.count === 2, cfg);
    const snap = store.getConfigSnapshot('never-configured-account');
    check('快照里也是开启(与 getBuyBookConfig 一致)', snap.buyBookEnabled === true, snap.buyBookEnabled);
    const def = typeof store.getDefaultAccountConfig === 'function' ? store.getDefaultAccountConfig() : {};
    check('账号默认配置里也是开启', def.buyBookEnabled === true, def.buyBookEnabled);
}

    console.log(`\n通过 ${pass} / ${pass + fails.length}`);
    if (fails.length) { console.log('✗ 失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('✓ 全部通过');
    process.exit(0);
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
