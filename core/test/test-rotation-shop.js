/**
 * 游商(RotationShop) 购买 回归测试
 *
 * 线上问题(2026-11-18):
 *   控制台反复出现 `购买失败 #80011: gamepb.shoppb.ShopService.RotationBuyGoods 错误: code=1004012`
 *   每个巡检周期刷一条, 干扰排查。
 *
 * 抓包查明(20261117-162604):
 *   商品带限制条件 `#12 = {1:"最低等级", 2:"5"}`, 而代码**从没解析这个字段**,
 *   于是不论等级够不够都发购买请求; 买不了就抛 1004012, 每轮刷一条 error 日志。
 *
 * 这个测试锁住:
 *   1) #12 能被正确解析成 condition;
 *   2) 等级不够 → **不发**购买请求, 且只记一条汇总(不是每商品一条 error);
 *   3) 1004012 这类"当前买不了"归为 skip 而不是 error;
 *   4) 真故障(网络错误等)仍然按 error 记。
 */
const fs = require('node:fs');
const path = require('node:path');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'rotation-test';
isolateDataDir(SB, 'rotation-test');

const CAPTURE = path.join(
    __dirname, '..', '..', 'wx-code-grabber', 'captures', '20261117-162604_牧场1.decoded.jsonl',
);

const proto = require(`${SB}/src/utils/proto`);
const network = require(`${SB}/src/utils/network`);
const { types } = require(`${SB}/src/utils/proto`);

/** 从真实抓包里取一份 RotationShopInfo 响应体 */
function realShopReply() {
    if (!fs.existsSync(CAPTURE)) return null;
    for (const line of fs.readFileSync(CAPTURE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (!(j.key || '').includes('RotationShopInfo') || j.dir !== 'S->C') continue;
        if (!j.bodyHex) continue;
        const buf = Buffer.from(j.bodyHex, 'hex');
        // 只挑带商品的样本(#6)
        return buf;
    }
    return null;
}

/** 手拼 RotationShopInfoReply(通用 wire 编码, 与 parseRotationShopReply 对称) */
function varint(n) {
    const out = [];
    let v = n;
    while (v > 127) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v);
    return Buffer.from(out);
}
function tag(field, wire) { return varint((field << 3) | wire); }
function vfield(field, value) { return Buffer.concat([tag(field, 0), varint(value)]); }
function lenfield(field, buf) {
    return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}
function goodsEntry(g) {
    const parts = [];
    if (g.group !== undefined) parts.push(vfield(1, g.group));
    if (g.seq !== undefined) parts.push(vfield(2, g.seq));
    if (g.item_id !== undefined) parts.push(vfield(3, g.item_id));
    if (g.currency_id !== undefined) parts.push(vfield(5, g.currency_id));
    if (g.price !== undefined) parts.push(vfield(6, g.price));
    if (g.discount_price !== undefined) parts.push(vfield(7, g.discount_price));
    if (g.discount_from !== undefined) parts.push(vfield(8, g.discount_from));
    if (g.discount_to !== undefined) parts.push(vfield(9, g.discount_to));
    if (g.limit !== undefined) parts.push(vfield(10, g.limit));
    if (g.uid !== undefined) parts.push(vfield(13, g.uid));
    return lenfield(6, Buffer.concat(parts));
}
function buildShopReply(goods) {
    const parts = [vfield(1, 1), vfield(3, Math.floor(Date.now() / 1000) + 3600)];
    for (const g of goods) parts.push(goodsEntry(g));
    return Buffer.concat(parts);
}

/** 装一个可编程网络层, 记录发出的请求 */
function installStub(handlers) {
    const calls = [];
    network.sendMsgAsync = async (service, method, body) => {
        calls.push({ service, method, body });
        const h = handlers[method] || handlers[`${service}.${method}`];
        if (!h) throw new Error(`未预期请求: ${service}.${method}`);
        return { body: h(body) };
    };
    return calls;
}

/** ranch.js 在加载时解构 network, 桩要先装好 */
function freshRanch() {
    for (const key of Object.keys(require.cache)) {
        if (key.includes('/services/ranch.js') || key.includes('/services/ranch-facility.js')
            || key.includes('/services/warehouse.js') || key.includes('/services/mall.js')) {
            delete require.cache[key];
        }
    }
    return require(`${SB}/src/services/ranch`);
}

proto.loadProto().then(async () => {
    const shopBuf = realShopReply();

    section('1. #12 限制条件能被解析成 condition');
    {
        const ranch = freshRanch();
        check('抓到真实游商样本', !!shopBuf, 'captures/20261117-162604_牧场1.jsonl');
        if (shopBuf) {
            const parsed = ranch.__privateRanchFns.parseRotationShopReply(shopBuf);
            check('解析出商品', parsed.goods.length > 0, parsed.goods.length);
            const withCond = parsed.goods.filter(g => g.condition && g.condition.name);
            check('商品带 condition', withCond.length > 0, withCond.map(g => g.condition));
            check('condition.name = 最低等级', withCond.every(g => g.condition.name === '最低等级'),
                withCond.map(g => g.condition.name));
            check('condition.value 是数字字符串', withCond.every(g => /^\d+$/.test(String(g.condition.value))),
                withCond.map(g => g.condition.value));
        }
    }

    section('2. 等级不够 → 不发购买请求, 只记一条汇总');
    if (!shopBuf) {
        check('（跳过：无抓包样本）', false);
    } else {
            const calls = installStub({
                RotationShopInfo: () => shopBuf,
                RotationBuyGoods: () => { throw new Error('等级不够时不该发购买请求'); },
                // 便便足够, 确保进入购买分支的唯一阻碍是等级
                GetBag: () => types.GetBagReply.encode(types.GetBagReply.create({
                    items: [{ id: 7002, count: 99999 }],
                })).finish(),
            });
            // 把玩家等级设成 1(低于商品要求的 5)
            const userState = require(`${SB}/src/utils/network`).getUserState();
            userState.level = 1;

            const ranch = freshRanch();
            const logs = [];
            const { setLogHook } = require(`${SB}/src/utils/utils`);
            setLogHook((tag, msg, isWarn) => logs.push({ tag, msg: String(msg), isWarn: !!isWarn }));

            const r = await ranch.__privateRanchFns.autoBuyRotationShop({});

            check('没有发任何购买请求',
                calls.filter(c => c.method === 'RotationBuyGoods').length === 0,
                calls.map(c => c.method));
            check('bought = 0', r.bought === 0, r.bought);
            check('reason 说明是等级问题', /等级/.test(String(r.reason)), r.reason);
            // 关键: 不能每商品一条 error
            const errs = logs.filter(l => l.isWarn);
            check('没有 error/warn 日志', errs.length === 0, errs);
            const skipLogs = logs.filter(l => /跳过/.test(l.msg) && /等级/.test(l.msg));
            check('只有一条等级汇总日志', skipLogs.length === 1, skipLogs.map(l => l.msg));
    }

    section('3. 等级够 → 正常发购买请求');
    if (!shopBuf) {
        check('（跳过：无抓包样本）', false);
    } else {
            const calls = installStub({
                RotationShopInfo: () => shopBuf,
                RotationBuyGoods: () => types.RotationBuyGoodsReply.encode(types.RotationBuyGoodsReply.create({})).finish(),
                GetBag: () => types.GetBagReply.encode(types.GetBagReply.create({
                    items: [{ id: 7002, count: 99999 }],
                })).finish(),
            });
            const userState = require(`${SB}/src/utils/network`).getUserState();
            userState.level = 50;   // 远高于要求

            const ranch = freshRanch();
            const r = await ranch.__privateRanchFns.autoBuyRotationShop({});
            check('发了购买请求', calls.filter(c => c.method === 'RotationBuyGoods').length > 0,
                calls.map(c => c.method));
            check('bought > 0', r.bought > 0, r.bought);
    }

    section('4. 1004012 归为"当前不可买"而不是故障');
    {
        const ranch = freshRanch();
        const { isRotationNotPurchasable, rotationErrorHint } = ranch.__privateRanchFns;
        check('1004012 判定为不可购买',
            isRotationNotPurchasable(new Error('gamepb.shoppb.ShopService.RotationBuyGoods 错误: code=1004012 未知错误: 1004012')) === true);
        check('提示语可读', /等级不足|限购/.test(rotationErrorHint(
            new Error('code=1004012 未知错误: 1004012'))), rotationErrorHint(new Error('code=1004012 未知错误: 1004012')));
        check('限购类也归为不可购买',
            isRotationNotPurchasable(new Error('code=1004019 已售罄')) === true);
        // 真故障不能被吞成 skip
        check('网络错误不算"不可购买"',
            isRotationNotPurchasable(new Error('请求超时: RotationBuyGoods')) === false);
        check('连接未打开不算"不可购买"',
            isRotationNotPurchasable(new Error('连接未打开: RotationBuyGoods')) === false);
    }

    section('5. 松果币(1008)商品 + 折扣优先(用户 2026-11-20 要求)');
    {
        // 抓包(20261120-232455): group2 是松果币商品
        //   80011 价750 无折扣 | 80012 价2850 折后2280(80%) | 80013 价5400
        // 要求: 松果币商品也自动兑换, 且**折扣中的排最前**。
        // 折扣窗口用"未来 1 小时", 保证 isDiscountActive 为真
        const winTo = Math.floor(Date.now() / 1000) + 3600;
        const goods = [
            { group: 2, seq: 3, item_id: 80011, currency_id: 1008, price: 750, limit: 4, uid: 305 },
            { group: 2, seq: 1, item_id: 80012, currency_id: 1008, price: 2850, discount_price: 2280, discount_to: winTo, limit: 2, uid: 308 },
            { group: 2, seq: 2, item_id: 80013, currency_id: 1008, price: 5400, limit: 2, uid: 315 },
        ];
        const shopHex = buildShopReply(goods);
        const calls = installStub({
            RotationShopInfo: () => shopHex,
            RotationBuyGoods: () => types.RotationBuyGoodsReply.encode(types.RotationBuyGoodsReply.create({})).finish(),
            // 农场背包(ItemService.Bag): 只有松果币(1008), 没便便
            Bag: () => types.BagReply.encode(types.BagReply.create({
                item_bag: { items: [{ id: 1008, count: 2500 }] },
            })).finish(),
            // 牧场背包(ItemService.GetBag, scene 2): 空的, 没便便
            'gamepb.itempb.ItemService.GetBag': () => types.GetBagReply.encode(types.GetBagReply.create({ items: [] })).finish(),
        });
        const userState = require(`${SB}/src/utils/network`).getUserState();
        userState.level = 50;

        const ranch = freshRanch();
        const r = await ranch.__privateRanchFns.autoBuyRotationShop({});

        check('松果币商品被购买', r.bought > 0, r.bought);
        // 折扣中的 80012(实付 2280)应第一个买: 2500 只够买 1 件
        check('第一个买的是折扣商品 80012', r.details[0] && /80012/.test(r.details[0]), r.details);
        check('detail 标注折扣', r.details[0] && /折扣/.test(r.details[0]), r.details);
        check('购买按折扣价记账(2280 而非 2850)', /2280/.test(r.details[0] || ''), r.details);
    }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
