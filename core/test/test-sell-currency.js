/**
 * 自动卖果实 —— 币种显示回归测试
 *
 * 用户要求: 普通果实卖得**金币**, 黄金果实卖得**金豆豆**, 日志要把两者分开显示。
 * 实现要点: 采集阶段把果实分成两组(普通/黄金)分别出售, 才能按组统计币种收益。
 *
 * 抓包/实测币种ID: 1001 = 金币 · 1005 = 金豆豆 · 1002 = 点券
 *
 * 运行: node test/test-sell-currency.js
 */
const path = require('node:path');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'sell-test';
isolateDataDir(SB, 'sell-test');

const BAG_SVC = 'gamepb.itempb.ItemService.Bag';
const SELL_SVC = 'gamepb.itempb.ItemService.Sell';

(async () => {
    const { types } = require(`${SB}/src/utils/proto`);
    await require(`${SB}/src/utils/proto`).loadProto();

    // 日志捕获
    const logs = [];
    const utils = require(`${SB}/src/utils/utils`);
    // 日志 hook 签名: (tag, msg, isWarn, meta)
    utils.setLogHook((tag, msg, isWarn, meta) => { logs.push({ tag, msg: String(msg || ''), meta: meta || {} }); });

    // 设置: 开启自动卖果实 + 连黄金果实一起卖
    const store = require(`${SB}/src/models/store`);
    store.applyConfigSnapshot({
        automation: { sell: true },
        sellGoldenFruit: true,
    }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });

    const bagReply = types.BagReply.encode(types.BagReply.create({
        item_bag: {
            items: [
                { id: 40002, count: 3 },        // 白萝卜(普通果实, type=6)
                { id: 1040046, count: 2 },      // 黄金·爱心果(黄金果实, type=17)
            ],
        },
    })).finish();

    // 两次 Sell 的返回: 第一次(普通)给金币, 第二次(黄金)给金豆豆
    const sellReplies = [
        types.SellReply.encode(types.SellReply.create({
            sell_items: [{ id: 40002, count: 3 }],
            get_items: [{ id: 1001, count: 120 }],   // 金币
        })).finish(),
        types.SellReply.encode(types.SellReply.create({
            sell_items: [{ id: 1040046, count: 2 }],
            get_items: [{ id: 1005, count: 40 }],    // 金豆豆
        })).finish(),
    ];

    const sellCalls = [];
    const net = require(`${SB}/src/utils/network`);
    net.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        if (key === BAG_SVC) return { body: bagReply };
        if (key === SELL_SVC) {
            const req = types.SellRequest.decode(Buffer.from(body));
            sellCalls.push((req.items || []).map((it) => Number(it.id)));
            const reply = sellReplies[Math.min(sellCalls.length - 1, sellReplies.length - 1)];
            return { body: reply };
        }
        throw new Error('未 stub 的接口: ' + key);
    };

    const warehouse = require(`${SB}/src/services/warehouse`);

    section('1. 分组出售: 普通果实 → 金币, 黄金果实 → 金豆豆');
    {
        logs.length = 0;
        await warehouse.sellAllFruits();
        check('卖了 2 次(普通/黄金各一批)', sellCalls.length === 2, sellCalls);
        check('第一批只有普通果实(40002)', JSON.stringify(sellCalls[0]) === JSON.stringify([40002]), sellCalls[0]);
        check('第二批只有黄金果实(1040046)', JSON.stringify(sellCalls[1]) === JSON.stringify([1040046]), sellCalls[1]);
    }

    section('2. 日志把金币与金豆豆分开显示');
    {
        const sellLog = logs.find((l) => /出售 /.test(l.msg));
        check('有出售日志', !!sellLog, logs.map((l) => l.msg).slice(0, 3));
        const msg = (sellLog && sellLog.msg) || '';
        check('日志含"金币 +120"', msg.includes('金币 +120'), msg);
        check('日志含"金豆豆 +40"', msg.includes('金豆豆 +40'), msg);
        check('日志区分普通/黄金两组', msg.includes('普通果实') && msg.includes('黄金果实'), msg);
        check('日志列出物品名', msg.includes('白萝卜') && msg.includes('黄金'), msg);
        check('结构化字段 gold=120', Number(sellLog.meta.gold) === 120, sellLog.meta.gold);
        check('结构化字段 goldBean=40', Number(sellLog.meta.goldBean) === 40, sellLog.meta.goldBean);
    }

    section('3. 设置关掉"连黄金果实一起卖"时只卖普通果实');
    {
        store.applyConfigSnapshot({ sellGoldenFruit: false }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
        sellCalls.length = 0;
        logs.length = 0;
        await warehouse.sellAllFruits();
        check('只卖 1 次', sellCalls.length === 1, sellCalls);
        check('只卖普通果实', JSON.stringify(sellCalls[0]) === JSON.stringify([40002]), sellCalls[0]);
        const msg = (logs.find((l) => /出售 /.test(l.msg)) || {}).msg || '';
        check('日志只报金币', msg.includes('金币 +120') && !msg.includes('金豆豆'), msg);
    }

    finish();
})().catch((e) => { console.log('测试异常:', e && e.message); process.exit(1); });
