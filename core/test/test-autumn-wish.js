/**
 * 秋祈良愿（新活动）回归测试 —— 用两份真实抓包回放
 *
 * 覆盖:
 *   1. GetGroup 状态解析: 有奖未领(#119/#23) vs 领完消失
 *   2. claimWishReward: cmd=51 → 51 响应 #151 解析奖励; cmd=52 → #152 解析奖励
 *   3. checkAndClaimAutumnWish: 有奖→领取→复核红点消失; 无奖→跳过(幂等)
 *   4. useFirework: 自己家(ItemService.Use) / 好友家(Visit.Enter → Use → Leave)
 *
 * 运行: node test/test-autumn-wish.js
 */
const path = require('node:path');
const fs = require('node:fs');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'autumn-test';
isolateDataDir(SB, 'autumn-test');

const CAP1 = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20260924-144947_新活动.jsonl');
const CAP2 = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20260924-155538_新活动1.jsonl');
const CAP3 = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20260925-080639_秋祈良愿.jsonl');
const { decodeFrame } = require('../scripts/ws-frame-lib');

/** 读取抓包里的帧: 返回 { key: [ {idx, hex} ] } */
function loadFrames(file) {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.ev || j.dir !== 'S->C' || !j.hex) continue;
        (out[j.key] = out[j.key] || []).push({ idx: j.idx, hex: j.hex });
    }
    return out;
}
const F1 = loadFrames(CAP1);
const F2 = loadFrames(CAP2);
const F3 = loadFrames(CAP3);
const GET_GROUP = 'gamepb.activitypb.ActivityService.GetGroup';
const OPERATE = 'gamepb.activitypb.ActivityService.Operate';
const ITEM_USE = 'gamepb.itempb.ItemService.Use';
const VISIT_ENTER = 'gamepb.visitpb.VisitService.Enter';
const VISIT_LEAVE = 'gamepb.visitpb.VisitService.Leave';

(async () => {
    const { types } = require(`${SB}/src/utils/proto`);
    await require(`${SB}/src/utils/proto`).loadProto();

    const calls = [];
    let getGroupSeq = [];       // 按顺序回放 GetGroup 帧
    let useReplyHex = null;
    let rejectWishIndex = 0;    // >0 时: 带这个编号的祈愿请求会被"服务端"拒绝(测自动试探)
    const wishIdxTried = [];
    const bodyOf = (hex) => {
        const msg = types.GateMessage.decode(Buffer.from(hex, 'hex'));
        return Buffer.from(msg.body || []);
    };

    const net = require(`${SB}/src/utils/network`);
    net.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        calls.push({ key, body });
        if (key === GET_GROUP) {
            const hex = getGroupSeq.length > 1 ? getGroupSeq.shift() : getGroupSeq[0];
            if (!hex) throw new Error('没有可回放的 GetGroup 帧');
            return { body: bodyOf(hex) };
        }
        if (key === OPERATE) {
            // 根据请求里的 cmd(字段2)挑响应: 51→idx104, 52→idx111
            const reqFields = require(`${SB}/src/services/mengchong`).parseTop(Buffer.from(body));
            const cmd = Number((reqFields.find(f => f.f === 2) || {}).v) || 0;
            // 记录愿望编号, 并在需要时模拟"参数错误"(服务在 require 时已绑定本桩, 所以只能在这里模拟)
            const pl = reqFields.find(f => f.f === cmd + 100);
            if (pl && pl.w === 2) {
                const idx = Buffer.from(pl.v)[1];
                wishIdxTried.push({ cmd, idx });
                if (rejectWishIndex > 0 && idx === rejectWishIndex) {
                    throw new Error(`Operate 错误: code=1000020 请求参数错误(愿望编号 ${idx})`);
                }
            }
            const want = cmd === 51 ? 104 : (cmd === 52 ? 111 : 0);
            const hit = (F1[OPERATE] || []).find(x => x.idx === want);
            if (!hit) throw new Error(`没有 cmd=${cmd} 的响应帧`);
            return { body: bodyOf(hit.hex) };
        }
        if (key === ITEM_USE) {
            if (!useReplyHex) throw new Error('没有可回放的 Use 帧');
            return { body: bodyOf(useReplyHex) };
        }
        if (key === VISIT_ENTER) return { body: Buffer.alloc(0) };
        if (key === VISIT_LEAVE) return { body: Buffer.alloc(0) };
        throw new Error('未 stub 的接口: ' + key);
    };

    const wish = require(`${SB}/src/services/autumn-wish`);

    section('1. 状态解析: 有奖未领 vs 领完');
    {
        const pendingHex = (F1[GET_GROUP] || []).find(x => x.idx === 68).hex;
        const clearedHex = (F1[GET_GROUP] || []).find(x => x.idx === 229).hex;
        const pending = wish.__testing.parseWishGroup(bodyOf(pendingHex));
        const cleared = wish.__testing.parseWishGroup(bodyOf(clearedHex));
        check('未领状态: 识别出活动', pending.ok && pending.name === '秋祈良愿', pending);
        check('未领状态: hasPending=true(#119 存在)', pending.hasPending === true, pending);
        check('未领状态: 待领标记 #23=1', pending.pendingFlag === 1, pending.pendingFlag);
        check('领完状态: hasPending=false', cleared.hasPending === false, cleared);
        check('领完状态: 活动名仍可读', cleared.name === '秋祈良愿', cleared.name);
    }

    section('2. 读取状态接口');
    {
        getGroupSeq = [(F1[GET_GROUP] || []).find(x => x.idx === 68).hex];
        const st = await wish.getWishStatus();
        check('getWishStatus: ok + 有奖', st.ok && st.hasPending === true, st);
    }

    section('3. 领取奖励: cmd=51 → cmd=52 → 奖励解析');
    {
        calls.length = 0;
        const r = await wish.claimWishReward();
        check('领取成功', r.ok === true, r);
        check('发了 2 次 Operate(51/52)', calls.filter(c => c.key === OPERATE).length === 2, calls.map(c => c.key));
        check('解析出烟花桶×20', r.rewards.some(x => x.id === 6001 && x.count === 20), r.rewards);
        check('奖励带名称', String(r.rewards[0] && r.rewards[0].name || '').includes('烟花桶'), r.rewards);
    }

    section('4. 完整流程 + 幂等');
    {
        // 第一次: 有待领 → 领取 → 复核已领
        getGroupSeq = [
            (F1[GET_GROUP] || []).find(x => x.idx === 68).hex,
            (F1[GET_GROUP] || []).find(x => x.idx === 229).hex,
        ];
        calls.length = 0;
        const r1 = await wish.checkAndClaimAutumnWish();
        check('有奖: 领取成功', r1.ok === true && r1.cleared === true, r1);
        check('有奖: 拿到奖励', (r1.rewards || []).length > 0, r1.rewards);
        check('有奖: 发了 Operate', calls.filter(c => c.key === OPERATE).length === 2, calls.length);

        // 第二次: 已领(红点消失) → 不发请求
        getGroupSeq = [(F1[GET_GROUP] || []).find(x => x.idx === 229).hex];
        calls.length = 0;
        const r2 = await wish.checkAndClaimAutumnWish();
        check('无奖: 跳过', r2.ok === true && r2.skipped === true, r2);
        check('无奖: 不发 Operate', calls.filter(c => c.key === OPERATE).length === 0, calls.length);

        // force: 即使没红点也试一次
        calls.length = 0;
        getGroupSeq = [(F1[GET_GROUP] || []).find(x => x.idx === 229).hex];
        const r3 = await wish.checkAndClaimAutumnWish(true);
        check('force: 仍然发起领取', calls.filter(c => c.key === OPERATE).length === 2, calls.length);
        check('force: 返回结构完整', typeof r3.ok === 'boolean' && !!r3.claim, Object.keys(r3));
    }

    section('5. 放烟花: 自己家');
    {
        const useFrame = (F1[ITEM_USE] || []).find(x => x.idx === 200) || (F2[ITEM_USE] || [])[0];
        useReplyHex = useFrame.hex;
        calls.length = 0;
        const r = await wish.useFirework({ mode: 'self' });
        check('自己家: ok', r.ok === true, r);
        check('自己家: 只调 Use, 不访问好友', calls.filter(c => c.key === ITEM_USE).length === 1
            && calls.filter(c => c.key === VISIT_ENTER).length === 0, calls.map(c => c.key));
        check('自己家: 用的是烟花桶 6001', r.itemId === 6001, r.itemId);
    }

    section('6. 放烟花: 好友家(Enter → Use → Leave)');
    {
        const f = (F2[VISIT_ENTER] || [])[0];
        check('抓包里有 Visit.Enter 帧', !!f);
        calls.length = 0;
        const r = await wish.useFirework({ mode: 'friend', friendGid: 1253397809 });
        check('好友家: ok', r.ok === true, r);
        const order = calls.map(c => c.key);
        check('好友家: Enter → Use → Leave 顺序', JSON.stringify(order) === JSON.stringify([VISIT_ENTER, ITEM_USE, VISIT_LEAVE]), order);
        check('好友家: 目标 gid 正确', r.friendGid === 1253397809, r.friendGid);
    }

    section('7. 请求必须带愿望编号(2026-09-25 解开上行后确认)');
    {
        check('payload 编码 = {#1: 4} → hex 0804', wish.encodeWishPayload(4).toString('hex') === '0804', wish.encodeWishPayload(4).toString('hex'));
        check('payload 编码 = {#1: 1} → hex 0801', wish.encodeWishPayload(1).toString('hex') === '0801');

        // 用桩记录的 body 校验"我们发出去的请求确实带了编号"
        const mgx = require(`${SB}/src/services/mengchong`);
        getGroupSeq = [(F1[GET_GROUP] || []).find(x => x.idx === 68).hex];
        calls.length = 0;
        const r = await wish.claimWishReward();
        const sent = calls.filter(c => c.key === OPERATE).map((c) => {
            const f = mgx.parseTop(Buffer.from(c.body));
            const cmd = Number((f.find(x => x.f === 2) || {}).v) || 0;
            const payload = f.find(x => x.f === cmd + 100);
            return { cmd, payloadHex: payload && payload.w === 2 ? Buffer.from(payload.v).toString('hex') : '' };
        });
        check('领取成功(带参数)', r.ok === true, r);
        check('cmd=51 带 {#1:4} (hex 0804)', sent.some(x => x.cmd === 51 && x.payloadHex === '0804'), sent);
        check('cmd=52 带 {#1:4} (hex 0804)', sent.some(x => x.cmd === 52 && x.payloadHex === '0804'), sent);
        check('记下可用编号 = 4', wish.getWorkingWishIndex() === 4, wish.getWorkingWishIndex());

        // 编号被拒时自动换下一个(桩把编号 4 判为"参数错误")
        wishIdxTried.length = 0;
        rejectWishIndex = 4;
        getGroupSeq = [(F1[GET_GROUP] || []).find(x => x.idx === 68).hex];
        const r2 = await wish.claimWishReward(4).catch(() => null);
        rejectWishIndex = 0;
        check('编号被拒后自动换到别的编号', wishIdxTried.some(x => x.idx !== 4), wishIdxTried.slice(0, 5));
        check('换编号后最终领取成功', !!(r2 && r2.ok), r2 && (r2.reason || r2.ok));
    }

    section('8. 今天(09-25)的真实响应: 奖励 26030×48');
    {
        const mgx = require(`${SB}/src/services/mengchong`);
        const f151 = (F3[OPERATE] || []).find(x => x.idx === 101);
        const f152 = (F3[OPERATE] || []).find(x => x.idx === 105);
        check('抓到今天的 51/52 响应', !!f151 && !!f152);
        const rewardOf = (frame, fieldNo) => {
            const fsx = mgx.parseTop(bodyOf(frame.hex));
            const fld = fsx.find(x => x.f === fieldNo);
            if (!fld || fld.w !== 2) return null;
            return wish.__testing.parseRewardFromResult(Buffer.from(fld.v).toString('hex'));
        };
        const rw51 = f151 ? rewardOf(f151, 151) : null;
        const rw52 = f152 ? rewardOf(f152, 152) : null;
        check('#151 解析出 26030×48', !!rw51 && rw51.length === 1 && rw51[0].id === 26030 && rw51[0].count === 48, rw51);
        check('#152 解析出 26030×48', !!rw52 && rw52.length === 1 && rw52[0].id === 26030 && rw52[0].count === 48, rw52);

        const before = wish.__testing.parseWishGroup(bodyOf((F3[GET_GROUP] || []).find(x => x.idx === 68).hex));
        check('今天领取前 hasPending = true', before.hasPending === true, before);
        check('领取前 #23 待领标记 = 1', before.pendingFlag === 1, before.pendingFlag);

        // cmd=51 的响应里会回显愿望编号(#119.#3.#1 = 4) → 下次可直接复用, 省去试探
        const echo = wish.__testing.parseWishGroup(bodyOf(f151.hex));
        check('从状态回读到愿望编号 4', echo.echoWishIndex === 4, echo);
    }


    finish();
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
