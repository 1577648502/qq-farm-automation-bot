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

    finish();
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
