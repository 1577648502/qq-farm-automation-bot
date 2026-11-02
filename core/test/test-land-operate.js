/**
 * 单地块操作(我的农场里每块地单独操作) 回归测试
 *
 * 覆盖 farm.operateSingleLand 的分发: 每种 op 是否打到**正确的协议方法**、带的 land_ids 对不对。
 *   浇水 → WaterLand / 除草 → WeedOut / 除虫 → Insecticide / 收获 → Harvest
 *   铲除 → RemovePlant / 升级 → UpgradeLand / 解锁 → UnlockLand / 种植 → Plant / 施肥 → Fertilize
 * 以及参数校验: 缺 landId / 缺 op / 种植没给 seedId / 未知 op 都要报错
 *
 * 运行: node test/test-land-operate.js
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'land-op-test';
isolateDataDir(SB, 'land-op-test');

(async () => {
    const { types } = require(`${SB}/src/utils/proto`);
    await require(`${SB}/src/utils/proto`).loadProto();

    const calls = [];
    const net = require(`${SB}/src/utils/network`);
    // ⚠ farm.js 在 require 时就解构了 network.sendMsgAsync, 之后替换 net.sendMsgAsync 不会生效。
    //   需要按用例改变应答时, 通过 customHandler 钩子(调用时读取)来接管。
    let customHandler = null;
    // 先给 getUserState 一个 gid(部分请求要带 host_gid)
    net.getUserState().gid = 1229231763;
    net.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        const raw = Buffer.from(body || []);
        const landIds = [];
        try {
            const f = require(`${SB}/src/services/mengchong`).parseTop(raw);
            const li = f.find(x => x.f === 1 && x.w === 2);   // 各 Request 的 land_ids 基本都是字段1
            if (li) {
                let i = 0; const b = Buffer.from(li.v);
                while (i < b.length) {
                    let v = 0, s = 0, c;
                    do { c = b[i++]; v += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80);
                    landIds.push(v);
                }
            }
        } catch (e) { /* 忽略 */ }
        calls.push({ key, method, landIds, len: raw.length });
        if (customHandler) {
            const handled = await customHandler({ key, service, method, body: raw });
            if (handled) return handled;
        }
        // 按方法名返回对应的空 Reply —— 调用方会 decode, 回错内容会抛解析异常
        const replyType = types[`${method}Reply`];
        if (replyType && typeof replyType.encode === 'function') {
            return { body: replyType.encode(replyType.create({})).finish() };
        }
        return { body: Buffer.alloc(0) };
    };

    const farm = require(`${SB}/src/services/farm`);
    const last = () => calls[calls.length - 1];

    section('1. 各种操作分发到正确的方法(land_ids 正确)');
    {
        const cases = [
            ['water', 'WaterLand', '浇水'],
            ['weed', 'WeedOut', '除草'],
            ['bug', 'Insecticide', '除虫'],
            ['harvest', 'Harvest', '收获'],
            ['clear', 'RemovePlant', '铲除'],
            ['upgrade', 'UpgradeLand', '升级土地'],
            ['unlock', 'UnlockLand', '解锁土地'],
        ];
        for (const [op, method, action] of cases) {
            calls.length = 0;
            const r = await farm.operateSingleLand({ landId: 7, op }).catch(e => ({ ok: false, err: e.message }));
            check(`${op} → ${method}`, last() && last().method === method, { calls: calls.map(c => c.method), r });
            check(`${op} 的动作名 = ${action}`, r && r.action === action, r);
        }
    }

    section('2. 施肥: Fertilize + 化肥ID(默认普通化肥)');
    {
        calls.length = 0;
        const r = await farm.operateSingleLand({ landId: 3, op: 'fertilize' }).catch(e => ({ ok: false, err: e.message }));
        check('走 Fertilize', last() && last().method === 'Fertilize', calls.map(c => c.method));
        check('返回施肥结果', r && r.action === '施肥', r);
        calls.length = 0;
        await farm.operateSingleLand({ landId: 3, op: 'fertilize', fertilizerId: 80011 }).catch(() => null);
        check('指定有机肥也走 Fertilize', last() && last().method === 'Fertilize', calls.map(c => c.method));
    }

    section('3. 种植: 必须给种子, 走 Plant');
    {
        calls.length = 0;
        const bad = await farm.operateSingleLand({ landId: 9, op: 'plant' }).catch(e => ({ ok: false, err: e.message }));
        check('没给种子 → 报错', bad && bad.ok === false && /种子/.test(bad.err), bad);
        check('没给种子 → 不发请求', calls.filter(c => c.method === 'Plant').length === 0, calls.map(c => c.method));

        calls.length = 0;
        const ok = await farm.operateSingleLand({ landId: 9, op: 'plant', seedId: 20002 }).catch(e => ({ ok: false, err: e.message }));
        check('给了种子 → 走 Plant', last() && last().method === 'Plant', calls.map(c => c.method));
        check('种植动作名', ok && ok.action === '种植', ok);
    }

    section('4. 参数校验');
    {
        const noLand = await farm.operateSingleLand({ op: 'water' }).catch(e => ({ ok: false, err: e.message }));
        check('缺 landId → 报错', noLand && noLand.ok === false && /地块/.test(noLand.err), noLand);
        const noOp = await farm.operateSingleLand({ landId: 1 }).catch(e => ({ ok: false, err: e.message }));
        check('缺 op → 报错', noOp && noOp.ok === false && /操作/.test(noOp.err), noOp);
        const unknown = await farm.operateSingleLand({ landId: 1, op: 'nonsense' }).catch(e => ({ ok: false, err: e.message }));
        check('未知 op → 报错且列出', unknown && unknown.ok === false && /不支持/.test(unknown.err), unknown);
    }

    section('5. 2026-11-02 蓝晶土地与自动升级(服务端不再下发 could_upgrade)');
    {
        /**
         * 真实抓包 20261102-110136 的 #8 结构:
         *   #1 类型=1  #2 需要农场主等级  #3 repeated {#1 物品ID, #2 数量}
         * 抓包账号 Lv118, 24 块地全部 could_upgrade=false 但等级已满 240、可升 6 级。
         */
        const landInfo = (o = {}) => ({
            id: o.id || 1,
            unlocked: o.unlocked !== false,
            level: o.level === undefined ? 5 : o.level,
            max_level: o.max_level === undefined ? 6 : o.max_level,
            could_upgrade: false, // 服务端已停止下发, 固定为 false
            upgrade_condition: o.needLevel
                ? {
                    type: 1,
                    need_level: o.needLevel,
                    costs: (o.costs || []).map(([itemId, amount]) => ({ item_id: itemId, amount })),
                }
                : undefined,
        });
        const allLandsReply = (lands) => Buffer.from(
            types.AllLandsReply.encode(types.AllLandsReply.create({ lands })).finish(),
        );
        const upgradeReply = (land) => Buffer.from(
            types.UpgradeLandReply.encode(types.UpgradeLandReply.create({ land })).finish(),
        );
        const plantCallNames = () => calls.filter(c => c.key === 'gamepb.plantpb.PlantService.UpgradeLand').length;

        // 直接复用 operateSingleLand 的 upgrade 分支取到分析结果不方便, 这里用 runFarmOperation('upgrade')
        // 走完整流程: AllLands → analyzeLands → UpgradeLand。
        const installHandler = (lands) => {
            customHandler = async ({ method, body }) => {
                if (method === 'AllLands') return { body: allLandsReply(lands) };
                if (method === 'UpgradeLand') {
                    const landId = Number(require(`${SB}/src/services/mengchong`).parseTop(body)[0].v);
                    const target = lands.find(l => Number(l.id) === landId) || { id: landId, unlocked: true };
                    return { body: upgradeReply({ ...target, level: Number(target.level || 0) + 1 }) };
                }
                return null;
            };
        };
        const runUpgrade = async (lands) => {
            installHandler(lands);
            calls.length = 0;
            return farm.runFarmOperation('upgrade');
        };

        const state = net.getUserState();
        try {
            // 抓包账号: 农场主 Lv118, 需求 Lv125 → 不能升级, 也不能发 UpgradeLand
            state.level = 118;
            state.gold = 999999999999;
            state.goldBean = 999999;
            await runUpgrade([
                landInfo({ id: 1, level: 5, max_level: 6, needLevel: 125, costs: [[1001, 100000000], [1005, 11350]] }),
            ]);
            check('农场主等级不足时优先跳过升级(不发 UpgradeLand)',
                plantCallNames() === 0, calls.map(c => c.method));

            // 等级达标但金豆豆不足
            state.level = 130;
            state.gold = 999999999999;
            state.goldBean = 100;
            await runUpgrade([
                landInfo({ id: 1, level: 5, max_level: 6, needLevel: 125, costs: [[1001, 100000000], [1005, 11350]] }),
            ]);
            check('金豆豆不足时同样跳过升级',
                plantCallNames() === 0, calls.map(c => c.method));

            // 等级与货币都满足 → 真正发送 UpgradeLand
            state.level = 130;
            state.gold = 200000000;
            state.goldBean = 20000;
            const detail = await farm.getLandsDetail();
            const lv5 = detail.lands.find(l => l.id === 1);
            check('等级与金币/金豆豆都满足时 canUpgrade=true',
                lv5 && lv5.canUpgrade === true && lv5.couldUpgrade === false
                && /农场主 Lv125/.test(lv5.upgradeCostText)
                && /金币 100000000/.test(lv5.upgradeCostText)
                && /金豆豆 11350/.test(lv5.upgradeCostText),
                lv5);

            await runUpgrade([
                landInfo({ id: 1, level: 5, max_level: 6, needLevel: 125, costs: [[1001, 100000000], [1005, 11350]] }),
            ]);
            check('满足条件时自动升级并发送 UpgradeLand',
                plantCallNames() === 1, calls.map(c => c.method));

            // 满级地块没有 #8, 不应再升级
            state.level = 240;
            await runUpgrade([landInfo({ id: 1, level: 6, max_level: 6 })]);
            check('满级地块不带升级条件也不会发 UpgradeLand',
                plantCallNames() === 0, calls.map(c => c.method));

            // 蓝晶土地(等级 6)是独立土地类型, 施肥白名单要能单独勾选
            const store = require(`${SB}/src/models/store`);
            store.applyConfigSnapshot({
                automation: { fertilizer: 'normal', fertilizer_land_types: ['blue'] },
            }, { accountId: process.env.FARM_ACCOUNT_ID });
            installHandler([landInfo({ id: 1, level: 6, max_level: 6 }), landInfo({ id: 2, level: 5, max_level: 6 })]);
            calls.length = 0;
            await farm.runFertilizerByConfig([1, 2], { reason: 'normal' });
            const fertilize = calls.filter(c => c.method === 'Fertilize').pop();
            const fertilizedIds = fertilize ? fertilize.landIds : [];
            check('蓝晶土地(等级6)可单独作为施肥范围', fertilizedIds.join(',') === '1', {
                fertilizedIds,
                calls: calls.map(c => c.method),
            });
            store.applyConfigSnapshot({ automation: { fertilizer: 'none', fertilizer_land_types: ['blue', 'amethyst', 'gold', 'black', 'red', 'normal'] } }, { accountId: process.env.FARM_ACCOUNT_ID });
        } finally {
            customHandler = null;
            state.level = 0;
            state.gold = 0;
            state.goldBean = 0;
        }
    }

    finish();
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
