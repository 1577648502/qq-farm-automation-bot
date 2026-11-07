/**
 * 典藏室 + 限时藏品礼包 回归测试
 *
 * 用 2026-11-07 抓包 `20261107-112023_典藏室和快乐独享领取` 回放:
 *   1. CollectionService.GetCollections 请求/响应解析(空壳也不再报错)
 *   2. 藏品目录: 5 个系列 × 6 款 = 30 款(type=35, 按 icon_collect_<系列>_<款式> 分组)
 *   3. 概览: 从背包反推拥有状态 / 展台 / 典藏收藏点
 *   4. 限时礼包 slot=5 的限购解析({1:2,2:3,3:50} 与 {1:2,2:50} 两种形态)
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
/**
 * 背包桩模式:
 *   null      → 回放抓包里的真实背包(概览断言用)
 *   数字      → 只含该数量的金豆豆藏品礼包(开包断言用)
 */
let bagOverride = null;
function installMallStub() {
    const mallMod = require(`${SB}/src/services/mall`);
    const net = require(`${SB}/src/utils/network`);
    const { types } = require(`${SB}/src/utils/proto`);
    mallMod.getMallGoodsList = async (slotType = 1) => {
        if (Number(slotType) !== 5) return [];
        const resp = types.GetMallListBySlotTypeResponse.decode(mallSlot0());
        return resp.goods_list.map((b) => types.MallGoods.decode(b));
    };
    mallMod.purchaseMallGoods = async (goodsId, count = 1) => {
        mallStub.purchased.push({ goodsId: Number(goodsId), count: Number(count) });
        return types.PurchaseResponse.decode(purchaseReply(Buffer.from([0x08, goodsId & 0xff])));
    };
    // ⚠ warehouse 在 require 时就解构了 getBag / sendMsgAsync, 换 exports 无效。
    //   所以背包内容由 installStub 里的网络桩提供(见 BAG 状态), 这里只记录 Use 调用。
    // warehouse.useItem 走 network.sendMsgAsync(见上), 这里不再重复打桩
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
            if (bagOverride === null) return { body: bodyOf('ItemService.Bag', 'S->C') };
            const { types } = require(`${SB}/src/utils/proto`);
            return {
                body: types.BagReply.encode(types.BagReply.create({
                    item_bag: { items: bagOverride > 0 ? [{ id: 101619, count: bagOverride }] : [] },
                })).finish(),
            };
        }
        if (key === 'gamepb.mallpb.MallService.GetMallListBySlotType') {
            // slot=5 → 限时商店(含藏品礼包); 其它 slot 回一个空列表
            const fields = require(`${SB}/src/services/mengchong`).parseTop(Buffer.from(body || []));
            const slot = Number((fields.find(x => x.f === 1) || {}).v || 0);
            if (slot === 5) return { body: bodyOf('MallService.GetMallListBySlotType', 'S->C').length ? mallSlot0() : Buffer.alloc(0) };
            return { body: Buffer.alloc(0) };
        }
        if (key === 'gamepb.mallpb.MallService.Purchase') {
            return { body: purchaseReply(Buffer.from(body || [])) };
        }
        if (key === 'gamepb.itempb.ItemService.Use') {
            // warehouse 的 useItem 走的是 network 层(require 时已解构), 按这里记录
            const fields = require(`${SB}/src/services/mengchong`).parseTop(Buffer.from(body || []));
            mallStub.used.push({
                itemId: Number((fields.find(x => x.f === 1) || {}).v || 0),
                count: Number((fields.find(x => x.f === 2) || {}).v || 0),
            });
            bagOverride = 0;   // 开完就空了
            return { body: Buffer.alloc(0) };
        }
        throw new Error(`未 stub 的接口: ${key}`);
    };
}

/** slot=5 的商城响应: 抓包里第 3 条 GetMallListBySlotType 响应(43.49s, goods 9 个) */
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

    section('4. slot=5 限购解析');
    {
        const goods = await mall.getMallCatalog ? null : null;
        // 直接从 slot=5 回包里解出 1047 / 1048 的原始 #7
        const { types } = require(`${SB}/src/utils/proto`);
        const resp = types.GetMallListBySlotTypeResponse.decode(mallSlot0());
        const list = resp.goods_list.map(b => types.MallGoods.decode(b));
        const g1047 = list.find(g => Number(g.goods_id) === 1047);
        const g1048 = list.find(g => Number(g.goods_id) === 1048);
        check('slot=5 里有 1047 金豆豆藏品礼包', !!g1047, list.map(g => Number(g.goods_id)));
        check('slot=5 里有 1048 钻石藏品礼包', !!g1048, list.map(g => Number(g.goods_id)));
        check('1047 的 #7 = {1:2,2:3,3:50}',
            g1047 && Buffer.from(g1047.limit).toString('hex') === '080210031832',
            g1047 && Buffer.from(g1047.limit).toString('hex'));
        check('1048 的 #7 只有 {1:2,2:50}',
            g1048 && Buffer.from(g1048.limit).toString('hex') === '08021832',
            g1048 && Buffer.from(g1048.limit).toString('hex'));
        check('1047 金豆豆藏品礼包 → 要买', mall.isCollectionPackGoods(g1047) === true);
        check('1048 钻石藏品礼包 → 明确不买', mall.isCollectionPackGoods(g1048) === false);
        check('奶茶礼包不会被误认(1061)', mall.isCollectionPackGoods(list.find(g => Number(g.goods_id) === 1061)) === false);
    }

    section('4b. 商城列表请求体必须与抓包逐字节一致(1031002 的根因)');
    {
        // 抓包三种请求: slot5 → 08 05 10 01 18 01 / slot1 → 08 01 10 00 18 01
        // 踩过的坑: ① proto3 把 slot=0 当默认值省略 → 发空请求体 → 1031002 商品不可购买
        //           ② 用 .proto 编码会把值为 0 的 #2 也省略, 与客户端不一致
        calls.length = 0;
        await mall.getMallListBySlotType(5).catch(() => null);
        await mall.getMallListBySlotType(1).catch(() => null);
        await mall.getMallListBySlotType(0).catch(() => null);
        const hexes = calls.filter(c => c.key === 'gamepb.mallpb.MallService.GetMallListBySlotType')
            .map(c => c.body.toString('hex'));
        check('slot=5 请求体 = 080510011801', hexes[0] === '080510011801', hexes[0]);
        check('slot=1 请求体 = 080110001801', hexes[1] === '080110001801', hexes[1]);
        check('slot=0 回落到 slot=1(绝不发空请求体)',
            hexes[2] === '080110001801' && hexes[2] !== '', hexes[2]);
        check('三次请求都不是空 body', hexes.every(h => h.length >= 8), hexes);
    }

    section('5. 按服务端上限买 + 买完开包(只买金豆豆礼包, 开箱只走仓库一次)');
    {
        mallStub.used.length = 0;
        bagOverride = 5;      // 包里实际只剩 5 个(买了 45 个, 巡查已开掉一部分)
        calls.length = 0;
        const r = await mall.checkAndBuyLimitedPacks(true);
        const purchases = calls.filter(c => c.key === 'gamepb.mallpb.MallService.Purchase');
        const uses = mallStub.used;
        check('只买 1 个礼包(钻石礼包被排除)', r.goods.length === 1, r.goods.map(g => g.name));
        check('买的是金豆豆藏品礼包', r.goods[0] && r.goods[0].goodsId === 1047, r.goods[0]);
        check('没有任何 1048 的购买请求',
            purchases.every(p => !p.body.includes(Buffer.from([0x98, 0x08]))), purchases.map(p => p.body.toString('hex')));
        check('有购买动作', purchases.length > 0, purchases.length);
        check('购买总是 count=1(与抓包一致)', purchases.every(p => p.body.toString('hex').endsWith('1001')), purchases.map(p => p.body.toString('hex')));
        check('本次购买数量 > 0', r.bought > 0, { bought: r.bought, goods: r.goods });
        check('1047 受金豆豆余额约束: 5000/300 → 16 个(少于限购剩余 47)', r.goods[0].bought === 16, r.goods[0]);

        // 开箱: 只调一次仓库 Use(不能再额外自己开一遍), 且数量取背包实际值
        check('开箱只调用一次 ItemService.Use(不再重复开)', uses.length === 1, uses);
        check('开的是 101619', uses[0] && uses[0].itemId === 101619, uses[0]);
        check('开箱数量取背包实际数量 5(不是本次购买的 16)', uses[0] && uses[0].count === 5, uses[0]);
        check('开箱数量 != 购买数量', uses[0] && uses[0].count !== r.bought, { used: uses[0], bought: r.bought });
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