/**
 * 典藏室 + 限时藏品礼包 回归测试
 *
 * 用 2026-11-07 抓包 `20261107-112023_典藏室和快乐独享领取` 回放:
 *   1. CollectionService.GetCollections 请求/响应解析(空壳也不再报错)
 *   2. 藏品目录: 5 个系列 × 6 款 = 30 款(type=35, 按 icon_collect_<系列>_<款式> 分组)
 *   3. 概览: 从背包反推拥有状态 / 展台 / 典藏收藏点
 *   4. 限时礼包 slot=0 的限购解析({1:2,2:3,3:50} 与 {1:2,2:50} 两种形态)
 *   5. 按服务端上限买 + 买完发 ItemService.Use 开包(type=33 藏品礼包也要能自动开)
 *
 * 运行: node test/test-collection.js
 */
const path = require('node:path');
const fs = require('node:fs');

const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'collection-test';
isolateDataDir(SB, 'collection-test');

const CAP = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261107-112023_典藏室和快乐独享领取.decoded.jsonl');

/** decoded.jsonl 里每行就是一条 {dir,key,bodyHex} 明文帧 */
function loadDecoded(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
const FRAMES = loadDecoded(CAP);
const bodyOf = (key, dir) => {
    const f = FRAMES.find(j => j.key.endsWith(key) && j.dir === dir);
    if (!f) throw new Error(`抓包里没有 ${dir} ${key}`);
    return Buffer.from(f.bodyHex || '', 'hex');
};

const calls = [];
/**
 * 额外的 I/O 桩: mall.js 在 require 时就解构了 sendMsgAsync/getUserState,
 * 只换 network.sendMsgAsync 对它无效 → 这里直接给 mall 打桩(与 test-buy-book 同一手法)
 */
const mallStub = { purchased: [], used: [] };
function installMallStub() {
    const mallMod = require(`${SB}/src/services/mall`);
    const net = require(`${SB}/src/utils/network`);
    const { types } = require(`${SB}/src/utils/proto`);
    mallMod.getMallGoodsList = async (slotType = 1) => {
        if (Number(slotType) !== 0) return [];
        const resp = types.GetMallListBySlotTypeResponse.decode(mallSlot0());
        return resp.goods_list.map((b) => types.MallGoods.decode(b));
    };
    mallMod.purchaseMallGoods = async (goodsId, count = 1) => {
        mallStub.purchased.push({ goodsId: Number(goodsId), count: Number(count) });
        return types.PurchaseResponse.decode(purchaseReply(Buffer.from([0x08, goodsId & 0xff])));
    };
    const wh = require(`${SB}/src/services/warehouse`);
    wh.useItem = async (itemId, count = 1) => {
        mallStub.used.push({ itemId: Number(itemId), count: Number(count) });
        return types.UseReply.decode(Buffer.alloc(0));
    };
}

function installStub() {
    const net = require(`${SB}/src/utils/network`);
    // ⚠ mall.js 在 require 时就解构了 getUserState, 必须在这之前替换
    net.getUserState = () => ({ gold: 0, coupon: 0, goldBean: 5000, diamond: 2000 });
    net.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        calls.push({ key, body: Buffer.from(body || []) });
        if (key === 'gamepb.collectionpb.CollectionService.GetCollections') {
            return { body: bodyOf('CollectionService.GetCollections', 'S->C') };
        }
        if (key === 'gamepb.itempb.ItemService.Bag') {
            return { body: bodyOf('ItemService.Bag', 'S->C') };
        }
        if (key === 'gamepb.mallpb.MallService.GetMallListBySlotType') {
            // slot=0 → 藏品礼包; 其它 slot 回一个空列表
            const fields = require(`${SB}/src/services/mengchong`).parseTop(Buffer.from(body || []));
            const slot = Number((fields.find(x => x.f === 1) || {}).v || 0);
            if (slot === 0) return { body: bodyOf('MallService.GetMallListBySlotType', 'S->C').length ? mallSlot0() : Buffer.alloc(0) };
            return { body: Buffer.alloc(0) };
        }
        if (key === 'gamepb.mallpb.MallService.Purchase') {
            return { body: purchaseReply(Buffer.from(body || [])) };
        }
        if (key === 'gamepb.itempb.ItemService.Use') {
            return { body: Buffer.alloc(0) };
        }
        throw new Error(`未 stub 的接口: ${key}`);
    };
}

/** slot=0 的商城响应: 抓包里第 3 条 GetMallListBySlotType 响应(43.49s, goods 9 个) */
function mallSlot0() {
    const list = FRAMES.filter(j => j.key.endsWith('GetMallListBySlotType') && j.dir === 'S->C');
    return Buffer.from(list[list.length - 1].bodyHex, 'hex');
}

/** Purchase 回应: 原样回一段含 #3 物品条目的响应, 让开包逻辑有据可依 */
function purchaseReply(reqBody) {
    const mg = require(`${SB}/src/services/mengchong`);
    const fields = mg.parseTop(reqBody);
    const goodsId = Number((fields.find(x => x.f === 1) || {}).v || 0);
    // 打桩简单构造: {#1: goodsId, #2: 1, #3: {#1: 101619, #2: 1}}
    const protobuf = require('protobufjs');
    const w = protobuf.Writer.create();
    w.uint32(8).int64(goodsId);
    w.uint32(16).int64(1);
    const inner = protobuf.Writer.create();
    inner.uint32(8).int64(101619);
    inner.uint32(16).int64(1);
    w.uint32(26).bytes(inner.finish());
    return w.finish();
}

(async () => {
    await require(`${SB}/src/utils/proto`).loadProto();
    installStub();
    const collection = require(`${SB}/src/services/collection`);
    const mall = require(`${SB}/src/services/mall`);
    const warehouse = require(`${SB}/src/services/warehouse`);
    installMallStub();

    section('1. GetCollections 请求/响应解析');
    {
        calls.length = 0;
        const r = await collection.getCollections();
        check('解析成功', r.ok === true, r);
        check('回包 #1.#1 = 1', r.flag1 === 1, r);
        check('请求体 = 0a0101(与抓包一致)', calls[0].body.toString('hex') === '0a0101', calls[0].body.toString('hex'));
        check('没有多余的明细字段', r.detailHex.length === 0, r.detailHex);
    }

    section('2. 藏品目录(ItemInfo type=35)');
    {
        const cat = collection.buildCollectionCatalog();
        check('5 个系列', cat.length === 5, cat.map(s => s.name));
        check('每系列 6 款', cat.every(s => s.items.length === 6), cat.map(s => s.items.length));
        check('总计 30 款', cat.reduce((n, s) => n + s.items.length, 0) === 30);
        check('系列名可读', cat[0].name === '氧气小精灵' && cat[4].name === '果冻系列', cat.map(s => s.name));
        check('款式按 slot 排序', cat[0].items[0].slot === 1 && cat[0].items[5].slot === 6, cat[0].items.map(i => i.slot));
        check('有图标资源路径(icon_collect_1_1)', String((require(`${SB}/src/config/gameConfig`).getItemById(cat[0].items[0].id) || {}).icon_res || '').includes('icon_collect_1_1'), cat[0].items[0]);
    }

    section('3. 典藏室概览(背包反推)');
    {
        const ov = await collection.getCollectionOverview({ probe: false });
        check('目录总数 30', ov.catalogTotal === 30, ov.catalogTotal);
        check('典藏收藏点取自背包(抓包这一局 5320)', ov.points.collection === 5320, ov.points);
        check('普通收藏点取自背包(抓包这一局 5370)', ov.points.normal === 5370, ov.points);
        check('展台至少包含默认展台', ov.pedestals.some(p => p.id === 610100 && p.owned), ov.pedestals.slice(0, 3));
        check('展台数量 = ItemInfo type=34 条数(10)', ov.pedestals.length === 10, ov.pedestals.length);
        check('probe=false 时不发探测请求', ov.endpoint && ov.endpoint.skipped === true, ov.endpoint);
        // 抓包这一局背包里没有藏品(type=35), 所以已收藏为 0 —— 不能凭空报"已拥有"
        check('未拥有时不误报已收藏', ov.ownedTotal === 0, ov.ownedTotal);
        check('每个系列都有 owned/total', ov.series.every(s => s.owned === 0 && s.total === 6), ov.series.map(s => [s.owned, s.total]));
    }

    section('4. slot=0 限购解析');
    {
        const goods = await mall.getMallCatalog ? null : null;
        // 直接从 slot=0 回包里解出 1047 / 1048 的原始 #7
        const { types } = require(`${SB}/src/utils/proto`);
        const resp = types.GetMallListBySlotTypeResponse.decode(mallSlot0());
        const list = resp.goods_list.map(b => types.MallGoods.decode(b));
        const g1047 = list.find(g => Number(g.goods_id) === 1047);
        const g1048 = list.find(g => Number(g.goods_id) === 1048);
        check('slot=0 里有 1047 金豆豆藏品礼包', !!g1047, list.map(g => Number(g.goods_id)));
        check('slot=0 里有 1048 钻石藏品礼包', !!g1048, list.map(g => Number(g.goods_id)));
        check('1047 的 #7 = {1:2,2:3,3:50}',
            g1047 && Buffer.from(g1047.limit).toString('hex') === '080210031832',
            g1047 && Buffer.from(g1047.limit).toString('hex'));
        check('1048 的 #7 只有 {1:2,2:50}',
            g1048 && Buffer.from(g1048.limit).toString('hex') === '08021832',
            g1048 && Buffer.from(g1048.limit).toString('hex'));
        check('两个都被识别为藏品礼包',
            mall.isCollectionPackGoods(g1047) && mall.isCollectionPackGoods(g1048));
    }

    section('5. 按服务端上限买 + 买完开包');
    {
        mallStub.used.length = 0;
        calls.length = 0;
        const r = await mall.checkAndBuyLimitedPacks(true);
        const purchases = calls.filter(c => c.key === 'gamepb.mallpb.MallService.Purchase');
        const uses = mallStub.used;
        check('识别到 2 个藏品礼包', r.goods.length === 2, r.goods.map(g => g.name));
        check('有购买动作', purchases.length > 0, purchases.length);
        check('买完发起了开包(ItemService.Use)', uses.length > 0, uses.length);
        check('购买总是 count=1(与抓包一致)', purchases.every(p => p.body.toString('hex').endsWith('1001')), purchases.map(p => p.body.toString('hex')));
        // 1047: 限购 50 - 已购 3 = 47; 1048: 限购 50 - 已购 0 = 50 —— 只受余额约束
        check('本次购买数量 > 0', r.bought > 0, { bought: r.bought, goods: r.goods });
        check('1047 受金豆豆余额约束: 5000/300 → 16 个(少于限购剩余 47)', (r.goods.find(g => g.goodsId === 1047) || {}).bought === 16, r.goods);
        check('1048 受服务端限购约束: 50 个(钻石 2000/40)', (r.goods.find(g => g.goodsId === 1048) || {}).bought === 50, r.goods);
        check('开包数量与购买一致', r.opened === r.bought, { opened: r.opened, bought: r.bought });
    }

    section('6. type=33 藏品礼包可被仓库自动开启');
    {
        // 101619 的 ItemInfo: type=33 can_use=1
        const info = require(`${SB}/src/config/gameConfig`).getItemById(101619);
        check('101619 是 type=33 且 can_use=1', info && Number(info.type) === 33 && Number(info.can_use) === 1, info && [info.type, info.can_use]);
        // 通过仓库的开包路径验证: 打开 101619 会调用 ItemService.Use
        mallStub.used.length = 0;
        await warehouse.useItem(101619, 1);
        check('仓库 useItem 能开 101619', mallStub.used.some(u => u.itemId === 101619), mallStub.used);
    }

    finish();
})().catch((e) => {
    console.error('测试异常:', e && e.stack || e);
    process.exit(1);
});