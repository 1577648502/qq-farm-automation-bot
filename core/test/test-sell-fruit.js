/**
 * 自动出售果实 / 「连黄金果实一起卖」 回归测试
 *
 * 规则(2026-09-30 新增):
 *   · automation.sell 打开后才会自动卖果实(原有行为)
 *   · 黄金果实(物品名含"黄金" 如 黄金果 / 黄金·xx, 或带黄金_天工/珍品/稀有变异 枚举 5/6/7)
 *     **默认保留**; 只有设置里勾了 sellGoldenFruit 才会一起卖
 *   · 非黄金的品质变异(月华/塔塔/荷华等)继续保留(原有行为)
 *
 * 运行: node test/test-sell-fruit.js
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'sell-fruit-test';
isolateDataDir(SB, 'sell-fruit-test');

(async () => {
    const { types } = require(`${SB}/src/utils/proto`);
    await require(`${SB}/src/utils/proto`).loadProto();
    const mg = require(`${SB}/src/services/mengchong`);

    // 背包内容: 普通果实 / 黄金果(名字含黄金) / 黄金_天工变异果实 / 月华变异果实(非黄金) / 非果实道具
    const BAG = [
        { id: 40002, count: 10 },                       // 白萝卜(普通果实)
        { id: 40304, count: 2 },                        // 黄金果(名字含黄金)
        { id: 40065, count: 3, mutant_types: [5] },     // 大蒜 + 黄金_天工
        { id: 40064, count: 4, mutant_types: [10] },    // 大葱 + 月华(非黄金品质变异)
        { id: 80001, count: 9 },                        // 化肥(非果实, type 7)
    ];

    const soldBatches = [];
    const net = require(`${SB}/src/utils/network`);
    net.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        if (key === 'gamepb.itempb.ItemService.Bag') {
            return { body: types.BagReply.encode(types.BagReply.create({
                item_bag: { items: BAG },
            })).finish() };
        }
        if (key === 'gamepb.itempb.ItemService.Sell') {
            const req = types.SellRequest.decode(Buffer.from(body));
            soldBatches.push((req.items || []).map(x => ({ id: Number(x.id), count: Number(x.count) })));
            return { body: types.SellReply.encode(types.SellReply.create({})).finish() };
        }
        throw new Error('未 stub 的接口: ' + key);
    };

    const store = require(`${SB}/src/models/store`);
    const wh = require(`${SB}/src/services/warehouse`);

    /** 设置配置: 自动卖果实开 / 黄金果实开关可选 */
    function setConfig(sellGolden) {
        store.applyConfigSnapshot({
            automation: { sell: true },
            sellGoldenFruit: sellGolden,
        }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
    }
    const soldIds = () => soldBatches.flat().map(x => x.id).sort((a, b) => a - b);

    section('1. 识别"黄金果实"');
    {
        check('黄金果(名字含黄金)', wh.isGoldenFruitItem({ id: 40304 }, 40304) === true);
        check('黄金_天工变异(枚举5)', wh.isGoldenFruitItem({ id: 40065, mutant_types: [5] }, 40065) === true);
        check('黄金_珍品变异(枚举6)', wh.isGoldenFruitItem({ id: 40065, mutant_types: [6] }, 40065) === true);
        check('月华变异(枚举10)不是黄金', wh.isGoldenFruitItem({ id: 40064, mutant_types: [10] }, 40064) === false);
        check('普通果实不是黄金', wh.isGoldenFruitItem({ id: 40002 }, 40002) === false);
    }

    section('2. 未勾选: 黄金果实全部保留, 普通果实照卖');
    {
        setConfig(false);
        soldBatches.length = 0;
        await wh.sellAllFruits();
        const ids = soldIds();
        check('普通果实(白萝卜)被卖出', ids.includes(40002), ids);
        check('黄金果(40304)被保留', !ids.includes(40304), ids);
        check('黄金_天工果实被保留', !ids.includes(40065), ids);
        check('月华变异果实被保留', !ids.includes(40064), ids);
        check('非果实道具不参与', !ids.includes(80001), ids);
    }

    section('3. 勾选后: 黄金果实一起卖, 非黄金的品质变异仍保留');
    {
        setConfig(true);
        soldBatches.length = 0;
        await wh.sellAllFruits();
        const ids = soldIds();
        check('普通果实被卖出', ids.includes(40002), ids);
        check('黄金果(40304)也卖出', ids.includes(40304), ids);
        check('黄金_天工果实也卖出', ids.includes(40065), ids);
        check('月华变异仍保留(非黄金)', !ids.includes(40064), ids);
        check('非果实道具不参与', !ids.includes(80001), ids);
    }

    section('4. 自动卖果实关闭时, 勾了黄金也不卖(尊重总开关)');
    {
        store.applyConfigSnapshot({ automation: { sell: false }, sellGoldenFruit: true }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
        soldBatches.length = 0;
        await wh.sellAllFruits();
        check('一个都没卖', soldBatches.length === 0, soldBatches);
    }

    finish();
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
