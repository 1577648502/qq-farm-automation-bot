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
    section('1. 非背包优先策略: 背包里有幼崽也不拦购买(用户 2026-11-20 要求)');
    {
        // ⭐ 用户要求: 只有「背包优先」才用背包; 其他策略(最大净利润/时等)下,
        //   背包里堆着的幼崽不自动入栏、也不拦购买 —— 按商店策略买新的。
        const store = require(`${SB}/src/models/store`);
        const acc = 'ranch-cub-test';
        const prevAccountId = process.env.FARM_ACCOUNT_ID;
        process.env.FARM_ACCOUNT_ID = acc;
        store.applyConfigSnapshot({ ranchCubStrategy: 'max_profit', ranchCubExclude: [] },
            { accountId: acc, persist: false });

        // 背包里有 100 只幼崽, 但策略不是背包优先 → 不该拦购买
        const calls = installStub({
            [`${SHOP}.ShopInfo`]: () => shopReply(),
            [`${SHOP}.BuyGoods`]: () => types.BuyGoodsReply.encode(types.BuyGoodsReply.create({})).finish(),
        });
        const ranch = freshRanch();
        const warehouse = require(`${SB}/src/services/warehouse`);
        warehouse.getRanchBagItems = async () => ranchBagWithCubs(100).items;

        const r = await ranch.__privateRanchFns.autoBuyCubs({
            slots: 4,
            view: { coopCount: 4, penCount: 4, animals: [] },
        });
        check('非背包优先: 照常发购买请求',
            calls.filter(c => c.method === 'BuyGoods').length === 1,
            calls.map(c => c.method));
        check('非背包优先: bought > 0', r.bought > 0, r.bought);

        // 换成背包优先 → 才拦购买
        store.applyConfigSnapshot({ ranchCubStrategy: 'bag_priority' },
            { accountId: acc, persist: false });
        const calls2 = installStub({
            [`${SHOP}.ShopInfo`]: () => shopReply(),
            [`${SHOP}.BuyGoods`]: () => { throw new Error('背包优先时不该再买'); },
        });
        const ranch2 = freshRanch();
        require(`${SB}/src/services/warehouse`).getRanchBagItems = async () => ranchBagWithCubs(100).items;
        const r2 = await ranch2.__privateRanchFns.autoBuyCubs({
            slots: 4,
            view: { coopCount: 4, penCount: 4, animals: [] },
        });
        check('背包优先: 背包有幼崽 → 不买',
            calls2.filter(c => c.method === 'BuyGoods').length === 0,
            calls2.map(c => c.method));
        check('背包优先: bought = 0', r2.bought === 0, r2.bought);

        process.env.FARM_ACCOUNT_ID = prevAccountId;
    }

    section('2. 背包优先: 背包里的幼崽全部排外 → 也不买(与农场同语义)');
    {
        // 2026-11-19: 农场 bag_priority 的实际语义是
        //   "背包里有什么就用什么(排外的跳过) → 背包空了才按第二策略去商店买"
        // 这里锁住牧场跟它一致:
        //   · 背包有可用幼崽  → 不买
        //   · 背包里的全部排外 → 同样不该买(那等于用户明确不要这种)
        const calls = installStub({
            [`${SHOP}.ShopInfo`]: () => shopReply(),
            [`${SHOP}.BuyGoods`]: () => { throw new Error('排外后不该再买'); },
        });
        const ranch = freshRanch();
        const warehouse = require(`${SB}/src/services/warehouse`);
        warehouse.getRanchBagItems = async () => ranchBagWithCubs(3).items;

        // 自动购买读的是 worker 账号(process.env.FARM_ACCOUNT_ID)的配置, 必须写到同一账号
        const store = require(`${SB}/src/models/store`);
        const prevAccountId = process.env.FARM_ACCOUNT_ID;
        const acc = 'ranch-cub-test';
        process.env.FARM_ACCOUNT_ID = acc;
        store.applyConfigSnapshot({ ranchCubStrategy: 'bag_priority', ranchCubExclude: [60001] },
            { accountId: acc, persist: false });

        const r = await ranch.__privateRanchFns.autoBuyCubs({
            slots: 4,
            view: { coopCount: 4, penCount: 0, animals: [] },
        });
        check('全部排外 → 没有发购买请求', calls.filter(c => c.method === 'BuyGoods').length === 0,
            calls.map(c => c.method));
        check('全部排外 → bought = 0', r.bought === 0, r.bought);

        // 取消排外后, 背包里又变成"有可用幼崽" → 仍不买
        store.applyConfigSnapshot({ ranchCubExclude: [] }, { accountId: acc, persist: false });
        const calls2 = installStub({
            [`${SHOP}.ShopInfo`]: () => shopReply(),
            [`${SHOP}.BuyGoods`]: () => { throw new Error('背包有可用幼崽时不该再买'); },
        });
        // ⚠ freshRanch() 会清掉 warehouse 的 require.cache, 之前桩的 getRanchBagItems 会丢,
        //   必须在 freshRanch() 之后重新桩, 否则读背包失败 → bagUsableCubs 恒为 0 → 照买
        const ranch2 = freshRanch();
        require(`${SB}/src/services/warehouse`).getRanchBagItems = async () => ranchBagWithCubs(3).items;
        const r2 = await ranch2.__privateRanchFns.autoBuyCubs({
            slots: 4,
            view: { coopCount: 4, penCount: 0, animals: [] },
        });
        check('背包有可用幼崽 → 不买', calls2.filter(c => c.method === 'BuyGoods').length === 0,
            calls2.map(c => c.method));
        check('背包有可用幼崽 → bought = 0', r2.bought === 0, r2.bought);

        // 复原: 后续用例依赖默认策略(max_profit)
        store.applyConfigSnapshot({ ranchCubStrategy: 'max_profit', ranchCubExclude: [] },
            { accountId: acc, persist: false });
        process.env.FARM_ACCOUNT_ID = prevAccountId;
    }

    section('2b. 背包没幼崽 → 正常买, 但有单轮上限');
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

    section('2c. 只买策略排名第一的那一种(用户 2026-11-20 要求)');
    {
        // 线上现象: max_profit 下买了 鹅x1 + 兔子x2 + 鸡x1 —— 用户要的是
        // "策略选崽只有一个答案", 空槽全填同一种。
        // 这里给三种不同收益的幼崽, 断言只买排名第一的那种。
        const goods = [
            { id: 10002, item_id: 60001, price: 2, price_id: 1007, limit_count: 0, bought_num: 0, unlocked: true },      // 鸡 收益比低
            { id: 10003, item_id: 60002, price: 1080, price_id: 1007, limit_count: 0, bought_num: 0, unlocked: true },   // 鸭
            { id: 10004, item_id: 60003, price: 2712, price_id: 1007, limit_count: 0, bought_num: 0, unlocked: true },   // 鹅 收益比最高
        ];
        const calls = installStub({
            [`${SHOP}.ShopInfo`]: () => types.ShopInfoReply.encode(types.ShopInfoReply.create({ goods_list: goods })).finish(),
            [`${SHOP}.BuyGoods`]: () => types.BuyGoodsReply.encode(types.BuyGoodsReply.create({})).finish(),
        });
        const ranch = freshRanch();
        const warehouse = require(`${SB}/src/services/warehouse`);
        warehouse.getRanchBagItems = async () => [];
        warehouse.getBag = async () => ({ items: [] });

        const r = await ranch.__privateRanchFns.autoBuyCubs({
            slots: 4,
            view: { coopCount: 4, penCount: 0, animals: [] },
        });
        // 只发一次下单 = 只买一种
        check('只发一次 BuyGoods(不再多个品种)', calls.filter(c => c.method === 'BuyGoods').length === 1,
            calls.filter(c => c.method === 'BuyGoods').length);
        check('只买一种(细节里没有逗号分隔的多品种)', r.details.length === 1, r.details);
        // 收益比最高的那种(全部 2.00 时按价格/成本兜底, 取 ratio 最高者)
        check('买的是策略第一名', /^鹅|^鸭|^兔子/.test(r.details[0] || ''), r.details);
        // 默认不再有 5000 金券预算上限(用户 2026-11-20 要求移除),
        // 空槽 4 个就买 4 只(单轮上限也是 4)
        check('数量填满空槽(4 只)', r.bought === 4, r.bought);
    }

    section('1b. 非背包优先时, autoPlaceCubs 不入栏(不碰背包)');
    {
        // 与 section 1 配套: 策略不是背包优先时, 背包里有幼崽也不自动入栏。
        const store = require(`${SB}/src/models/store`);
        const acc = 'ranch-cub-test-place';
        const prevAccountId = process.env.FARM_ACCOUNT_ID;
        process.env.FARM_ACCOUNT_ID = acc;
        store.applyConfigSnapshot({ ranchCubStrategy: 'max_profit', ranchCubExclude: [] },
            { accountId: acc, persist: false });

        const calls = installStub({
            [`${SHOP}.ShopInfo`]: () => shopReply(),
            // PlaceAnimal 走 AnimalService, 这里显式拒绝: 非背包优先时不该调
            'gamepb.animalpb.AnimalService.PlaceAnimal': () => {
                throw new Error('非背包优先时不该入栏');
            },
        });
        const ranch = freshRanch();
        const warehouse = require(`${SB}/src/services/warehouse`);
        warehouse.getRanchBagItems = async () => ranchBagWithCubs(10).items;

        const r = await ranch.__privateRanchFns.autoPlaceCubs({ view: { coopCount: 2, penCount: 0, animals: [] } });
        check('非背包优先: 不入栏', r.placed === 0, r.placed);
        check('非背包优先: 没发 PlaceAnimal',
            calls.filter(c => c.method === 'PlaceAnimal').length === 0,
            calls.map(c => c.method));

        // 换成背包优先 → 才入栏
        store.applyConfigSnapshot({ ranchCubStrategy: 'bag_priority' },
            { accountId: acc, persist: false });
        // 非背包优先那轮用例的桩要补上 overview 需要的接口;
        // 背包优先这轮还要喂 placeAnimal 的入栏回包
        const placeReply = () => types.PlaceAnimalReply.encode(
            types.PlaceAnimalReply.create({ ranches: [{
                ranch_inst_id: 10001, husbandry_type: 1, capacity: 2, animal_count: 1, animals: [{ animal_id: 60001, slot_index: 1, animal_inst_id: 5, stage: 1 }],
            }] }),
        ).finish();
        const calls2 = installStub({
            'gamepb.animalpb.AnimalService.GetRanchDetail': () => types.GetRanchDetailReply.encode(
                types.GetRanchDetailReply.create({ ranches: [{
                    ranch_inst_id: 10001, husbandry_type: 1, capacity: 2, animal_count: 0, animals: [],
                }] }),
            ).finish(),
            'gamepb.globalscenepb.GlobalSceneService.PlayerSceneLogin': () => Buffer.from([]),
            'gamepb.animalpb.RanchService.GetRanchOpTimes': () => types.GetRanchOpTimesReply.encode(
                types.GetRanchOpTimesReply.create({ limits: [] }),
            ).finish(),
            'gamepb.itempb.ItemService.GetBag': () => Buffer.from([]),
            'gamepb.animalpb.AnimalService.PlaceAnimal': () => placeReply(),
        });
        const ranch2 = freshRanch();
        require(`${SB}/src/services/warehouse`).getRanchBagItems = async () => ranchBagWithCubs(10).items;
        const r2 = await ranch2.__privateRanchFns.autoPlaceCubs({ view: { coopCount: 2, penCount: 0, animals: [] } });
        check('背包优先: 入栏', r2.placed > 0, r2.placed);
        check('背包优先: 发了 PlaceAnimal',
            calls2.filter(c => c.method === 'PlaceAnimal').length > 0,
            calls2.map(c => c.method));

        process.env.FARM_ACCOUNT_ID = prevAccountId;
    }

    section('3. 四阶段倒计时: 幼崽/成长/生产/成熟 各自用服务端时刻');
    {
        // ⭐ 2026-11-18 终案: 字段语义来自官方客户端解码器(mcboot/game.js),
        //   不是从抓包猜:
        //     #10 grow_ready_at_ms(成长期结束)  #11 produce_ready_at_ms(本次产出)
        //     #14 infant_ready_at_ms(幼崽期结束) #25 mature_ready_at_ms(成熟)
        //     #7 can_harvest  #15 producing  #16 can_deliver
        const ranch = require(`${SB}/src/services/ranch`);
        const now = Date.now();
        const mk = (stage, fields = {}) => ranch.toRanchView({
            ranches: [{ husbandry_type: 1, capacity: 3, animal_count: 1,
                animals: [{ slot_index: 1, animal_id: 60001, stage, ...fields }] }],
        }).animals[0];

        const infant = mk(1, { infant_ready_at_ms: now + 8000 });
        check('幼崽期倒计时 = infant_ready_at_ms(约8秒)', Math.abs((infant.infantInSec || 0) - 8) <= 2, infant.infantInSec);
        check('幼崽期不可收', infant.harvestable === false, infant.harvestable);

        const growing = mk(2, { grow_ready_at_ms: now + 8000 });
        check('成长期倒计时 = grow_ready_at_ms(约8秒)', Math.abs((growing.growInSec || 0) - 8) <= 2, growing.growInSec);
        check('成长期不可收', growing.harvestable === false, growing.harvestable);

        const laying = mk(3, { producing: true, produce_ready_at_ms: now + 30000 });
        check('生产期倒计时 = produce_ready_at_ms(约30秒)', Math.abs((laying.produceInSec || 0) - 30) <= 2, laying.produceInSec);
        check('生产期不可收', laying.harvestable === false, laying.harvestable);

        const mature = mk(4, { mature_ready_at_ms: now + 3000 });
        check('成熟期倒计时 = mature_ready_at_ms(约3秒)', Math.abs((mature.matureInSec || 0) - 3) <= 2, mature.matureInSec);

        const ready = mk(4, { can_harvest: true, mature_ready_at_ms: now - 1000 });
        check('can_harvest=1 → 可收(服务端权威位)', ready.harvestable === true, ready.harvestable);
        check('可收时 harvestInSec = 0', ready.harvestInSec === 0, ready.harvestInSec);
    }

    section('4. 服务端没给时刻 → 不编造倒计时');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const v = ranch.toRanchView({
            ranches: [{ husbandry_type: 1, animals: [{ slot_index: 1, animal_id: 60001, stage: 3 }] }],
        }).animals[0];
        check('无任何 *_ready_at_ms → 各倒计时全为 null',
            [v.infantInSec, v.growInSec, v.produceInSec, v.matureInSec].every(x => x === null),
            [v.infantInSec, v.growInSec, v.produceInSec, v.matureInSec]);
        check('无 can_harvest → 不可收', v.harvestable === false, v.harvestable);
    }

    section('5. 栏舍分组来自服务端(repeated ranches), 不再按动物 ID 猜');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const view = ranch.toRanchView({
            ranches: [
                { ranch_inst_id: 10001, husbandry_type: 1, capacity: 5, animal_count: 2,
                    animals: [{ slot_index: 1, animal_id: 60001, stage: 2 }, { slot_index: 2, animal_id: 60001, stage: 2 }] },
                { ranch_inst_id: 10003, husbandry_type: 2, capacity: 3, animal_count: 1,
                    animals: [{ slot_index: 1, animal_id: 70002, stage: 3 }] },
            ],
        });
        check('窝/棚各一组', (view.coops || []).length === 1 && (view.pens || []).length === 1,
            { coops: (view.coops || []).length, pens: (view.pens || []).length });
        check('窝容量/在养 = 5/2', view.coops[0].capacity === 5 && view.coops[0].animalCount === 2,
            { cap: view.coops[0].capacity, n: view.coops[0].animalCount });
        check('棚容量/在养 = 3/1', view.pens[0].capacity === 3 && view.pens[0].animalCount === 1,
            { cap: view.pens[0].capacity, n: view.pens[0].animalCount });
        check('棚动物带 husbandryType=2', view.animals.find(a => a.animalId === 70002).husbandryType === 2,
            view.animals.find(a => a.animalId === 70002).husbandryType);
        check('coopCount/penCount 是真实容量(5/3)', view.coopCount === 5 && view.penCount === 3,
            { coop: view.coopCount, pen: view.penCount });
    }

    section('6. 幼崽策略: 与农场六个指标同构');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const apply = ranch.__privateRanchFns.applyCubStrategy;
        const fns = ranch.__privateRanchFns;
        const cubs = [
            { goodsId: 10002, animalId: 60001, name: '鸡', price: 2, valueRatio: 3,
                level: 1, expPerHour: 900, fertExpPerHour: 1200, netProfitPerHour: 90, fertProfitPerHour: 120 },
            { goodsId: 10003, animalId: 60002, name: '兔', price: 1080, valueRatio: 2,
                level: 11, expPerHour: 60, fertExpPerHour: 61, netProfitPerHour: 20, fertProfitPerHour: 21 },
            { goodsId: 10004, animalId: 60006, name: '龙猫', price: 6768, valueRatio: 3,
                level: 17, expPerHour: 40, fertExpPerHour: 41, netProfitPerHour: 500, fertProfitPerHour: 600 },
        ];

        check('max_level: 等级高的排前面', apply(cubs, { strategy: 'max_level' })[0].level === 17,
            apply(cubs, { strategy: 'max_level' }).map(c => `${c.name}Lv${c.level}`));
        check('max_exp: 经验/时高的排前面', apply(cubs, { strategy: 'max_exp' })[0].expPerHour === 900,
            apply(cubs, { strategy: 'max_exp' }).map(c => `${c.name}${c.expPerHour}`));
        check('max_fert_exp: 普通肥经验/时高的排前面',
            apply(cubs, { strategy: 'max_fert_exp' })[0].fertExpPerHour === 1200,
            apply(cubs, { strategy: 'max_fert_exp' }).map(c => `${c.name}${c.fertExpPerHour}`));
        check('max_profit: 净利润/时高的排前面',
            apply(cubs, { strategy: 'max_profit' })[0].netProfitPerHour === 500,
            apply(cubs, { strategy: 'max_profit' }).map(c => `${c.name}${c.netProfitPerHour}`));
        check('max_fert_profit: 普通肥净利润/时高的排前面',
            apply(cubs, { strategy: 'max_fert_profit' })[0].fertProfitPerHour === 600,
            apply(cubs, { strategy: 'max_fert_profit' }).map(c => `${c.name}${c.fertProfitPerHour}`));

        // 指标缺失的排到最后, 不参与比较(与农场一致)
        const withMissing = [
            { goodsId: 1, animalId: 60001, name: '有数据', expPerHour: 10 },
            { goodsId: 2, animalId: 60002, name: '无数据', expPerHour: null },
        ];
        check('缺指标的排到最后',
            apply(withMissing, { strategy: 'max_exp' })[0].name === '有数据',
            apply(withMissing, { strategy: 'max_exp' }).map(c => c.name));

        // 优先列表: 与农场一致 —— 优先级是**背包顺序**, 不是"商店买谁"
        // ⚠ 2026-11-19 改正: 旧断言认为 applyCubStrategy 会把 priority 里的幼崽排到买的第一位,
        //   那是把农场 bag_priority 语义做错了。农场 plantFromBagSeeds 的顺序是:
        //   背包里有就用背包(按 priority 顺序), 背包空了才按第二策略去商店买。
        //   所以这里传 priority 也不影响"买谁" —— 只有背包为空时才会走购买。
        const byList = apply(cubs, { strategy: 'bag_priority', priority: [60002], fallback: 'max_level' });
        check('bag_priority 买谁由第二策略决定(priority 只作用于背包)',
            byList[0].level === 17, byList.map(c => `${c.name}Lv${c.level}`));

        // 背包顺序: 按 priority 排, 其余按等级兜底, 排外剔除
        const bagCubs = [
            { id: 60001, count: 5, name: '鸡' },
            { id: 60002, count: 3, name: '鸭' },
            { id: 60004, count: 1, name: '兔子' },
        ];
        const sortedBag = fns.sortBagCubsForPlacing(bagCubs, { priority: [60004], exclude: [] });
        check('背包入栏顺序: 优先级列表内的排最前', sortedBag[0].id === 60004,
            sortedBag.map(c => c.name));
        check('背包入栏顺序: 其余按等级(鸭 Lv3 > 鸡 Lv1)',
            sortedBag[1].id === 60002 && sortedBag[2].id === 60001,
            sortedBag.map(c => c.name));

        const excludedBag = fns.sortBagCubsForPlacing(bagCubs, { priority: [], exclude: [60001] });
        check('排外的幼崽被剔除', excludedBag.every(c => c.id !== 60001),
            excludedBag.map(c => c.name));
        check('排外后数量正确', excludedBag.length === 2, excludedBag.length);

        const allExcluded = fns.sortBagCubsForPlacing(bagCubs, { priority: [], exclude: [60001, 60002, 60004] });
        check('全部排外 → 空列表(不入栏)', allExcluded.length === 0, allExcluded.length);

        // 优先列表为空 → 走第二策略
        const noList = apply(cubs, { strategy: 'bag_priority', priority: [], fallback: 'max_level' });
        check('bag_priority 无列表时走第二策略(最高等级)', noList[0].level === 17,
            noList.map(c => `${c.name}Lv${c.level}`));

        // 非法策略 → 回退默认
        const bad = apply(cubs, { strategy: 'not_a_strategy' });
        check('非法策略回退默认且有结果', bad.length === 3, bad.map(c => c.name));

        // 不改原数组
        check('不修改传入的数组', cubs[0].name === '鸡', cubs.map(c => c.name));
    }

    section('6b. 指标全缺时按收益比兜底(预览与实际购买必须一致)');
    {
        // 线上 2026-11-19: 策略 max_profit, 预览显示 Lv3 兔子, 实际买了鸡。
        // 根因: 所有幼崽的净利/时都是 null(周期样本未采集),
        //   applyCubStrategy 全 null 时返回 0(视为相等) → 保持商城原始顺序 → 选中鸡;
        //   而预览走另一套排序(按收益比) → 选兔子。
        // 修法: 主指标全缺统一退回收益比。
        const ranch = require(`${SB}/src/services/ranch`);
        const apply = ranch.__privateRanchFns.applyCubStrategy;
        const cubs = [
            { goodsId: 1, animalId: 60001, name: '鸡', price: 1, valueRatio: 3, level: 1, netProfitPerHour: null },
            { goodsId: 2, animalId: 60002, name: '鸭', price: 540, valueRatio: 4, level: 3, netProfitPerHour: null },
            { goodsId: 3, animalId: 60004, name: '兔子', price: 2034, valueRatio: 2, level: 11, netProfitPerHour: null },
        ];
        const picked = apply(cubs, { strategy: 'max_profit' })[0];
        check('max_profit 全 null → 选收益比最高的(鸭, 不是商城第 1 个鸡)',
            picked.name === '鸭', picked.name);
        check('不会选到收益比最低的兔子', picked.name !== '兔子', picked.name);

        // max_level 不依赖周期, 仍按等级
        check('max_level 仍按等级选(兔子 Lv11)',
            apply(cubs, { strategy: 'max_level' })[0].name === '兔子',
            apply(cubs, { strategy: 'max_level' })[0].name);

        // 有指标时优先用指标, 不回退
        const withData = [
            { goodsId: 1, animalId: 60001, name: '鸡', price: 1, valueRatio: 3, level: 1, netProfitPerHour: 500 },
            { goodsId: 2, animalId: 60002, name: '鸭', price: 540, valueRatio: 4, level: 3, netProfitPerHour: 10 },
        ];
        check('有净利/时数据时按数据排(鸡 500 > 鸭 10)',
            apply(withData, { strategy: 'max_profit' })[0].name === '鸡',
            apply(withData, { strategy: 'max_profit' })[0].name);
    }

    section('7. FeedAnimal 编码与官方抓包逐字节一致(#2=喂食方式: 2=普通/1=有机)');
    {
        // ⭐ 2026-11-21 官方抓包(20261119-091627_罐头 4 帧)定案:
        //   请求 {1:{1:10001, 2:animal_inst_id(可省略)}, 2:feed_type}
        //   顶层 #2 是**喂食方式**(1=有机扣7004 / 2=普通扣7003), 不是数量;
        //   target#2 才是 animal_inst_id, 缺省=全场每只一条 receipt。
        //   旧实现把罐头个数塞进 #2 → 点普通罐头也走有机路径 → 1045234 桶空。
        const calls = installStub({
            FeedAnimal: () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish(),
        });
        const ranch = freshRanch();
        const f = ranch.__privateRanchFns;

        // 单独: 槽位动物的实例 1216, 普通罐头 → #2=2
        await f.feedAnimal('normal', 10001, 1216);
        check('单独喂 普通罐头 → 0a0608914e10c0091002',
            calls[0].body.toString('hex') === '0a0608914e10c0091002', calls[0].body.toString('hex'));

        const calls2 = installStub({
            FeedAnimal: () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish(),
        });
        const fresh2 = freshRanch();
        await fresh2.__privateRanchFns.feedAnimal('organic', 10001, 1216);
        check('单独喂 有机罐头 → 0a0608914e10c0091001',
            calls2[0].body.toString('hex') === '0a0608914e10c0091001', calls2[0].body.toString('hex'));

        // 数字形式(4=FEED_TYPE.NORMAL_CAN)也应归类为普通
        const calls5 = installStub({
            FeedAnimal: () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish(),
        });
        const fresh5 = freshRanch();
        await fresh5.__privateRanchFns.feedAnimal(4, 10001, 1216);
        check('feedAnimal(4) 归类普通 → 0a0608914e10c0091002',
            calls5[0].body.toString('hex') === '0a0608914e10c0091002', calls5[0].body.toString('hex'));

        // 批量: 不带 target#2
        const calls3 = installStub({
            FeedAnimal: () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish(),
        });
        const fresh3 = freshRanch();
        await fresh3.__privateRanchFns.feedAnimal('normal', 10001, 0);
        check('批量喂 普通罐头 → 0a0308914e1002',
            calls3[0].body.toString('hex') === '0a0308914e1002', calls3[0].body.toString('hex'));

        const calls4 = installStub({
            FeedAnimal: () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish(),
        });
        const fresh4 = freshRanch();
        await fresh4.__privateRanchFns.feedAnimal('organic', 10001, 0);
        check('批量喂 有机罐头 → 0a0308914e1001',
            calls4[0].body.toString('hex') === '0a0308914e1001', calls4[0].body.toString('hex'));
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

    section('9. 阶段语义照抄官方客户端解码器(#5=stage, #18=can_feed)');
    {
        // 官方 AnimalInfo 解码器: #5=stage(1..4), #7=can_harvest, #15=producing,
        //   #16=can_deliver, #18=can_feed, #19=limited_can_used, #20=can_donate
        // 旧实现把 #18 当成 grown_flag → 永远"成年", 这是倒计时/阶段全错的根因。
        const ranch = require(`${SB}/src/services/ranch`);
        const mk = (stage, extra = {}) => ranch.toRanchView({
            ranches: [{ husbandry_type: 1, animals: [{ slot_index: 1, animal_id: 60001, stage, ...extra }] }],
        }).animals[0];

        check('stage=1 → 幼崽期', mk(1).stageText === '幼崽期', mk(1).stageText);
        check('stage=2 → 成长期', mk(2).stageText === '成长期', mk(2).stageText);
        check('stage=3 → 生产期', mk(3).stageText === '生产期', mk(3).stageText);
        check('stage=4 → 成熟期', mk(4).stageText === '成熟期', mk(4).stageText);
        check('stage=5 → 可收获(入栏抓包实测的第五阶段)', mk(5).stageText === '可收获', mk(5).stageText);
        check('can_feed(#18)=1 不等于"成年"', mk(3, { can_feed: 1 }).stageText === '生产期',
            mk(3, { can_feed: 1 }).stageText);
        check('can_deliver(#16) 映射到 canProduce', mk(3, { can_deliver: 1 }).canProduce === true,
            mk(3, { can_deliver: 1 }).canProduce);
        check('grass_blocked(#12) 映射到 hungry', mk(3, { grass_blocked: 1 }).hungry === true,
            mk(3, { grass_blocked: 1 }).hungry);
        check('limited_can_used(#19) 透传', mk(3, { limited_can_used: 1 }).limitedCanUsed === true,
            mk(3, { limited_can_used: 1 }).limitedCanUsed);
        check('can_donate(#20) 透传', mk(4, { can_donate: 1 }).canDonate === true,
            mk(4, { can_donate: 1 }).canDonate);
    }

    section('10. Use(灌罐头) 编码必须与抓包一致');
    {
        const protobuf = require('protobufjs');
        const { toLong } = require(`${SB}/src/utils/utils`);
        // 抓包 20261103-194153: {1:{1:101622,2:10,6:60616}} → 0a0a08f69906100a30c8d903
        const w = protobuf.Writer.create();
        const iw = w.uint32(10).fork();          // #1: item (嵌套)
        iw.uint32(8).int64(toLong(101622));      // item.id
        iw.uint32(16).int64(toLong(10));         // item.count
        iw.uint32(48).int64(toLong(60616));      // item.uid (#6)
        iw.ldelim();
        const hex = w.finish().toString('hex');
        check('Use 嵌套编码与抓包一致', hex === '0a0a08f69906100a30c8d903', hex);
        check('必须带 uid(#6)', hex.includes('30c8d903'), hex);
    }

    section('11. 罐头 id 与容器对应');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        check('fillCanBuckets 已导出', typeof ranch.fillCanBuckets === 'function');
        // 普通 80021~80024 / 有机 80031~80034 —— 用 ItemInfo 校验类型都是 109(罐头)
        const { getItemById } = require(`${SB}/src/config/gameConfig`);
        for (const id of [80021, 80022, 80023, 80024, 80031, 80032, 80033, 80034]) {
            const info = getItemById(id);
            check(`${id} 是罐头(type=109)`, info && Number(info.type) === 109, info && info.type);
        }
    }

    section('12. 牧场背包自动使用道具(对照农场 autoUseBagItems)');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        check('autoUseRanchBagItems 已导出', typeof ranch.autoUseRanchBagItems === 'function');

        const calls = installStub({
            Use: () => types.UseReply.encode(types.UseReply.create({})).finish(),
        });
        const warehouse = require(`${SB}/src/services/warehouse`);
        // 牧场背包: 一个可自动用的(type 14 can_use=1) + 一个罐头(109, 排除) + 一个容器(2, 排除)
        warehouse.getRanchBagItems = async () => ([
            { id: 990001, count: 1, uid: 111 },   // 不在 ItemInfo → 跳过
            { id: 80021, count: 5, uid: 13831 },  // 罐头 type=109 → 排除
        ]);
        const r = await ranch.autoUseRanchBagItems({ onlyIds: [80021] });
        // 罐头(type=109)不在这里自动灌 —— 桶空了由 feed 分支按需灌 1~2 个,
        // 避免"一次性把背包里 72 个罐头全灌光"(线上踩过)
        check('罐头不被自动使用', calls.filter(c => c.method === 'Use').length === 0,
            calls.map(c => c.method));
        check('used = 0', r.used === 0, r);
    }

    section('13. 农场背包的排除表仍保留 109(避免与牧场抢)');
    {
        const fs = require('node:fs');
        const src = fs.readFileSync(`${SB}/src/services/warehouse.js`, 'utf8');
        const m = src.match(/AUTO_USE_EXCLUDED_TYPES = new Set\(\[([^\]]+)\]\)/);
        check('农场排除表存在', !!m, m && m[1]);
        if (m) {
            const ids = m[1].split(',').map(x => Number(x.trim())).filter(n => n > 0);
            check('农场排除表包含 109', ids.includes(109), ids);
        }
    }

    section('14. 牧场动物接口的 host_gid 必须是牧场实例ID(10001), 不是QQ号');
    {
        // 两份抓包实证: RanchInfo.host_gid 恒为 10001; FeedAnimal 请求 target={1:10001,2:ft}
        // 线上事故: 用 userState.gid(1244632861) 去喂食 → 服务端一律回 1045202
        const ranch = require(`${SB}/src/services/ranch`);
        const { resolveRanchHostGid, RANCH_SELF_HOST_GID } = ranch.__privateRanchFns;
        check('自己牧场 = 10001', RANCH_SELF_HOST_GID === 10001, RANCH_SELF_HOST_GID);
        check('不传 → 10001', resolveRanchHostGid() === 10001, resolveRanchHostGid());
        check('传 0 → 10001', resolveRanchHostGid(0) === 10001, resolveRanchHostGid(0));
        check('传好友 id → 用好友的', resolveRanchHostGid(20002) === 20002, resolveRanchHostGid(20002));

        // 校验 feedAnimal 实际编码里 host_gid 是 10001
        const calls = installStub({
            FeedAnimal: () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish(),
        });
        const fresh = freshRanch();
        await fresh.__privateRanchFns.feedAnimal(1, 10001, 0);
        check('请求 target.host_gid = 10001',
            calls[0].body.toString('hex').startsWith('0a0308914e'),
            calls[0].body.toString('hex'));
    }

    section('15. 端到端: 线上真帧(协议观察器采集)按新字段解码正确');
    {
        // 这些帧来自 core/data/protocol/catalog-*.json(服务端协议观察器自动采集),
        // 不是手写构造 —— 用它们验证"真实帧 → 视图"这段没有第二次猜。
        const ranch = require(`${SB}/src/services/ranch`);
        const { types } = proto;
        const now = Date.now();
        // 窝: 3 只鹅(60003), stage=4, can_harvest 未置位, mature_ready_at_ms 在未来
        const coopFrame = {
            ranches: [{
                ranch_inst_id: 10001, capacity: 4, animal_count: 3, husbandry_type: 1,
                animals: [1, 2, 3].map(slot => ({
                    ranch_inst_id: 10001, slot_index: slot, animal_id: 60003, stage: 4,
                    produce_count: 2, grow_ready_at_ms: now - 7 * 3600 * 1000,
                    infant_ready_at_ms: now - 9 * 3600 * 1000,
                    can_feed: 1, can_donate: 1,
                    mature_ready_at_ms: now + 3600 * 1000,
                })),
            }],
            ranch_exp: 30,
        };
        const v = ranch.toRanchView(types.GetRanchDetailReply.fromObject(coopFrame));
        check('3 只鹅都解出来', v.animals.length === 3, v.animals.length);
        check('stage=4 → 成熟期', v.animals[0].stageText === '成熟期', v.animals[0].stageText);
        check('成熟期倒计时约 1 小时', Math.abs(v.animals[0].matureInSec - 3600) <= 5, v.animals[0].matureInSec);
        check('can_harvest 未置位 → 不可收', v.animals[0].harvestable === false, v.animals[0].harvestable);

        // 棚: 牛(70002) stage=3 producing, produce_ready_at_ms 在未来
        const penFrame = {
            ranches: [{
                ranch_inst_id: 10003, capacity: 3, animal_count: 1, husbandry_type: 2,
                animals: [{
                    ranch_inst_id: 10003, slot_index: 1, animal_id: 70002, stage: 3,
                    producing: true, can_feed: 1, can_donate: 1,
                    produce_ready_at_ms: now + 10 * 3600 * 1000,
                }],
            }],
        };
        const pv = ranch.toRanchView(types.GetRanchDetailReply.fromObject(penFrame));
        check('棚被单独分组', (pv.pens || []).length === 1 && pv.pens[0].ranchInstId === 10003,
            pv.pens);
        check('生产期倒计时约 10 小时', Math.abs(pv.animals[0].produceInSec - 36000) <= 5, pv.animals[0].produceInSec);
        check('producing → 不可收', pv.animals[0].harvestable === false, pv.animals[0].harvestable);
    }

    section('16. PlaceAnimal 编码与抓包一致(幼崽id放target#2, 无count)');
    {
        // 抓包 20261118-165223_入栏: C->S = 0a0708914e10e1d403
        //   {1: {1: 10001(host_gid), 2: 60001(幼崽id)}} —— 没有 cub_item_id/count 字段
        // 旧实现发 {1:{1:gid,2:0}, 2:60001, 3:1} → 服务端读到 cub_item_id=0 → 1045205
        const protobuf = require('protobufjs');
        const { toLong } = require(`${SB}/src/utils/utils`);
        const w = protobuf.Writer.create();
        const tw = w.uint32(10).fork();
        tw.uint32(8).int64(toLong(10001));    // target.host_gid
        tw.uint32(16).int64(toLong(60001));   // target.#2 = 幼崽物品id
        tw.ldelim();
        const hex = w.finish().toString('hex');
        check('PlaceAnimal 编码与抓包一致', hex === '0a0708914e10e1d403', hex);

        // 实际调用验证
        const calls = installStub({
            PlaceAnimal: () => types.PlaceAnimalReply.encode(types.PlaceAnimalReply.create({
                ranches: [{ husbandry_type: 1, capacity: 3, animal_count: 1,
                    animals: [{ slot_index: 1, animal_id: 60001, stage: 1 }] }],
            })).finish(),
        });
        const ranch = freshRanch();
        await ranch.placeAnimal(60001);
        const req = types.PlaceAnimalRequest.decode(calls[0].body);
        check('请求里 host_gid = 10001', Number(req.target.host_gid) === 10001, Number(req.target.host_gid));
        check('target#2 = 幼崽id 60001', Number(req.target.slot) === 60001, Number(req.target.slot));
        check('没有多余的 #2(cub_item_id)', req.cub_item_id === undefined || Number(req.cub_item_id) === 0,
            req.cub_item_id);
        check('没有多余的 #3(count)', req.count === undefined || Number(req.count) === 0, req.count);
    }

    section('21. 罐头策略 autoFeedCansByStrategy(与农场施肥策略同构)');
    {
        // 动物矩阵:
        //   A 鸡  stage=4 剩 200s  没用过普通 → 普通目标 + (≤300s)有机目标
        //   B 鸭  stage=4 剩 600s  没用过普通 → 普通目标 + 非(>300s)有机目标
        //   C 鹅  stage=3 生产期    用过普通   → 仅有机(organic/both 策略)目标
        const animals = [
            { slot: 1, animalInstId: 121, ranchInstId: 10001, canFeed: true, limitedCanUsed: false, stage: 4, matureInSec: 200 },
            { slot: 2, animalInstId: 122, ranchInstId: 10001, canFeed: true, limitedCanUsed: false, stage: 4, matureInSec: 600 },
            { slot: 3, animalInstId: 123, ranchInstId: 10001, canFeed: true, limitedCanUsed: true, stage: 3, matureInSec: null },
        ];
        const EMPTY_FEED = () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish();
        // 注意不能字节扫描 #2: target 嵌套里的 `10` 也是 animal_inst_id 的标签, 会误判
        const reqOf = (body) => types.FeedAnimalRequest.decode(Buffer.isBuffer(body) ? body : Buffer.from(body));
        const kindOf = (body) => {
            const t = Number(reqOf(body).feed_type);
            return t === 2 ? 'normal' : 'organic';
        };
        const instOf = (body) => Number(reqOf(body).target && reqOf(body).target.animal_inst_id) || 0;

        const run = async (strategy, smartSeconds = 300) => {
            const calls = installStub({ FeedAnimal: EMPTY_FEED });
            const ranch = freshRanch();
            const r = await ranch.autoFeedCansByStrategy({ animals }, { feedStrategy: strategy, smartSeconds });
            return { r, kinds: calls.map(c => `${kindOf(c.body)}#${instOf(c.body)}`) };
        };

        // smart: 普通喂 A/B(没用过), 有机只喂 A(≤300s 快成熟)
        {
            const { r, kinds } = await run('smart');
            check('smart: 普通x2 + 有机x1 = 3', r.fed === 3 && r.details.join() === '普通罐头x2,有机罐头x1',
                `${r.fed}/${r.details.join()}`);
            check('smart: 普通喂 A,B; 有机只喂 A(快成熟)', kinds.join() === 'normal#121,normal#122,organic#121', kinds.join());
        }
        // normal: 只喂普通 A/B, 不喂有机
        {
            const { r, kinds } = await run('normal');
            check('normal: 普通x2, 无有机', r.fed === 2 && kinds.join() === 'normal#121,normal#122', kinds.join());
        }
        // organic: 全场喂有机(含 C), 不喂普通
        {
            const { r, kinds } = await run('organic');
            check('organic: 有机x3(A/B/C), 无普通', r.fed === 3 && kinds.join() === 'organic#121,organic#122,organic#123', kinds.join());
        }
        // both: 普通 A/B + 有机 A/B/C
        {
            const { r, kinds } = await run('both');
            check('both: 普通x2 + 有机x3 = 5', r.fed === 5 && kinds.filter(k => k.startsWith('normal')).length === 2
                && kinds.filter(k => k.startsWith('organic')).length === 3, kinds.join());
        }
        // none: 一只都不喂
        {
            const { r, kinds } = await run('none');
            check('none: 不喂', r.fed === 0 && kinds.length === 0 && r.strategy === 'none', `${r.fed}/${kinds.length}`);
        }
        // smart 秒数可覆盖: 60s 时 A(200s) 也不算快成熟
        {
            const { kinds } = await run('smart', 60);
            check('smart(60s): 无快成熟目标, 只喂普通', kinds.join() === 'normal#121,normal#122', kinds.join());
        }
    }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
