/**
 * 快乐不独享（新活动）回归测试 —— 回放真实抓包
 *
 * 抓包: 20260924-203415_快乐不独享.jsonl
 *   快乐值 5(--cmd69) → 10(--cmd73 领每日快乐值) → 档位1 状态 1→2→3(--cmd70 领档位奖励)
 *
 * 覆盖:
 *   1. 状态解析: 快乐值 / 档位表(门槛、奖励、状态) / 活动头待领标记
 *   2. claimDailyHappy: cmd=73 后用"快乐值是否增加"校验
 *   3. claimTierRewards: 只领状态=2 的档位, 解析结果里的奖励
 *   4. checkAndRunHappyShare: 整体流程(69 → 73 → 70) 且不误报成功
 *
 * 运行: node test/test-happy-share.js
 */
const path = require('node:path');
const fs = require('node:fs');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'happy-test';
isolateDataDir(SB, 'happy-test');

const CAP = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20260924-203415_快乐不独享.jsonl');

function loadFrames(file) {
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.ev || j.dir !== 'S->C' || !j.hex) continue;
        out.push(j);
    }
    return out;
}
const FRAMES = loadFrames(CAP);
const OPERATE = 'gamepb.activitypb.ActivityService.Operate';
// 抓包里这次操作的三个关键状态帧: idx=96(快乐值5) / 114(10) / 125(档位已领)
const F_OPEN = FRAMES.find(f => f.idx === 96);
const F_SHARE = FRAMES.find(f => f.idx === 114);
const F_TIER = FRAMES.find(f => f.idx === 125);
const F_PACK = FRAMES.find(f => f.idx === 130);

let phase = 0;                    // 0:未领 1:已领快乐值 2:档位也领了
const calls = [];

/** 装网络桩: 必须在 require 服务模块之前调用 */
function installStub() {
    const { types } = require(`${SB}/src/utils/proto`);
    const bodyOfHex = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);
    const net = require(`${SB}/src/utils/network`);
    net.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        const mg0 = require(`${SB}/src/services/mengchong`);
        const cmd = Number((mg0.parseTop(Buffer.from(body)).find(f => f.f === 2) || {}).v) || 0;
        calls.push({ key, cmd });
        if (key === OPERATE) {
            if (cmd === 69) return { body: bodyOfHex([F_OPEN, F_SHARE, F_TIER][phase].hex) };
            if (cmd === 73) { phase = 1; return { body: bodyOfHex(F_SHARE.hex) }; }
            if (cmd === 70) { phase = 2; return { body: bodyOfHex(F_TIER.hex) }; }
            if (cmd === 71) return { body: bodyOfHex(F_PACK.hex) };
            throw new Error('未 stub 的 cmd: ' + cmd);
        }
        if (/Share/.test(method)) return { body: Buffer.alloc(0) };
        throw new Error('未 stub 的接口: ' + key);
    };
}


(async () => {
    const { types } = require(`${SB}/src/utils/proto`);
    await require(`${SB}/src/utils/proto`).loadProto();
    // ⚠ 服务模块在 require 时就解构了 network 的 sendMsgAsync/operateRaw 用的引用,
    //   所以必须"先打桩再 require 服务"(沿用 test-buy-book 记过的坑)
    installStub();
    const mg = require(`${SB}/src/services/mengchong`);
    const happy = require(`${SB}/src/services/happy-share`);
    const bodyOf = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);
    const activityOf = (frame) => {
        const fs = mg.parseTop(bodyOf(frame.hex));
        return (fs.find(f => f.f === 3) || {}).v;
    };
    // ⚠ 不要再在这里声明 phase: 会遮蔽模块级的那个, 而桩读的是模块级的(踩过)

    section('1. 状态解析: 快乐值 + 档位表');
    {
        const st0 = happy.__testing.parseHappyState(activityOf(F_OPEN));
        check('活动识别', st0.ok === true, st0);
        check('快乐值 = 5', st0.happy === 5, st0.happy);
        check('档位数 = 4', st0.tiers.length === 4, st0.tiers.length);
        check('档位门槛 10/20/30/60', JSON.stringify(st0.tiers.map(t => t.need)) === JSON.stringify([10, 20, 30, 60]), st0.tiers.map(t => t.need));
        check('档位1 奖励 = 化肥(4小时)×1', st0.tiers[0].itemId === 80002 && st0.tiers[0].count === 1, st0.tiers[0]);
        check('档位3 奖励 = 点券×50', st0.tiers[2].itemId === 1002 && st0.tiers[2].count === 50, st0.tiers[2]);
        check('未达门槛时状态都是 1', st0.tiers.every(t => t.status === 1), st0.tiers.map(t => t.status));

        const st1 = happy.__testing.parseHappyState(activityOf(F_SHARE));
        check('领完快乐值后 快乐值 = 10', st1.happy === 10, st1.happy);
        check('档位1 变为"可领"(状态2)', st1.tiers[0].status === 2, st1.tiers[0]);
        check('档位2 仍未达成(状态1)', st1.tiers[1].status === 1, st1.tiers[1]);

        const st2 = happy.__testing.parseHappyState(activityOf(F_TIER));
        check('领完档位后 档位1 状态=3(已领)', st2.tiers[0].status === 3, st2.tiers[0]);
    }

    section('2. 奖励结果解析');
    {
        const fs = mg.parseTop(bodyOf(F_TIER.hex));
        const hex = (fs.find(f => f.f === 154) || {}).v ? Buffer.from(fs.find(f => f.f === 154).v).toString('hex') : '';
        const reward = happy.__testing.parseRewardResult(hex);
        check('#154 解析出奖励 化肥(4小时)×1', reward && reward.id === 80002 && reward.count === 1, reward);
        check('奖励带名称', !!(reward && reward.name.includes('化肥')), reward && reward.name);
    }

    section('3. 读状态 / 领每日快乐值');
    {
        phase = 0;
        calls.length = 0;
        const st = await happy.getHappyStatus();
        check('getHappyStatus: 快乐值 5', st.ok && st.happy === 5, st);
        check('读了活动(cmd=69)', calls.filter(c => c.cmd === 69).length === 1, calls.map(c => c.cmd));

        calls.length = 0;
        const daily = await happy.claimDailyHappy();
        check('领快乐值成功', daily.ok === true, daily);
        check('涨了 5 点', daily.gained === 5, daily.gained);
        check('调的还是 cmd=73', calls.filter(c => c.cmd === 73).length === 1, calls.map(c => c.cmd));

        // 再领一次(已领过) → 不应误报成功
        const again = await happy.claimDailyHappy();
        check('重复领取不误报成功', again.ok === false, again);
    }

    section('4. 领取档位奖励(只领状态=2 的)');
    {
        phase = 1;                       // 快乐值 10, 档位1 可领
        calls.length = 0;
        const r = await happy.claimTierRewards();
        check('领到 1 个档位', r.ok === true && r.claimed.length === 1, r);
        check('领的是档位1', r.claimed[0] && r.claimed[0].tier === 1, r.claimed);
        check('奖励 = 化肥(4小时)×1', r.claimed[0] && r.claimed[0].reward && r.claimed[0].reward.id === 80002, r.claimed[0]);
        check('发了 cmd=70', calls.filter(c => c.cmd === 70).length === 1, calls.map(c => c.cmd));

        phase = 2;                       // 都领完了
        calls.length = 0;
        const r2 = await happy.claimTierRewards();
        check('没有可领档位时跳过', r2.ok === true && r2.skipped === true, r2);
        check('跳过时不发 cmd=70', calls.filter(c => c.cmd === 70).length === 0, calls.map(c => c.cmd));
    }

    section('5. 完整流程');
    {
        phase = 0;
        calls.length = 0;
        const r = await happy.checkAndRunHappyShare();
        check('流程 ok', r.ok === true, r);
        check('领到每日快乐值', r.daily && r.daily.ok === true, r.daily);
        check('领到档位奖励', !!(r.tiers && r.tiers.claimed && r.tiers.claimed.length), r.tiers);
        const cmds = calls.map(c => c.cmd);
        check('用到 69/73/70', cmds.includes(69) && cmds.includes(73) && cmds.includes(70), cmds);
    }

    finish();
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
