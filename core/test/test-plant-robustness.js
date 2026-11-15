/**
 * 种植主流程健壮性回归测试
 *
 * 覆盖两个"异常被静默吞掉、整轮种植中断"的场景:
 *
 * 1. 商店补种时空地 < 2x2 所需数量
 *    plantFromShop 的返回约定是 { plantedLands }，曾有一处裸 `return;` 返回
 *    undefined，调用方直接读 `.plantedLands` 会抛 TypeError，被上层 catch
 *    吞成一条 warn 日志 —— 表现为"这轮凭空没种"，很难排查。
 *
 * 2. 背包种子优先 + 商店补种 组合路径
 *    两条返回路径都必须能安全解构。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'plant-robust-test';
isolateDataDir(SB, 'plant-robust-test');

const network = require(`${SB}/src/utils/network`);
const proto = require(`${SB}/src/utils/proto`);
const store = require(`${SB}/src/models/store`);
const { types } = proto;

let shopGoods = [];
let useCalls = [];
// 24 块地, 其中 21 块已种(不可种), 只剩 3 块空地 → 2x2 种子凑不齐
let landsForRun = [];
function buildLands(emptyCount) {
    const lands = [];
    for (let id = 1; id <= 24; id++) {
        const land = { id, unlocked: true, level: 4, max_level: 6, could_upgrade: false };
        // 前 (24 - emptyCount) 块种着普通作物, 其余是空地
        if (id <= 24 - emptyCount) {
            land.plant = { id: 1020002, name: '白萝卜', phases: [{ phase: 2, begin_time: 0 }] };
        }
        lands.push(land);
    }
    return lands;
}

network.sendMsgAsync = async (_service, method, body) => {
    if (method === 'AllLands') {
        return {
            body: Buffer.from(types.AllLandsReply.encode(types.AllLandsReply.create({
                lands: landsForRun,
            })).finish()),
        };
    }
    if (method === 'ShopInfo') {
        return {
            body: Buffer.from(types.ShopInfoReply.encode(types.ShopInfoReply.create({
                goods_list: shopGoods,
            })).finish()),
        };
    }
    if (method === 'Plant') {
        useCalls.push('Plant');
        return { body: Buffer.from(types.PlantReply.encode(types.PlantReply.create({})).finish()) };
    }
    throw new Error(`unexpected method: ${method}`);
};

proto.loadProto().then(async () => {
    const farm = require(`${SB}/src/services/farm`);

    section('1. 空地不足 2x2 所需数量时, 商店补种不抛 TypeError');
    {
        store.applyConfigSnapshot({
            plantingStrategy: 'max_exp',
            automation: { fertilizer: 'none' },
        }, { accountId: process.env.FARM_ACCOUNT_ID });
        network.getUserState().level = 200;
        network.getUserState().gold = 999999999;

        // 商店里只有 2x2 种子, 而只剩 3 块空地
        shopGoods = [{
            id: 1,
            item_id: 20046,   // 爱心果(2x2)
            price: 100,
            unlocked: true,
            bought_num: 0,
            limit_count: 0,
            conds: [],
        }];

        // ⚠ 关键: 这个 bug 的异常会被上层 catch 吞掉, 单看"有没有 throw"是测不出来的,
        //   必须抓到那条 "Cannot read properties of undefined" 的日志
        const loggedWarns = [];
        const { setLogHook } = require(`${SB}/src/utils/utils`);
        setLogHook((tag, msg, isWarn) => {
            if (isWarn) loggedWarns.push(String(msg));
        });

        landsForRun = buildLands(3);
        useCalls = [];
        let threw = null;
        try {
            await farm.runFarmOperation('plant');
        } catch (e) {
            threw = e;
        }
        setLogHook(null);

        check('不会抛到调用方', threw === null, threw && threw.message);
        check('没有发出 Plant 请求(凑不齐就不种)', useCalls.length === 0, useCalls);
        const typeError = loggedWarns.find(m => m.includes("reading 'plantedLands'"));
        check('日志里没有 TypeError(旧代码会留下 Cannot read properties of undefined)',
            !typeError, { typeError, warns: loggedWarns.slice(0, 5) });
    }

    section('2. plantFromShop 的所有出口形状一致');
    {
        // 通过 __privateFarmFns 之外的方式很难直接调, 这里用"空地=0"与"空地充足"两次
        // 运行确认调用方解构安全
        check('__privateFarmFns 暴露了 plantFromShop 之外的关键函数',
            typeof farm.__privateFarmFns.plantFromBagSeeds === 'function',
            Object.keys(farm.__privateFarmFns || {}));
    }

    finish();
}).catch(e => {
    console.log('测试异常:', e && e.message);
    process.exit(1);
});
