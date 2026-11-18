/**
 * 牧场购买/入栏/倒计时 回归测试
 *
 * 线上事故(2026-11-18):
 *   用户发现"给我买了那么多只鸡"。查证:
 *   · buyGoods 的 auto_add **不会**把幼崽放进栏舍(只进背包)
 *   · 机器人以为买到=养上, slots 数字没变 → 每轮巡检再买 4 只
 *   · 实测背包堆了 1242 只鸡幼崽 / 1195 只成品鸡
 *   抓包证实客户端买完会调 AnimalService.PlaceAnimal 逐个入栏。
 *
 * 同时修了两个相关缺陷:
 *   · 手册(图鉴)领奖只在手动 API 里, 巡检从不调用
 *   · 倒计时用 "#10(上次产出) + 2 小时" 硬编码 —— 2 小时是**兔子**的间隔,
 *     鸡的间隔短得多, 导致鸡的成熟倒计时完全不对
 *
 * 这个测试锁住:
 *   1) 背包里已有足够幼崽时, 不再买(阻断无限购买)
 *   2) 单轮购买有硬上限
 *   3) 没有 #25(下次产出时刻)时不编造倒计时, 也不判"可收获"
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'ranch-cub-test';
isolateDataDir(SB, 'ranch-cub-test');

const proto = require(`${SB}/src/utils/proto`);
const network = require(`${SB}/src/utils/network`);
const { types } = require(`${SB}/src/utils/proto`);

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

function freshRanch() {
    for (const key of Object.keys(require.cache)) {
        if (/services\/(?:ranch|mall|warehouse|ranch-facility)\.js$/.test(key)) delete require.cache[key];
    }
    return require(`${SB}/src/services/ranch`);
}

const SHOP = 'gamepb.shoppb.ShopService';

function shopReply() {
    return types.ShopInfoReply.encode(types.ShopInfoReply.create({
        goods_list: [{ id: 10002, item_id: 60001, price: 2, price_id: 1007, limit_count: 0, bought_num: 0, unlocked: true }],
    })).finish();
}

/** 牧场背包: 指定数量的鸡幼崽(itemType 105) */
function ranchBagWithCubs(count) {
    // getRanchBagItems 返回 {id, count, uid}; itemType 由 getItemById 查配置得出
    return { items: count > 0 ? [{ id: 60001, count, uid: 1 }] : [] };
}

proto.loadProto().then(async () => {
    section('1. 背包里已有幼崽 → 不再买(阻断无限购买)');
    {
        const calls = installStub({
            [`${SHOP}.ShopInfo`]: () => shopReply(),
            [`${SHOP}.BuyGoods`]: () => { throw new Error('背包已有幼崽时不该再买'); },
        });
        const ranch = freshRanch();
        // 桩掉背包: 直接返回 100 只幼崽
        const warehouse = require(`${SB}/src/services/warehouse`);
        warehouse.getRanchBagItems = async () => ranchBagWithCubs(100).items;

        const r = await ranch.__privateRanchFns.autoBuyCubs({
            slots: 4,
            view: { coopCount: 4, penCount: 4, animals: [] },
        });
        check('没有发购买请求', calls.filter(c => c.method === 'BuyGoods').length === 0,
            calls.map(c => c.method));
        check('bought = 0', r.bought === 0, r.bought);
    }

    section('2. 背包没幼崽 → 正常买, 但有单轮上限');
    {
        const calls = installStub({
            [`${SHOP}.ShopInfo`]: () => shopReply(),
            [`${SHOP}.BuyGoods`]: () => types.BuyGoodsReply.encode(types.BuyGoodsReply.create({})).finish(),
        });
        const ranch = freshRanch();
        const warehouse = require(`${SB}/src/services/warehouse`);
        warehouse.getRanchBagItems = async () => [];
        warehouse.getBag = async () => ({ items: [] });

        // 给 40 个空槽 —— 单轮也不该买 40 只
        const r = await ranch.__privateRanchFns.autoBuyCubs({
            slots: 40,
            view: { coopCount: 40, penCount: 0, animals: [] },
        });
        check('买了但不超过单轮上限 4', r.bought > 0 && r.bought <= 4, r.bought);
        // 单轮只发一次购买请求(不是循环买 40 次)
        check('只发一次 BuyGoods', calls.filter(c => c.method === 'BuyGoods').length === 1,
            calls.filter(c => c.method === 'BuyGoods').length);
    }

    section('3. produce_at(#10) 就是"下次产出时刻"(5 份抓包实测确认)');
    {
        // 实测依据: 同一只鸡在三份不同时间的抓包里,
        //   #10 - 抓包时刻 = +2.6s / -51.0s / -2.6s  —— 都在秒级
        // 若 #10 是"上次产出"(几小时前), 差值会是几千秒。所以它就是下次产出时刻。
        const now = Date.now();
        const mk = (produceAt) => require(`${SB}/src/services/ranch`).toRanchView({
            ranch: {
                animals: [{
                    slot: 1, animal_id: 60001, stage: 6, feed_state: 2,
                    produce_at: produceAt, grown_flag: 1,
                }],
            },
        }).animals[0];

        // 未来 2.6 秒(与实测同量级) → 还没到点
        const soon = mk(now + 2600);
        check('未来 2.6 秒 → harvestInSec ≈ 3', Math.abs(soon.harvestInSec - 3) <= 2, soon.harvestInSec);
        check('未来 → 不可收', soon.harvestable === false, soon.harvestable);

        // 已过 5 秒 → 可收
        const passed = mk(now - 5000);
        check('已过 5 秒 → harvestInSec ≈ -5', Math.abs(passed.harvestInSec + 5) <= 2, passed.harvestInSec);
        check('已过 → 可收', passed.harvestable === true, passed.harvestable);
        check('canProduce 跟随 harvestable', passed.canProduce === true, passed.canProduce);
    }

    section('4. #10 缺失 → 不编倒计时, 也不判可收');
    {
        const view = require(`${SB}/src/services/ranch`).toRanchView({
            ranch: {
                animals: [{ slot: 1, animal_id: 60001, stage: 6, feed_state: 2, grown_flag: 1 }],
            },
        });
        const a = view.animals[0];
        check('无 #10 → harvestInSec = null', a.harvestInSec === null, a.harvestInSec);
        check('无 #10 → 不判可收', a.harvestable === false, a.harvestable);
    }

    section('5. 不再使用 #25(它在 5 份抓包里从未出现过)');
    {
        // 即使某天真下发了 #25, 也不该再影响倒计时 —— 语义已确定用 #10
        const now = Date.now();
        const view = require(`${SB}/src/services/ranch`).toRanchView({
            ranch: {
                animals: [{
                    slot: 1, animal_id: 60002, stage: 6, feed_state: 3,
                    produce_at: now + 30 * 1000,      // 30 秒后
                    trigger_ready_at: now + 999 * 1000, // 干扰项
                    grown_flag: 1,
                }],
            },
        });
        const a = view.animals[0];
        check('#25 被忽略, 只看 #10(约 30 秒)', Math.abs(a.harvestInSec - 30) <= 2, a.harvestInSec);
    }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
