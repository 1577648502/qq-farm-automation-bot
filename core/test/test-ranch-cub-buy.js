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

    section('6. 幼崽策略: 收益比 / 等级 / 优先列表');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const apply = ranch.__privateRanchFns.applyCubStrategy;
        // 候选: 鸡(收益比3.0, 低价) / 兔(2.0) / 龙猫(3.0, 高价)
        const cubs = [
            { goodsId: 10002, animalId: 60001, name: '鸡', price: 2, valueRatio: 3 },
            { goodsId: 10003, animalId: 60002, name: '兔', price: 1080, valueRatio: 2 },
            { goodsId: 10004, animalId: 60006, name: '龙猫', price: 6768, valueRatio: 3 },
        ];

        const byProfit = apply(cubs, { strategy: 'max_profit' });
        check('max_profit: 收益比最高的排前面',
            byProfit[0].valueRatio === 3, byProfit.map(c => c.name));

        const byLevel = apply(cubs, { strategy: 'max_level' });
        check('max_level: animalId 最大的排前面',
            byLevel[0].animalId === 60006, byLevel.map(c => c.name));

        // 优先列表: 兔排第一
        const byList = apply(cubs, { strategy: 'bag_priority', priority: [60002] });
        check('bag_priority: 列表里的排最前', byList[0].animalId === 60002, byList.map(c => c.name));

        // 优先列表为空 → 回退收益比
        const noList = apply(cubs, { strategy: 'bag_priority', priority: [] });
        check('bag_priority 无列表时回退收益比', noList[0].valueRatio === 3, noList.map(c => c.name));

        // 非法策略 → 回退默认
        const bad = apply(cubs, { strategy: 'not_a_strategy' });
        check('非法策略回退 max_profit', bad[0].valueRatio === 3, bad.map(c => c.name));

        // 不改原数组
        check('不修改传入的数组', cubs[0].name === '鸡', cubs.map(c => c.name));
    }

    section('7. 两种罐头: 普通(4)每只一次 / 有机(5,6)不限次数');
    {
        // 抓包 20261116-215723 实测: 请求序列 4 → 6 → 5 → 6 → 5
        // 4 只出现一次(普通罐头), 5/6 反复出现(有机罐头)
        const calls = installStub({
            FeedAnimal: () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish(),
        });
        const ranch = freshRanch();
        // 普通罐头
        await ranch.__privateRanchFns.feedAnimal(4, 1);
        // 有机罐头可以连着喂
        await ranch.__privateRanchFns.feedAnimal(5, 1);
        await ranch.__privateRanchFns.feedAnimal(6, 1);
        await ranch.__privateRanchFns.feedAnimal(5, 1);
        check('发了 4 次 FeedAnimal', calls.filter(c => c.method === 'FeedAnimal').length === 4,
            calls.map(c => c.method));
        // 校验 feed_type 原样透传(不擅自改写)
        const types2 = calls.filter(c => c.method === 'FeedAnimal').map(c => {
            const req = types.FeedAnimalRequest.decode(c.body);
            return Number(req.target.feed_type);
        });
        check('feed_type 依次为 4,5,6,5', JSON.stringify(types2) === JSON.stringify([4, 5, 6, 5]), types2);
    }

    section('8. 喂食失败给可读提示(区分两种罐头)');
    {
        const ranch = freshRanch();
        const { feedFailureHint } = ranch.__privateRanchFns;
        // 普通罐头失败 → 提示每只一次, 建议改用有机
        const normal = feedFailureHint(4, new Error('FeedAnimal 错误: code=1045234 罐头桶已用完'));
        check('普通罐头失败提示可用完后补充', /罐头桶已用完/.test(normal), normal);

        // 有机罐头失败 → 不该提"每只一次"
        const organic = feedFailureHint(5, new Error('FeedAnimal 错误: code=1045234 罐头桶已用完'));
        check('有机罐头失败不误导', !/每只动物只能用一次/.test(organic), organic);
    }

    section('9. 成熟判定只看 grown_flag(#18), 不看 stage(抓包实证)');
    {
        // 158 条 grown_flag=1 的样本里 stage 从 1 到 400 都有
        // → stage 不是生长阶段, 是实例序号之类的值, 完全不可靠
        const ranch = require(`${SB}/src/services/ranch`);
        const mk = (stage, grown) => ranch.toRanchView({
            ranch: { animals: [{ slot: 1, animal_id: 60001, stage, feed_state: 2, grown_flag: grown, produce_at: Date.now() + 3000 }] },
        }).animals[0].stageText;

        check('grown=1 + stage=3 → 成年(旧实现会误判成"成长中(3/6)")', mk(3, 1) === '成年', mk(3, 1));
        check('grown=1 + stage=1 → 成年', mk(1, 1) === '成年', mk(1, 1));
        check('grown=1 + stage=397 → 成年', mk(397, 1) === '成年', mk(397, 1));
        check('grown=undefined → 不是成年', mk(3, undefined) !== '成年', mk(3, undefined));
    }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
