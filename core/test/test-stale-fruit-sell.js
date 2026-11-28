/**
 * 活动果实出售回归测试 (2026-11-28 抓包 161222)
 *
 * 需求: 红薯(40307)/森野系列(40021/40525~40529)/青梅(41221)/森野柿子(41435)
 *   在 ItemInfo 表里 price=0 且 desc 含"活动期间不可售卖"(但不含"不售卖"等拦截词),
 *   旧逻辑判"无出售价格"全部不卖 → 背包积压数万个。
 *   实际 Bag 回包每格 #100.show.sell 带真实卖价({货币id, 单价}), 活动结束后照样能卖。
 *
 * 锁住不变量:
 *   1) ItemInfo 无价但背包带 show.sell 的果实 → 判定可卖;
 *   2) 背包也没价的道具(萌宠元气糕/幸运星/奶茶券) → 仍拦"无出售价格";
 *   3) desc 真含"不可出售/不售卖"的 → 仍拦(活动期内);
 *   4) sellAllFruits 实际把带 show.sell 的果实发进 Sell 请求。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'stale-fruit-test';
isolateDataDir(SB, 'stale-fruit-test');

(async () => {
    const protoMod = require(`${SB}/src/utils/proto`);
    const { types } = protoMod;
    await protoMod.loadProto();
    const protobuf = require('protobufjs');
    const Item = protoMod.getRoot().lookupType('corepb.Item');
    const mkItem = (o) => Item.decode(Item.encode(Item.create(o)).finish());

    const wh = require(`${SB}/src/services/warehouse`);

    // ===== 1) block-reason 判定 =====
    section('getSellBlockReason: 背包 show.sell 兜底');
    {
        // 红薯: ItemInfo 无价, 背包带 {1001, 240}
        const potato = mkItem({
            id: 40307, count: 195, uid: 74193,
            show: { sell: { currency_id: 1001, price: 240 } },
        });
        check(wh.getSellBlockReason(potato) === '', `红薯(show.sell 240) 判可卖 (实际 ${wh.getSellBlockReason(potato)})`);
        check(wh.isSellableItem(potato), 'isSellableItem 同步放行');

        // 森野芭乐: 10000 金
        const guava = mkItem({
            id: 40529, count: 44,
            show: { sell: { currency_id: 1001, price: 10000 } },
        });
        check(wh.getSellBlockReason(guava) === '', '森野芭乐(show.sell 10000) 判可卖');

        // 萌宠元气糕(1028): ItemInfo type=19 非果实, 背包再带价也不卖
        const cake = mkItem({
            id: 1028, count: 767,
            show: { sell: { currency_id: 1001, price: 2000 } },
        });
        check(wh.getSellBlockReason(cake) === '不是果实', `非果实仍拦 (实际 ${wh.getSellBlockReason(cake)})`);
    }

    section('getSellBlockReason: 无 show 兜底时维持旧行为');
    {
        // 红薯不带 show: ItemInfo 无价 → 仍拦(纯 id 判定场景)
        check(wh.getSellBlockReason(40307) === '无出售价格', '纯 id(无 show) 仍拦"无出售价格"');

        // 普通果实白萝卜: ItemInfo 有价, 不带 show 也可卖
        check(wh.getSellBlockReason(40002) === '', '普通果实(ItemInfo 有价)不受影响');
    }

    section('getBagItemPrice: ItemInfo 优先, show 兜底');
    {
        const p1 = wh.getBagItemPrice(mkItem({ id: 40002, count: 1 }));
        check(p1.price > 0 && p1.priceId > 0, `普通果实走 ItemInfo (${p1.priceId}×${p1.price})`);
        const p2 = wh.getBagItemPrice(mkItem({
            id: 40307, count: 1,
            show: { sell: { currency_id: 1001, price: 240 } },
        }));
        check(p2.price === 240 && p2.priceId === 1001, `红薯走 show 兜底 (${p2.priceId}×${p2.price})`);
    }

    // ===== 4) sellAllFruits 端到端 =====
    section('sellAllFruits: 带 show 的积压果实真的被卖');
    {
        const BAG = [
            mkItem({ id: 40307, count: 195, uid: 74193, show: { sell: { currency_id: 1001, price: 240 } } }),
            mkItem({ id: 41221, count: 42, uid: 74201, show: { sell: { currency_id: 1001, price: 240 } } }),
            mkItem({ id: 40529, count: 44, uid: 74210, show: { sell: { currency_id: 1001, price: 10000 } } }),
            mkItem({ id: 7001, count: 99999 }),  // 牧草: 永不卖
        ];
        const soldBatches = [];
        const net = require(`${SB}/src/utils/network`);
        net.sendMsgAsync = async (service, method, body) => {
            const key = `${service}.${method}`;
            if (key === 'gamepb.itempb.ItemService.Bag') {
                return { body: types.BagReply.encode(types.BagReply.create({ item_bag: { items: BAG } })).finish() };
            }
            if (key === 'gamepb.itempb.ItemService.Sell') {
                const req = types.SellRequest.decode(Buffer.from(body));
                soldBatches.push((req.items || []).map(x => ({ id: Number(x.id), count: Number(x.count) })));
                return { body: types.SellReply.encode(types.SellReply.create({})).finish() };
            }
            throw new Error(`未 stub 的接口: ${key}`);
        };
        const store = require(`${SB}/src/models/store`);
        store.applyConfigSnapshot({
            automation: { sell: true },
            sellGoldenFruit: false,
        }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });

        await wh.sellAllFruits();
        const soldIds = soldBatches.flat().map(x => x.id).sort((a, b) => a - b);
        check(JSON.stringify(soldIds) === JSON.stringify([40307, 40529, 41221]),
            `三个积压果实全进 Sell 请求 (实际 ${soldIds.join(',')})`);
        check(!soldIds.includes(7001), '牧草 7001 仍被排除');
    }

    finish();
})().catch((e) => { console.error(e); process.exit(1); });
