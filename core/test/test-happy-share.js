/**
 * 快乐不独享（新活动）回归测试 —— 回放真实抓包
 *
 * 抓包1(S3): 20260924-203415_快乐不独享.jsonl   命令 69/73/70
 * 抓包2(S4): 20261015-154340_奶茶新活动.jsonl   命令 70/74/71(换期后命令号轮换了!)
 *   → 服务内按活动期配置命令号(SEASONS), 本测试两期都回放
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

// S4 期(2026110104)抓包: 命令号轮换成 70(打开)/74(领快乐值)/71(领档位)
const CAP4 = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261015-154340_奶茶新活动.jsonl');
const FRAMES4 = loadFrames(CAP4);
const F4 = {
    OPEN: FRAMES4.find(f => f.idx === 175),    // 快乐值 5, 档位未达成
    HAPPY: FRAMES4.find(f => f.idx === 177),   // 快乐值 10, 档位1 可领
    TIER: FRAMES4.find(f => f.idx === 262),    // 档位1 已领
};

// 2026-11-04 更新公告后的抓包: 档位扩到 8 档(80/110/130/150 起给奶茶券惊喜礼包),
// 一次 cmd=71 把档位5+6 一起领掉, #154 返回两条奖励
const CAP5 = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261105-010541_快乐不独享新.jsonl');
const FRAMES5 = loadFrames(CAP5);
const LIST5 = FRAMES5.find(f => f.idx === 52);   // ActivityService.List, 含 8 档状态
const F5 = {
    TIER: FRAMES5.find(f => f.idx === 129),       // cmd=71 回应: 档位5/6 变已领, #154 两条奖励
};

let phase = 0;                    // S3: 0:未领 1:已领快乐值 2:档位也领了
let phase4 = 0;                   // S4: 同上
let phase5 = 0;                   // 2026-11-05 新版: 0:档位5/6可领 2:已领
let stubMode = 'legacy';          // legacy = 旧两期抓包; multi = 2026-11-05 新版(一次领多档)
const calls = [];

/** 装网络桩: 必须在 require 服务模块之前调用 */
function installStub() {
    const protobuf = require('protobufjs');
    const { types } = require(`${SB}/src/utils/proto`);
    const bodyOfHex = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);
    // 把 List 快照里的快乐不独享活动体取出来(它就是 Operate 响应 #3 的内容)
    let happyActFromListCache;
    const happyActFromList = () => {
        if (happyActFromListCache === undefined) {
            const mgx = require(`${SB}/src/services/mengchong`);
            const list = mgx.parseTop(bodyOfHex(LIST5.hex)).find(x => x.f === 1).v;
            const hit = mgx.parseTop(list)
                .filter(x => x.f === 2 && x.w === 2)
                .find((e) => {
                    const head = mgx.parseTop(mgx.parseTop(e.v)[0].v);
                    return Number((head.find(x => x.f === 1) || {}).v) === 2026110104;
                });
            happyActFromListCache = hit && hit.v;
        }
        return happyActFromListCache;
    };
    // 拼一个只有 #3(活动体) 的 Operate 响应
    const asOpenReply = (activityBuf) => {
        const w = protobuf.Writer.create();
        w.uint32((3 << 3) | 2).bytes(activityBuf);
        return w.finish();
    };
    const net = require(`${SB}/src/utils/network`);
    net.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        const mgx = require(`${SB}/src/services/mengchong`);
        const fsx = mgx.parseTop(Buffer.from(body));
        const group = Number((fsx.find(f => f.f === 1) || {}).v) || 0;
        const cmd = Number((fsx.find(f => f.f === 2) || {}).v) || 0;
        calls.push({ key, group, cmd, bodyLen: Buffer.from(body || []).length });
        if (key === OPERATE) {
            // ===== 2026-11-05 新版(8 档): 「一次请求领完所有可领档位」回放 =====
            if (stubMode === 'multi') {
                if (cmd === 70) {
                    // phase5=0: List 快照(档位5/6 可领) → 已有的活动体, 再包一层 #3;
                    // 否则直接用领档回应的完整 body(它自带 #3, 不能再包)
                    return { body: phase5 === 0 ? asOpenReply(happyActFromList()) : bodyOfHex(F5.TIER.hex) };
                }
                if (cmd === 74) { phase5 = 1; throw new Error('新版回放不走 cmd=74'); }
                if (cmd === 71) { phase5 = 2; return { body: bodyOfHex(F5.TIER.hex) }; }
                throw new Error('新版桩未 stub 的 cmd: ' + cmd);
            }
            // ===== S4 期(2026110104): 命令号 70/74/71 =====
            if (group === 2026110104) {
                if (cmd === 70) return { body: bodyOfHex([F4.OPEN, F4.HAPPY, F4.TIER][phase4].hex) };
                if (cmd === 74) { phase4 = 1; return { body: bodyOfHex(F4.HAPPY.hex) }; }
                if (cmd === 71) { phase4 = 2; return { body: bodyOfHex(F4.TIER.hex) }; }
                throw new Error('S4 未 stub 的 cmd: ' + cmd);
            }
            // ===== S3 期(2026092501): 命令号 69/73/70/71 =====
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
    // ⚠ 必须在打桩之后 require 服务, 否则 mengchong 会拿到真实 sendMsgAsync
    // 默认活动期是 S4; 前 8 节回放的是 S3 抓包 → 显式指定 S3
    happy.setSeason(2026092501);
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

    section('9. S4 期(2026110104) 命令号轮换回放 —— 修 1034004 活动参数错误');
    {
        check('抓到 S4 三个关键帧', !!F4.OPEN && !!F4.HAPPY && !!F4.TIER);

        happy.setSeason(2026110104);
        check('活动期切到 S4', happy.getActiveSeason().group === 2026110104, happy.getActiveSeason());
        check('S4 命令号 = 打开70/领快乐值74/领档位71',
            happy.getActiveSeason().open === 70 && happy.getActiveSeason().claimHappy === 74 && happy.getActiveSeason().claimTier === 71,
            happy.getActiveSeason());

        phase4 = 0;
        calls.length = 0;
        const st4 = await happy.getHappyStatus();
        check('S4 读状态用 cmd=70(不是 S3 的 69)', calls.some(c => c.group === 2026110104 && c.cmd === 70), calls.map(c => `${c.group}:${c.cmd}`));
        check('S4 快乐值 = 5', st4.happy === 5, st4.happy);
        check('S4 档位数 = 4(门槛 10/20/30/60)',
            st4.tiers.length === 4 && st4.tiers[3].need === 60, st4.tiers.map(t => t.need));

        const daily4 = await happy.claimDailyHappy();
        check('S4 领快乐值用 cmd=74', calls.some(c => c.cmd === 74), calls.map(c => c.cmd));
        check('S4 快乐值 5 → 10', daily4.ok === true && daily4.gained === 5, daily4);

        const tier4 = await happy.claimTierRewards();
        check('S4 领档位用 cmd=71', calls.some(c => c.cmd === 71), calls.map(c => c.cmd));
        check('S4 领到档位1(化肥4小时×1)',
            tier4.ok === true && tier4.claimed.length === 1 && tier4.claimed[0].reward && tier4.claimed[0].reward.id === 80002,
            tier4.claimed);

        happy.setSeason(2026092501);   // 还原
    }

    section('10. 2026-11-04 更新公告: 8 档 + 一次领取多档 + 奶茶券惊喜礼包');
    {
        check('抓包含 List 快照与领档回应', !!LIST5 && !!F5.TIER);

        stubMode = 'multi';
        phase5 = 0;
        happy.setSeason(2026110104);
        calls.length = 0;

        const st = await happy.getHappyStatus();
        check('识别新版活动', st.ok === true, st);
        check('快乐值 = 110', st.happy === 110, st.happy);
        check('档位扩到 8 档', st.tiers.length === 8, st.tiers.length);
        check('门槛 10/20/30/60/80/110/130/150',
            JSON.stringify(st.tiers.map(t => t.need)) === JSON.stringify([10, 20, 30, 60, 80, 110, 130, 150]),
            st.tiers.map(t => t.need));
        check('档位3 改成 宣传喇叭×5(不再是点券×50)',
            st.tiers[2].itemId === 1042 && st.tiers[2].count === 5, st.tiers[2]);
        check('档位5/6 奖励 = 奶茶券惊喜礼包×1(101616)',
            st.tiers[4].itemId === 101616 && st.tiers[5].itemId === 101616, [st.tiers[4], st.tiers[5]]);
        check('档位7/8 未达成(状态1)', st.tiers[6].status === 1 && st.tiers[7].status === 1, [st.tiers[6], st.tiers[7]]);
        check('可领档位 = 5、6', JSON.stringify(st.claimableTiers.map(t => t.tier)) === '[5,6]', st.claimableTiers);

        // #154 多条目解析(纯函数)
        {
            const fs = mg.parseTop(bodyOf(F5.TIER.hex));
            const hex = (fs.find(f => f.f === 154) || {}).v ? Buffer.from(fs.find(f => f.f === 154).v).toString('hex') : '';
            const list = happy.__testing.parseRewardResults(hex);
            check('#154 解析出 2 条奖励', list.length === 2, list);
            check('奖励 = 有机化肥(8小时)×1 + 有机化肥(12小时)×1',
                list[0] && list[0].id === 80013 && list[1] && list[1].id === 80014, list);
            check('parseRewardResult 兼容旧调用(只取第一条)', happy.__testing.parseRewardResult(hex).id === 80013, null);
        }

        // ⚠ 核心: 只发一次 cmd=71
        calls.length = 0;
        const r = await happy.claimTierRewards();
        check('领档位成功', r.ok === true, r);
        check('一次领到 2 个档位', r.claimed.length === 2, r.claimed);
        check('领的是档位5、6', JSON.stringify(r.claimed.map(c => c.tier)) === '[5,6]', r.claimed.map(c => c.tier));
        check('**只发了一次 cmd=71**(服务端一次领完)',
            calls.filter(c => c.group === 2026110104 && c.cmd === 71).length === 1, calls.map(c => `${c.group}:${c.cmd}`));
        check('到账 2 条奖励(80013/80014)',
            r.rewards.length === 2 && r.rewards[0].id === 80013 && r.rewards[1].id === 80014, r.rewards);
        check('复核后档位5/6 = 已领(状态3)', r.claimedTiers.includes(5) && r.claimedTiers.includes(6), r.claimedTiers);
        check('复核标志 verified', r.verified === true, r.verified);

        // 再跑一次: 没有可领档位 → 跳过且不发请求
        calls.length = 0;
        const r2 = await happy.claimTierRewards();
        check('无可领档位时跳过', r2.ok === true && r2.skipped === true, r2);
        check('跳过时不发 cmd=71', calls.filter(c => c.cmd === 71).length === 0, calls.map(c => c.cmd));

        stubMode = 'legacy';
        phase5 = 0;
        happy.setSeason(2026092501);
    }

    section('11. 2026-11-07 抓包: 领取请求体必须只有 group+cmd(修复"永远不自动领")');
    {
        // 真实客户端(2026-10-15 / 11-05 / 11-07 三次抓包)的快乐不独享 Operate 请求都是 **8 字节**:
        //   08 <group varint> 10 <cmd varint>  —— 不带任何 payload 字段
        // 对照: 同一个抓包里奶茶活动(2026110101)的 cmd 63/55/58 都带 payload(11 字节),
        //       说明"带空 payload"只在快乐不独享这里是错的。
        const CAP7 = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261107-112023_典藏室和快乐独享领取.decoded.jsonl');
        const raw = fs.readFileSync(CAP7, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        const ops = raw.filter(j => j.key.endsWith('ActivityService.Operate') && j.dir === 'C->S');
        const mgx = require(`${SB}/src/services/mengchong`);
        const bodyOfOp = (o) => Buffer.from(o.bodyHex || '', 'hex');
        const groupOf = (b) => Number((mgx.parseTop(b).find(x => x.f === 1) || {}).v || 0);

        const happyOps = ops.filter(o => groupOf(bodyOfOp(o)) === 2026110104);
        check('抓包里有快乐不独享的 Operate 请求', happyOps.length > 0, ops.map(o => groupOf(bodyOfOp(o))));
        check('快乐不独享请求体全是 8 字节(只有 group+cmd)',
            happyOps.every(o => bodyOfOp(o).length === 8), happyOps.map(o => bodyOfOp(o).length));
        check('这些请求确实只有 #1 group + #2 cmd 两个字段',
            happyOps.every((o) => {
                const fsx = mgx.parseTop(bodyOfOp(o));
                return fsx.length === 2 && fsx[0].f === 1 && fsx[1].f === 2;
            }), happyOps.map(o => mgx.parseTop(bodyOfOp(o)).map(x => x.f)));

        // 对照组: 同样方法看奶茶活动 → 是带 payload 的 11 字节, 证明不是"抓包丢字段"
        const milkOps = ops.filter(o => groupOf(bodyOfOp(o)) === 2026110101);
        check('对照: 奶茶活动请求带 payload(11 字节)', milkOps.some(o => bodyOfOp(o).length === 11), milkOps.map(o => bodyOfOp(o).length));

        // 服务层: 打开活动发出的请求必须是 8 字节(桩里记了 bodyLen)
        happy.setSeason(2026110104);
        stubMode = 'multi';
        phase5 = 0;
        calls.length = 0;
        await happy.getHappyStatus();
        const opCalls = calls.filter(c => c.key === OPERATE);
        check('getHappyStatus 发出的 Operate 请求 8 字节',
            opCalls.length > 0 && opCalls.every(c => c.bodyLen === 8), opCalls.map(c => c.bodyLen));
        check('打开活动用 cmd=70', opCalls.some(c => c.cmd === 70), opCalls.map(c => c.cmd));

        stubMode = 'legacy';
        phase5 = 0;
        happy.setSeason(2026092501);
    }

    finish();
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
