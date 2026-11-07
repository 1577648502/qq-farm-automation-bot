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

/** GetCollections 回放用: null = 抓包里第一条, 否则用指定 hex */
let collectionReplyHex = null;
/** 自定义背包回包(优先级高于 bagOverride) */
let originalBagReply = null;
/** true = ClaimCollectionReward 模拟服务端 1047006 */
let claimNoReward = false;
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
            return { body: collectionReplyHex ? Buffer.from(collectionReplyHex, 'hex') : bodyOf('CollectionService.GetCollections', 'S->C') };
        }
        if (key === 'gamepb.itempb.ItemService.Bag') {
            if (originalBagReply) return { body: Buffer.from(originalBagReply) };
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
        if (key === 'gamepb.collectionpb.CollectionService.ClaimCollectionReward') {
            if (claimNoReward) throw new Error('gamepb.collectionpb.CollectionService.ClaimCollectionReward 错误: code=1047006 暂无可领取的奖励');
            // 抓包 61.06s 实测: #2=1200 #3=1000 #4{50=1000}
            return { body: Buffer.from('10b00918e80722049003e807', 'hex') };
        }
        if (key === 'gamepb.collectionpb.CollectionService.UpgradeCollection') {
            // 抓包 25.24s 实测: #1=1 #2=700005 #3=1 #4=600
            return { body: Buffer.from('080110e5dc2a180120d804', 'hex') };
        }
        if (key === 'gamepb.collectionpb.CollectionService.SwitchSceneDisplay') {
            // 抓包 27.71s 实测: 原样回显
            return { body: Buffer.from(body || []) };
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

    section('1. GetCollections 请求体(与抓包一致)');
    {
        calls.length = 0;
        const r = await collection.getCollections();
        check('解析成功', r.ok === true, r);
        check('请求体 = 0a0101(抓包 0.30s 实测)', calls[0].body.toString('hex') === '0a0101', calls[0].body.toString('hex'));
        check('返回原始 hex', typeof r.rawHex === 'string' && r.rawHex.length > 0, r.rawHex);
        check('entries 是数组', Array.isArray(r.entries), r.entries);
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

    section('3. GetCollections 解析(2026-11-07 真实帧)');
    {
        // 首包(0.35s): 只有获得时间, 星级未下发
        const first = collection.__testing.parseCollectionsReply(
            Buffer.from('0a220801120e08e4dc2a180120cb97bbd7062801120e08e5dc2a1801209098bbd70628011200', 'hex'),
        );
        check('首包解析出 2 个藏品', first.entries.length === 2, first.entries);
        check('首包 #1 = 1', first.field1 === 1, first.field1);
        check('首包 星级未下发(=0)', first.entries.every(e => e.star === 0), first.entries.map(e => e.star));
        check('首包 均已激活', first.entries.every(e => e.activated === 1), first.entries.map(e => e.activated));
        check('首包 获得时间 = 1794034635/1794034704',
            first.entries.map(e => e.obtainedAt).sort((a, b) => a - b).join(',') === '1794034635,1794034704',
            first.entries.map(e => e.obtainedAt));
        check('首包 展示位为空', first.displays.length === 0, first.displays);

        // 末包(68.75s): 星级/评分/展示位齐全
        const last = collection.__testing.parseCollectionsReply(
            Buffer.from('0a280801120e08e5dc2a10011801209098bbd706120e08e4dc2a1001180120cb97bbd70628e80730b009120a08011206080110e5dc2a', 'hex'),
        );
        check('末包解析出 2 个藏品', last.entries.length === 2, last.entries);
        check('末包 星级均为 1', last.entries.every(e => e.star === 1), last.entries.map(e => e.star));
        check('末包 已领评分 = 1000', last.claimedScore === 1000, last.claimedScore);
        check('末包 当前评分 = 1200', last.totalScore === 1200, last.totalScore);
        check('末包 展示位 = 700005', last.displays.length === 1
            && last.displays[0].scene === 1 && last.displays[0].slot === 1 && last.displays[0].itemId === 700005, last.displays);
    }

    section('3b. 概览(服务端状态 + 背包展台)');
    {
        // 网络桩改回放"末包"(星级/展示位齐全); 背包仍回放抓包数据
        collectionReplyHex = '0a280801120e08e5dc2a10011801209098bbd706120e08e4dc2a1001180120cb97bbd70628e80730b009120a08011206080110e5dc2a';
        const ov = await collection.getCollectionOverview({ probe: true });
        check('目录总数 30', ov.catalogTotal === 30, ov.catalogTotal);
        check('服务端连通', ov.serverOk === true, ov.serverOk);
        check('已激活藏品 = 2', ov.ownedTotal === 2, ov.ownedTotal);
        const p700005 = ov.series.flatMap(s => s.items).find(i => i.id === 700005);
        check('700005 已激活且 1 星', p700005 && p700005.owned && p700005.star === 1, p700005);
        check('700005 有获得时间', p700005 && p700005.obtainedAt === 1794034704, p700005 && p700005.obtainedAt);
        check('当前展示位 = 700005', ov.display && ov.display.itemId === 700005, ov.display);
        check('评分 1200 / 已领 1000', ov.score.total === 1200 && ov.score.claimed === 1000, ov.score);
        // ⚠ 不能由 total > claimed 推断"有可领": 实测 1200 > 1000 却回 1047006
        check('claimable 不靠比值推断(为 null, 以试领为准)', ov.score.claimable === null, ov.score.claimable);
        check('展台数量 = ItemInfo type=34 条数(10)', ov.pedestals.length === 10, ov.pedestals.length);
        check('至少包含默认展台', ov.pedestals.some(p => p.id === 610100 && p.owned), ov.pedestals.slice(0, 3));
        check('典藏收藏点取自背包', ov.points.collection === 5320, ov.points);
    }

    section('3c. 升星/展示/领奖 请求体与抓包逐字节一致');
    {
        calls.length = 0;
        await collection.upgradeCollection(700005).catch(() => null);
        await collection.switchSceneDisplay(700005).catch(() => null);
        await collection.switchSceneDisplay(0).catch(() => null);
        await collection.claimCollectionReward().catch(() => null);

        const hex = calls.map(c => `${c.key.split('.').pop()}=${c.body.toString('hex')}`);
        check('升星请求 = 080110e5dc2a', hex.includes('UpgradeCollection=080110e5dc2a'), hex);
        check('展示请求 = 0a0a08011206080110e5dc2a', hex.includes('SwitchSceneDisplay=0a0a08011206080110e5dc2a'), hex);
        check('清空展示 = 0a0a08011206080110001800', hex.includes('SwitchSceneDisplay=0a0a08011206080110001800'), hex);
        check('领奖请求 = 0801', hex.includes('ClaimCollectionReward=0801'), hex);
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

    section('5b. 自动流程 runCollectionTasks(有货才升星 / 有新增才领奖)');
    {
        // 场景A: 展示位为空(首包) + 背包回放抓包(没有精灵) + 评分 0/0
        collectionReplyHex = '0a220801120e08e4dc2a180120cb97bbd7062801120e08e5dc2a1801209098bbd70628011200';
        bagOverride = null;
        calls.length = 0;
        const a = await collection.runCollectionTasks({});
        const kindsA = calls.map(c => c.key.split('.').pop());
        check('展示位为空 → 自动摆上', kindsA.includes('SwitchSceneDisplay'), kindsA);
        check('背包没有同名精灵 → 不发升星', !kindsA.includes('UpgradeCollection'), kindsA);
        // 现在每次都"试着领一次", 由服务端判定有没有档位(1047006 = 没有)
        check('评分奖励改为试领(不再靠比值猜)', kindsA.includes('ClaimCollectionReward'), kindsA);
        check('流程 ok', a.ok === true, a);

        // 场景B: 末包(已 1 星, 展示已设, 评分 1200/1000)
        collectionReplyHex = '0a280801120e08e5dc2a10011801209098bbd706120e08e4dc2a1001180120cb97bbd70628e80730b009120a08011206080110e5dc2a';
        calls.length = 0;
        const b = await collection.runCollectionTasks({});
        const kindsB = calls.map(c => c.key.split('.').pop());
        check('展示已设置 → 不重复切换', !kindsB.includes('SwitchSceneDisplay'), kindsB);
        check('无库存 → 不升星', !kindsB.includes('UpgradeCollection'), kindsB);
        check('每次都会试领一次', kindsB.includes('ClaimCollectionReward'), kindsB);
        check('领奖结果带回服务端评分', b.claimed && b.claimed.totalScore === 1200, b.claimed);

        // 场景C: 背包里只有 1 个桃米 → 只升 1 次(库存耗尽就停)
        const { types } = require(`${SB}/src/utils/proto`);
        originalBagReply = types.BagReply.encode(types.BagReply.create({
            item_bag: { items: [{ id: 700005, count: 1 }] },
        })).finish();
        calls.length = 0;
        const c = await collection.runCollectionTasks({});
        const upgrades = calls.filter(x => x.key.endsWith('UpgradeCollection'));
        check('背包有 1 个桃米 → 只升 1 次', upgrades.length === 1, upgrades.length);
        check('升的是 700005 (080110e5dc2a)', upgrades[0] && upgrades[0].body.toString('hex') === '080110e5dc2a', upgrades.map(u => u.body.toString('hex')));
        originalBagReply = null;

        collectionReplyHex = null;
        bagOverride = null;
    }

    section('5c. 1047006 暂无可领取的奖励 → 视为正常(不报错/不刷错误日志)');
    {
        claimNoReward = true;
        const r = await collection.claimCollectionReward();
        check('不抛异常', r.ok === true, r);
        check('claimed = false', r.claimed === false, r);
        check('带明确原因', /没有|暂无/.test(r.reason || ''), r.reason);

        // 自动流程里也不应把它当失败
        collectionReplyHex = '0a280801120e08e5dc2a10011801209098bbd706120e08e4dc2a1001180120cb97bbd70628e80730b009120a08011206080110e5dc2a';
        calls.length = 0;
        const flow = await collection.runCollectionTasks({});
        check('流程仍然 ok', flow.ok === true, flow);
        check('claimed 为 null(没领到)', flow.claimed === null, flow.claimed);
        check('跳过原因里说明了没有可领', flow.skipped.some(x => /没有|暂无|档位/.test(x)), flow.skipped);
        claimNoReward = false;
        collectionReplyHex = null;
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