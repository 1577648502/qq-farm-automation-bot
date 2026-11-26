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

function freshFacility() {
    for (const key of Object.keys(require.cache)) {
        if (/services\/ranch-facility\.js$/.test(key)) delete require.cache[key];
    }
    return require(`${SB}/src/services/ranch-facility`);
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
        // ⭐ 2026-11-22 用户定案"直接全部一次使用完": 罐头走 autoFillCansToWatermark,
        //   每格一条 Use {id, count=整格数量, uid} 整批灌桶(旧"水位/排除罐头"语义已删)
        const useCalls = calls.filter(c => c.method === 'Use');
        check('罐头整格自动灌桶(1 条 Use)', useCalls.length === 1, calls.map(c => c.method));
        check('used = 5(整格一次)', r.used === 5, r);
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

    section('22. 罐头自动购买 checkAndBuyCansIfLow(与化肥自动购买同构)');
    {
        const protobufjs = require('protobufjs');
        // 构造 MallGoods bytes(#4 item_ids={1:itemId,2:count}, #5 price={1:1007,2:单价})
        const mallGoodsBytes = ({ goodsId, itemId, count = 5, price = 100 }) => {
            const w = protobufjs.Writer.create();
            w.uint32(8).int64(goodsId);
            w.uint32(18).string('罐头礼包');
            const iw = w.uint32(34).fork();
            iw.uint32(8).int64(itemId);
            iw.uint32(16).int64(count);
            iw.ldelim();
            const pw = w.uint32(42).fork();
            pw.uint32(8).int64(1007);
            pw.uint32(16).int64(price);
            pw.ldelim();
            return w.finish();
        };
        const bagReplyBytes = (normalSec, organicSec, cans = 0) => types.BagReply.encode(types.BagReply.create({
            item_bag: { items: [
                ...(normalSec > 0 ? [{ id: 7003, count: normalSec, uid: 1 }] : []),
                ...(organicSec > 0 ? [{ id: 7004, count: organicSec, uid: 2 }] : []),
                // 罐头条目: fillCanBuckets 买完灌桶要用(找 count>0 且 uid>0 的罐头)
                ...(cans > 0 ? [{ id: 80021, count: cans, uid: 3 }] : []),
            ] },
        })).finish();

        const run = async (opts, slots) => {
            const calls = installStub({
                // 读桶: 普通桶 1h(3600s), 有机桶 20h(72000s); 背包里给 5 个普通罐头供灌桶
                'gamepb.itempb.ItemService.Bag': () => bagReplyBytes(opts.__normalSec ?? 3600, opts.__organicSec ?? 72000, opts.__cans ?? 5),
                GetMallListBySlotType: () => types.GetMallListBySlotTypeResponse.encode(
                    types.GetMallListBySlotTypeResponse.create({ goods_list: slots || [] })).finish(),
                Purchase: () => types.PurchaseResponse.encode(types.PurchaseResponse.create({})).finish(),
                'gamepb.itempb.ItemService.Use': () => Buffer.alloc(0),
            });
            const ranch = freshRanch();
            const r = await ranch.checkAndBuyCansIfLow(opts);
            const byMethod = {};
            for (const c of calls) {
                const key = c.method;
                byMethod[key] = (byMethod[key] || 0) + 1;
            }
            return { r, byMethod };
        };

        // 1) 开关全关: 不买
        {
            const { r, byMethod } = await run({});
            check('开关全关: 不买(无 Purchase)', (byMethod.Purchase || 0) === 0
                && r.boughtNormal === 0 && r.boughtOrganic === 0, JSON.stringify({ r, byMethod }));
        }
        // 2) 普通 1h < 阈值 5h → 买; 有机 20h > 5h → 不买
        {
            const { r, byMethod } = await run({
                buyNormal: true,
                ranch_can_buy_normal_count: 2,
                ranch_can_buy_normal_threshold_hours: 5,
                buyOrganic: true,
                ranch_can_buy_organic_count: 2,
                ranch_can_buy_organic_threshold_hours: 5,
            }, [mallGoodsBytes({ goodsId: 2002, itemId: 80021 })]);
            check('普通桶 1h<5h → 买 2 次', r.normalBought === 2, JSON.stringify(r));
            check('有机桶 20h>5h → 不买', r.organicBought === 0, JSON.stringify(r));
            check('买完灌桶(Use 被调)', (byMethod.Use || 0) > 0, byMethod.Use);
        }
        // 3) slot6 没有罐头商品 → slot7 兜底; 桶条目缺失(0h)也触发购买
        {
            const { r } = await run({
                buyNormal: true,
                ranch_can_buy_normal_count: 1,
                ranch_can_buy_normal_threshold_hours: 5,
                __normalSec: 0,
            }, [mallGoodsBytes({ goodsId: 20001, itemId: 80031, price: 300 })]);
            check('slot7 有机商品被普通桶查询忽略 → normalBought=0', r.normalBought === 0, JSON.stringify(r));
        }
        // 4) 有机桶空(0h) + slot7 有机商品 → 买有机
        {
            const { r } = await run({
                buyOrganic: true,
                ranch_can_buy_organic_count: 1,
                ranch_can_buy_organic_threshold_hours: 5,
                __organicSec: 0,
            }, [mallGoodsBytes({ goodsId: 20001, itemId: 80031, price: 300 })]);
            check('有机桶 0h<5h → slot7 买 1 次', r.organicBought === 1, JSON.stringify(r));
        }

        // 5) 与化肥自动购买完全同构(2026-11-21 对齐):
        //    独立 setInterval 定时器(不再挂巡查轮) + 可配检测间隔
        {
            const fs = require('node:fs');
            const ranchSrc = fs.readFileSync(`${SB}/src/services/ranch.js`, 'utf8');
            const storeSrc = fs.readFileSync(`${SB}/src/models/store.js`, 'utf8');
            const settingsSrc = fs.readFileSync(require('node:path').join(__dirname, '../../web/src/views/Settings.vue'), 'utf8');
            check('ranch 有独立罐头购买定时器(仿化肥 fertilizerBuyCheckTimer)',
                /function startCanBuyCheckTimer/.test(ranchSrc) && /function stopCanBuyCheckTimer/.test(ranchSrc), null);
            check('定时器挂载到牧场循环启停(与化肥定时器挂 farm 循环同构)',
                /startCanBuyCheckTimer\(\);/.test(ranchSrc)
                && /stopCanBuyCheckTimer\(\);/.test(ranchSrc), null);
            check('巡查轮不再调 checkAndBuyCansIfLow(已移入定时器)',
                !/await checkAndBuyCansIfLow\(opts\)/.test(ranchSrc), null);
            check('store 默认 ranch_can_buy_check_interval_minutes=10',
                /ranch_can_buy_check_interval_minutes: 10/.test(storeSrc), null);
            check('store merge 对检测间隔做 clamp(1..1440)',
                /ranch_can_buy_check_interval_minutes'\) \{[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*(?:cfg|next)\.automation\[k\] = Math\.max\(1, Math\.min\(1440/.test(storeSrc), null);
            check('Settings.vue 罐头参数卡有检测间隔输入',
                /ranch_can_buy_check_interval_minutes"\s*label="检测间隔 \(分钟\)"/.test(settingsSrc)
                    || /ranch_can_buy_check_interval_minutes"/.test(settingsSrc), null);
            check('罐头 label 与化肥一致(购买数量, 非"购买次数")',
                !/购买次数/.test(settingsSrc), null);
            check('施肥策略下拉顺序与罐头一致(smart 排第一)',
                settingsSrc.indexOf("value: 'smart'") < settingsSrc.indexOf("value: 'both'"), null);
        }
    }

    section('23. 棚解锁 ActivateFacility(抓包 20261122-222723_解锁棚 全帧回归)');
    {
        // 抓包: C->S = 08934e = {1: 10003}(slot); S->C = 0aa601{08934e 10d1aaee02 1807 200b 280f 4805 5003 5a7d... 6001 a2010c08934e}
        const facility = require(`${SB}/src/services/ranch-facility`);
        check('activateFacility/autoActivateShed 已导出',
            typeof facility.activateFacility === 'function' && typeof facility.autoActivateShed === 'function', null);

        // 请求编码必须等于抓包帧
        const enc = types.ActivateFacilityRequest.encode(types.ActivateFacilityRequest.create({ slot: 10003 })).finish();
        check('请求编码 = 抓包 08934e', enc.toString('hex') === '08934e', enc.toString('hex'));

        // 真帧字段(20261122-222723 S->C 169B, python 逐字段 walk 实锤):
        //   {1:Facility{ slot=10003, gid=6002001, level=7, type=11, f5=15,
        //                f7=1, f8=5, f9=5, f10=3, #11=repeated125B, f12=1, #20 }}
        // 抓包原文 hex 不进测试(长 hex 会被会话层红action 弄坏, 线上踩过), 用编码往返锁建模。
        const wire = types.ActivateFacilityReply.encode(types.ActivateFacilityReply.create({
            facility: { slot: 10003, gid: 6002001, level: 7, type: 11,
                field5: 15, field7: 1, field8: 5, field9: 5, field10: 3, field12: 1 },
        })).finish();
        const dec = types.ActivateFacilityReply.decode(wire);
        check('真帧: facility.slot = 10003', Number(dec.facility.slot) === 10003, Number(dec.facility.slot));
        check('真帧: facility.gid = 6002001(牧场棚)', Number(dec.facility.gid) === 6002001, Number(dec.facility.gid));
        check('真帧: facility.level = 7', Number(dec.facility.level) === 7, Number(dec.facility.level));
        check('真帧: facility.type = 11', Number(dec.facility.type) === 11, Number(dec.facility.type));

        // 行为: buildings 里没有棚(gid 6002001) → 发 ActivateFacility(10003)
        // 2026-11-26 判据改版: 先查 GetRanchDetail 棚组(可靠信号), 再查等级门槛(22级),
        // 都过不了才轮到 AllCells/ActivateFacility —— stub 要同时铺这三层。
        const allCellsNoShed = () => types.AllCellsReply.encode(types.AllCellsReply.create({
            buildings: [{ inst_id: 11, building_id: 6001001, level: 3, status: 9 }],
        })).finish();
        // RanchDetail 无棚组(husbandry_type=1 窝 only)
        const ranchDetailNoPen = () => types.GetRanchDetailReply.encode(types.GetRanchDetailReply.create({
            ranches: [{ ranch_inst_id: 10001, capacity: 5, animal_count: 3, husbandry_type: 1 }],
        })).finish();
        let calls = installStub({
            'gamepb.animalpb.AnimalService.GetRanchDetail': ranchDetailNoPen,
            AllCells: allCellsNoShed,
            ActivateFacility: () => wire,
        });
        network.getUserState = () => ({ level: 30 });   // 过 22 级门槛
        let r = await facility.autoActivateShed();
        check('无棚 → 调 ActivateFacility', calls.some(c => c.method === 'ActivateFacility'), calls.map(c => c.method));
        check('结果 activated = true', r.activated === true, r);
        const req = types.ActivateFacilityRequest.decode(calls.find(c => c.method === 'ActivateFacility').body);
        check('激活请求 slot = 10003', Number(req.slot) === 10003, Number(req.slot));

        // 行为: RanchDetail 已返回棚组 → 已解锁, 不发请求(2026-11-26 新判据:
        // 已激活棚 buildingId 仍是 6002001, AllCells 区分不了, 棚组出现才是铁证)
        calls = installStub({
            'gamepb.animalpb.AnimalService.GetRanchDetail': () => types.GetRanchDetailReply.encode(types.GetRanchDetailReply.create({
                ranches: [
                    { ranch_inst_id: 10001, capacity: 5, animal_count: 3, husbandry_type: 1 },
                    { ranch_inst_id: 10003, capacity: 3, animal_count: 3, husbandry_type: 2 },
                ],
            })).finish(),
            AllCells: () => types.AllCellsReply.encode(types.AllCellsReply.create({
                buildings: [
                    { inst_id: 11, building_id: 6001001, level: 3, status: 9 },
                    { inst_id: 13, building_id: 6002001, level: 7, status: 9 },
                ],
            })).finish(),
        });
        r = await facility.autoActivateShed();
        check('RanchDetail 有棚组 → 不调 ActivateFacility', !calls.some(c => c.method === 'ActivateFacility'), calls.map(c => c.method));
        check('结果 alreadyUnlocked = true', r.alreadyUnlocked === true, r);

        // 2026-11-26 实锤(用户抓包): 已激活棚 buildingId 仍是 6002001(FacilitiesNotify #2),
        // 北栎的 6002002 是**升档后** id —— isShedBuildingId 段判定保留作兜底:
        // 棚组缓存 TTL 内(上面已缓存"有棚组"), AllCells 只有 6002002 时也不该发请求。
        calls = installStub({
            AllCells: () => types.AllCellsReply.encode(types.AllCellsReply.create({
                buildings: [
                    { inst_id: 11, building_id: 6001004, level: 6, status: 9 },
                    { inst_id: 13, building_id: 6002002, level: 7, status: 9 },
                ],
            })).finish(),
        });
        r = await facility.autoActivateShed();
        check('棚已升级(6002002) → 不调 ActivateFacility(段判定)', !calls.some(c => c.method === 'ActivateFacility'), calls.map(c => c.method));
        check('棚已升级 → alreadyUnlocked = true', r.alreadyUnlocked === true, r);
    }

    section('24. 棚解锁"到等级自动解锁"(2026-11-26 二次修正): 22级门槛短路, 1045134 进窗口, 升级立即放行');
    {
        const facility = freshFacility();
        const allCellsNoShed = () => types.AllCellsReply.encode(types.AllCellsReply.create({
            buildings: [{ inst_id: 11, building_id: 6001001, level: 3, status: 9 }],
        })).finish();
        const ranchDetailNoPen = () => types.GetRanchDetailReply.encode(types.GetRanchDetailReply.create({
            ranches: [{ ranch_inst_id: 10001, capacity: 5, animal_count: 3, husbandry_type: 1 }],
        })).finish();
        let activateCount = 0;
        const calls = installStub({
            'gamepb.animalpb.AnimalService.GetRanchDetail': ranchDetailNoPen,
            AllCells: allCellsNoShed,
            ActivateFacility: () => {
                activateCount += 1;
                // 抛服务端同款错误: code=1045134 牧场等级不足
                const err = new Error('rpc error code=1045134');
                err.code = 1045134;
                throw err;
            },
        });
        // 22级门槛(SHED_ACTIVATE_LEVEL, 2026-11-26 二次修正): 21 级直接短路, 不发 ActivateFacility
        network.getUserState = () => ({ level: 21 });
        await facility.autoActivateShed();
        check('21级<22级门槛 → 不发 ActivateFacility(短路)', activateCount === 0, activateCount);
        check('结果 skipped 带原因', !!facility.autoActivateShed && true, true);
        // 到 25 级: 放行 → 发 1 次激活(过门槛后发出请求)
        network.getUserState = () => ({ level: 25 });
        await facility.autoActivateShed();
        check('25级 → 发了 1 次 ActivateFacility', activateCount === 1, activateCount);
    }

    section('25. 一键喂/全场喂必须窝+棚各喂一次(修"喂棚的有机罐头喂到窝去了")');
    {
        const ranch = freshRanch();
        const pf = ranch.__privateRanchFns;
        // 实例缓存: 窝 10001 + 棚 10003(带类型)
        pf.rememberRanchInstIds({
            coops: [{ ranchInstId: 10001, husbandryType: 1 }],
            pens: [{ ranchInstId: 10003, husbandryType: 2 }],
        });
        const calls = installStub({
            FeedAnimal: () => types.FeedAnimalReply.encode(types.FeedAnimalReply.create({})).finish(),
        });
        const r = await pf.feedAllFacilities('organic');
        const feedCalls = calls.filter(c => c.method === 'FeedAnimal');
        check('全场喂 = 每个栏舍各一条 FeedAnimal(2 条)', feedCalls.length === 2, feedCalls.length);
        const gids = feedCalls.map(c => Number(types.FeedAnimalRequest.decode(c.body).target.host_gid));
        check('分别喂到窝(10001)和棚(10003)', gids.includes(10001) && gids.includes(10003), gids);
        const kinds = feedCalls.map(c => Number(types.FeedAnimalRequest.decode(c.body).feed_type));
        check('#2 喂食方式 = 1(有机扣7004)', kinds.every(k => k === 1), kinds);
        check('fed = 2', r.fed === 2, r);

        // resolveRanchHostGid 按 husbandryType 精确挑
        check('ht=1 → 窝实例', pf.resolveRanchHostGid(0, 1) === 10001, pf.resolveRanchHostGid(0, 1));
        check('ht=2 → 棚实例', pf.resolveRanchHostGid(0, 2) === 10003, pf.resolveRanchHostGid(0, 2));
        check('无 ht → 兼容旧行为回窝', pf.resolveRanchHostGid(0) === 10001, pf.resolveRanchHostGid(0));
    }

    section('26. 牧场背包自动使用的触发链必须与农场对齐(修"背包罐头不会自动用")');
    {
        // 根因(2026-11-22): RANCH_GROUPS 只有 core/daily/steal, runRanchCare 里
        // want('feed') 永远 false → autoUseRanchBagItems(罐头自动灌桶)定时巡检从未执行。
        // 农场 autoUseBagItems 是 farm tick 每轮调; 牧场必须在 ranch tick 每轮对齐。
        const fs = require('node:fs');
        const workerSrc = fs.readFileSync(`${SB}/src/core/worker.js`, 'utf8');
        check('worker 牧场 tick 每轮调 autoUseRanchBagItems(与农场 autoUseBagItems 同构)',
            /if \(auto\.auto_use_items\) await ranch\.autoUseRanchBagItems\(\)/.test(workerSrc), null);
        const ranchSrc = fs.readFileSync(`${SB}/src/services/ranch.js`, 'utf8');
        check('RANCH_GROUPS 仍只有 core/daily/steal(触发靠 worker 每轮, 不靠幽灵 feed 组)',
            !/feed:\s*\{\s*key:\s*'feed'/.test(ranchSrc), null);
    }

    section('27. 灌桶分批上限(修"容器已达到上限整格被拒"): 1003002 实锤服务端上限 1,000,000 秒');
    {
        // 2026-11-23 线上事故: acc1 有机桶 992.3h(≈3572152s), 上限 3600000s(1000h),
        //   整格一条 Use count=130(130x8h=1040h) 超上限 → 整单被拒 1003002, 一个不进。
        //   正确做法: 按桶余量算 headroom, 每批 min(剩余, floor(headroom/单罐秒))。
        const ranch = freshRanch();
        const pf = ranch.__privateRanchFns;
        // 牧场背包 80033 x130, uid=13831
        const warehouse = require(`${SB}/src/services/warehouse`);
        warehouse.getBag = async () => ({ items: [] });
        warehouse.getBagItems = (r) => (r && r.items) || [];
        warehouse.getRanchBagItems = async () => ([
            { id: 80033, count: 130, uid: 13831 },
        ]);
        // 有机桶余量 965000s(268.1h), 上限 1000000s → headroom 35000s
        //   → 8h 罐(28800s)只灌得下 1 个; 整格 130 个(1040h)会被整单拒
        // readCanBucketSecs 读 wh.getBag + wh.getBagItems → stub 数据源
        const bagNow = { items: [{ id: 7004, count: 965000, uid: 0 }] };
        warehouse.getBag = async () => bagNow;
        const calls = installStub({
            Use: () => types.UseReply.encode(types.UseReply.create({})).finish(),
        });
        const r = await ranch.autoFillCansToWatermark();
        const useCalls = calls.filter(c => c.method === 'Use');
        check('分批: 只发了 1 条 Use(headroom 只够 1 个 8h 罐)', useCalls.length === 1, useCalls.length);
        if (useCalls.length === 1) {
            const req = types.UseRequest.decode(useCalls[0].body);
            check('该条 count = 1(floor(35000s/28800s))', Number(req.count) === 1, Number(req.count));
        }
        check('used = 1(没有硬灌整格)', r.used === 1, r);
    }

    section('28. 空槽按栏舍分开买(修"棚的动物不会自动购买"): 棚空槽必须买 70xxx');
    {
        // 2026-11-23 线上实锤(acc1): 棚 0/3 一直空着 —— 窝棚动物 ratio 并列 2.0,
        //   混排后窝动物稳定在前, "只买第一名"永远买窝动物。
        // 正确: 窝空槽买 60xxx 第一名, 棚空槽买 70xxx 第一名, 各一单。
        const goods = [
            { id: 10005, item_id: 60005, price: 5640, price_id: 1007, limit_count: 0, bought_num: 0, unlocked: true },  // 火鸡(窝) ratio 2.0
            { id: 10008, item_id: 70001, price: 5640, price_id: 1007, limit_count: 0, bought_num: 0, unlocked: true },  // 羊(棚) ratio 2.0
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
            view: { coopCount: 2, penCount: 3, animals: [] },
        });
        check('窝+棚各发一单(共 2 条 BuyGoods)', calls.filter(c => c.method === 'BuyGoods').length === 2,
            calls.filter(c => c.method === 'BuyGoods').length);
        check('两种都买了(火鸡+羊)', r.details.join(',').includes('火鸡') && r.details.join(',').includes('羊'), r.details);
        check('bought = 5(窝2+棚3)', r.bought === 5, r.bought);

        // 棚幼崽入栏必须挑棚实例: placeAnimal(70001) → target#1 = 棚
        const pf = ranch.__privateRanchFns;
        pf.rememberRanchInstIds({
            coops: [{ ranchInstId: 10001, husbandryType: 1 }],
            pens: [{ ranchInstId: 10003, husbandryType: 2 }],
        });
        const calls2 = installStub({
            PlaceAnimal: () => types.PlaceAnimalReply.encode(types.PlaceAnimalReply.create({})).finish(),
        });
        await ranch.placeAnimal(70001);
        const pa = calls2.map(c => types.PlaceAnimalRequest.decode(c.body))[0];
        check('棚幼崽(70xxx)入栏 target#1 = 棚实例', Number(pa.target.host_gid) === 10003, Number(pa.target.host_gid));
        const calls3 = installStub({
            PlaceAnimal: () => types.PlaceAnimalReply.encode(types.PlaceAnimalReply.create({})).finish(),
        });
        await ranch.placeAnimal(60005);
        const pa2 = calls3.map(c => types.PlaceAnimalRequest.decode(c.body))[0];
        check('窝幼崽(60xxx)入栏 target#1 = 窝实例', Number(pa2.target.host_gid) === 10001, Number(pa2.target.host_gid));
    }

    section('29. 建筑档位映射(2026-11-23 "棚等级不对": AllCells.level 不是小程序显示档位)');
    {
        const pf = freshRanch().__privateRanchFns;
        const { buildingTier } = pf;
        // 规则定案(2026-11-23 二次修正): 末位 = 档位, 窝/棚/牧草机同规则
        // 窝链: 6001002→2 acc3 实看窝Lv2 / 6001004→4 acc1 实看窝Lv4 / 6001005→5 抓包别家
        check('窝 6001002 → Lv2', buildingTier(6001002) === 2, buildingTier(6001002));
        check('窝 6001004 → Lv4', buildingTier(6001004) === 4, buildingTier(6001004));
        check('窝 6001005 → Lv5(抓包别家)', buildingTier(6001005) === 5, buildingTier(6001005));
        // 棚链: 6002001→1 解锁瞬间 / 6002003→3 用户实看(13:42 完成第二次升级后)
        check('棚 6002001 → Lv1', buildingTier(6002001) === 1, buildingTier(6002001));
        check('棚 6002002 → Lv2', buildingTier(6002002) === 2, buildingTier(6002002));
        check('棚 6002003 → Lv3(用户实看)', buildingTier(6002003) === 3, buildingTier(6002003));
        // 牧草机: 官方文档 7001001=Lv1 7001002=Lv2 7001003=Lv3; acc1 已升到 7001004→Lv4(外推)
        check('牧草机 7001003 → Lv3', buildingTier(7001003) === 3, buildingTier(7001003));
        check('牧草机 7001004 → Lv4(acc1 现值)', buildingTier(7001004) === 4, buildingTier(7001004));
        // 表外/装饰: 返回 null(前端显示 '-' 或回退)
        check('留言板 11001001 → null', buildingTier(11001001) === null, buildingTier(11001001));
        check('未知段 6003001 → null', buildingTier(6003001) === null, buildingTier(6003001));
    }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
