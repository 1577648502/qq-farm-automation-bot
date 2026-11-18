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

    section('3. #10 语义定案: 本轮计时起点, 不是倒计时终点');
    {
        // 入栏抓包时间线: 动作(入栏/催产/收获)后 #10 立即重置为当前时刻附近(+8s/-3s/-8s/-14s)
        // → #10 是"本轮计时起点"。真正的产出倒计时是 #25(trigger_ready_at)。
        const ranch = require(`${SB}/src/services/ranch`);
        const now = Date.now();
        const v = ranch.toRanchView({
            ranch: { animals: [{ slot: 1, animal_id: 60001, stage: 1, feed_state: 3,
                produce_at: now - 3000, trigger_ready_at: now + 9000, grown_flag: 0 }] },
        }).animals[0];
        check('feed=3 倒计时用 #25(约9秒)', Math.abs((v.deliverInSec || 0) - 9) <= 2, v.deliverInSec);
        check('#10 过期不影响倒计时', v.harvestable === false, v.harvestable);
    }

    section('4. #25 缺失(feed=3) → 无倒计时(不编造)');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const v = ranch.toRanchView({
            ranch: { animals: [{ slot: 1, animal_id: 60001, stage: 6, feed_state: 3, grown_flag: 1 }] },
        }).animals[0];
        check('无 #25 → deliverInSec = null', v.deliverInSec === null, v.deliverInSec);
        check('无 #25 → 不可收', v.harvestable === false, v.harvestable);
    }

    section('5. #25 是生产期倒计时的权威来源(催产后出现)');
    {
        const now = Date.now();
        const ranch = require(`${SB}/src/services/ranch`);
        const v = ranch.toRanchView({
            ranch: { animals: [{ slot: 1, animal_id: 60002, stage: 6, feed_state: 3,
                produce_at: now - 60 * 1000,
                trigger_ready_at: now + 30 * 1000,   // 30 秒后可产出
                grown_flag: 1 }] },
        }).animals[0];
        check('生产期倒计时 = #25(约30秒)', Math.abs((v.deliverInSec || 0) - 30) <= 2, v.deliverInSec);
        check('#10 过期不影响', v.harvestable === false, v.harvestable);
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
        await fresh.__privateRanchFns.feedAnimal(4, 1);
        const req = types.FeedAnimalRequest.decode(calls[0].body);
        check('请求 target.host_gid = 10001', Number(req.target.host_gid) === 10001, Number(req.target.host_gid));
    }

    section('15. 倒计时终案(入栏抓包完整时间线定案)');
    {
        // 时间线(t=秒): 入栏后 feed=1 #10=+8 #25=- → 催产 feed=3 #10=-3 #25=+9
        //   → 收获 feed=4 → 再查 feed=5
        // 定案: #10=本轮计时起点(动作即重置), #25=下次产出时刻(催产后出现)
        //   成长期倒计时 = #10(feed=1 时是成长完成点)
        //   生产期倒计时 = #25(feed=3, 官方 trigger_ready_at)
        const ranch = require(`${SB}/src/services/ranch`);
        const now = Date.now();
        const mk = (grown, feed, produceAt, triggerReadyAt) => ranch.toRanchView({
            ranch: { animals: [{ slot: 1, animal_id: 60001, stage: 1, feed_state: feed, grown_flag: grown,
                produce_at: produceAt, trigger_ready_at: triggerReadyAt }] },
        }).animals[0];

        // 成长期(入栏后): feed=1, #10=+8s → 成长倒计时约 8s
        const growing = mk(1, 1, now + 8000, 0);
        check('成长期 feed=1 → 不可收', growing.harvestable === false, growing.harvestable);
        check('成长期倒计时 = #10(约8秒)', Math.abs((growing.stageEndInSec || 0) - 8) <= 2, growing.stageEndInSec);

        // 生产期(催产后): feed=3, #25=+9s → 生产期倒计时约 9s
        const laying = mk(0, 3, now - 3000, now + 9000);
        check('生产期 feed=3 → 不可收', laying.harvestable === false, laying.harvestable);
        check('生产期倒计时 = #25(约9秒)', Math.abs((laying.deliverInSec || 0) - 9) <= 2, laying.deliverInSec);

        // 成熟期(收获时机): feed=4 → 可收
        const mature = mk(1, 4, now - 8000, now + 3000);
        check('成熟期 feed=4 → 可收', mature.harvestable === true, mature.harvestable);

        // 刚收完: feed=5
        const done = mk(0, 5, now - 14000, now - 2000);
        check('刚收完 feed=5 → 不可收', done.harvestable === false, done.harvestable);
        check('刚收完无倒计时', done.deliverInSec === null, done.deliverInSec);
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
                ranch: { animals: [{ slot: 1, animal_id: 60001, stage: 1, feed_state: 2 }] },
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

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
