/**
 * 红包每日领取 回归测试
 *
 * 背景: redpacketpb 的 .proto 和 types 导出在仓库里躺了很久, 但 services 里
 * **一次都没调用** —— GetTodayClaimStatus / ClaimRedPacket 从未发送过。
 * 于是每天都白丢一次可领红包。这个测试锁住三件事:
 *
 *   1) 状态解析: 每个红包独立 can_claim, 只领可领的那些;
 *   2) 单个红包领取失败不能影响其余(尤其"已领取"要当成功处理);
 *   3) 领完之后当天不再请求(避免每 20 分钟空转刷服务端)。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'redpacket-test';
isolateDataDir(SB, 'redpacket-test');

const proto = require(`${SB}/src/utils/proto`);
const network = require(`${SB}/src/utils/network`);
const { types } = require(`${SB}/src/utils/proto`);

/**
 * 造一个响应 body。
 * ⚠ sendMsgAsync 返回的 body 已经是**业务层明文**(GateMessage 外壳已经被 network 剥掉),
 *   所以这里直接编码业务消息, 不要再包一层 GateMessage。
 */
function frameOf(service, method, payloadType, payload) {
    return payloadType.encode(payloadType.create(payload)).finish();
}

const SERVICE = 'gamepb.redpacketpb.RedPacketService';

/**
 * 取一个"全新"的红包服务实例。
 * 服务用模块级变量记当日状态, 直接 require 会让上一个用例的 doneToday 漏到下一个,
 * 所以每个用例都清掉缓存重新加载。
 */
function freshService() {
    const p = require.resolve(`${SB}/src/services/redpacket`);
    delete require.cache[p];
    return require(p);
}

/** 装一个可编程的假网络层, 记录所有发出的请求 */
function installFakeNetwork(handlers) {
    const calls = [];
    network.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        calls.push({ key, body });
        const handler = handlers[key];
        if (!handler) throw new Error(`未预期请求: ${key}`);
        return { body: handler(body) };
    };
    return calls;
}

proto.loadProto().then(async () => {
    section('1. 只领 can_claim 的红包');
    {
        const calls = installFakeNetwork({
            [`${SERVICE}.GetTodayClaimStatus`]: () => frameOf(SERVICE, 'GetTodayClaimStatus',
                types.GetTodayClaimStatusReply, {
                    infos: [
                        { id: 1, can_claim: true },
                        { id: 2, can_claim: false },
                        { id: 3, can_claim: true },
                    ],
                }),
            [`${SERVICE}.ClaimRedPacket`]: () => frameOf(SERVICE, 'ClaimRedPacket',
                types.ClaimRedPacketReply, { status: 1, item: { id: 1002, count: 50 } }),
        });

        const rp = freshService();
        const ok = await rp.performDailyRedPacket(true);
        const claimCalls = calls.filter(c => c.key === `${SERVICE}.ClaimRedPacket`);
        check('返回 true', ok === true, ok);
        check('只发 2 次 ClaimRedPacket(跳过不可领的 #2)', claimCalls.length === 2, claimCalls.length);

        // 校验请求体里的 id 确实是 1 和 3
        const ids = claimCalls.map(c => {
            const req = types.ClaimRedPacketRequest.decode(c.body);
            return Number(req.id);
        }).sort();
        check('领取 id = [1,3]', JSON.stringify(ids) === JSON.stringify([1, 3]), ids);
    }

    section('2. 没有可领时不发领取请求, 且当天不再查');
    {
        const calls = installFakeNetwork({
            [`${SERVICE}.GetTodayClaimStatus`]: () => frameOf(SERVICE, 'GetTodayClaimStatus',
                types.GetTodayClaimStatusReply, { infos: [{ id: 9, can_claim: false }] }),
        });
        const rp = freshService();

        // 先重置当日状态(上面第 1 节已标记完成)
        await rp.performDailyRedPacket(true);
        check('无可领 → 返回 false', (await rp.performDailyRedPacket(true)) === false);
        check('从不发送 ClaimRedPacket',
            calls.filter(c => c.key === `${SERVICE}.ClaimRedPacket`).length === 0);
        check('当天已标记完成', rp.getRedPacketDailyState().doneToday === true);

        const before = calls.length;
        await rp.performDailyRedPacket(false);
        check('当天重复调用不再请求', calls.length === before, `${before} -> ${calls.length}`);
    }

    section('3. 单个失败不影响其余');
    {
        let claimSeq = 0;
        const calls = installFakeNetwork({
            [`${SERVICE}.GetTodayClaimStatus`]: () => frameOf(SERVICE, 'GetTodayClaimStatus',
                types.GetTodayClaimStatusReply, {
                    infos: [{ id: 11, can_claim: true }, { id: 12, can_claim: true }],
                }),
            [`${SERVICE}.ClaimRedPacket`]: () => {
                claimSeq += 1;
                if (claimSeq === 1) throw new Error('ClaimRedPacket 错误: code=500 服务异常');
                return frameOf(SERVICE, 'ClaimRedPacket', types.ClaimRedPacketReply,
                    { status: 1, item: { id: 1001, count: 10000 } });
            },
        });
        const rp = freshService();
        const ok = await rp.performDailyRedPacket(true);
        check('第一个失败, 第二个成功 → 返回 true', ok === true, ok);
        check('两个红包都尝试过', calls.filter(c => c.key === `${SERVICE}.ClaimRedPacket`).length === 2);
    }

    section('4. "已领取" 不当作错误');
    {
        installFakeNetwork({
            [`${SERVICE}.GetTodayClaimStatus`]: () => frameOf(SERVICE, 'GetTodayClaimStatus',
                types.GetTodayClaimStatusReply, { infos: [{ id: 21, can_claim: true }] }),
            [`${SERVICE}.ClaimRedPacket`]: () => { throw new Error('ClaimRedPacket 错误: code=1 今日已领取'); },
        });
        const rp = freshService();
        const ok = await rp.performDailyRedPacket(true);
        // 已经领过 = 这笔不需要再领:
        //   · 要标记当日完成, 否则每 20 分钟重试并一直报 error;
        //   · 但返回值仍是 false —— 调用方不该以为这次真拿到了东西。
        check('已领取 → 返回 false(没真领到)', ok === false, ok);
        check('已领取 → 不标记为 error', rp.getRedPacketDailyState().result !== 'error',
            rp.getRedPacketDailyState());
    }

    section('5. 状态查询失败不影响主流程');
    {
        installFakeNetwork({
            [`${SERVICE}.GetTodayClaimStatus`]: () => { throw new Error('网络断开'); },
        });
        const rp = freshService();
        const ok = await rp.performDailyRedPacket(true);
        check('查询失败 → 返回 false, 不抛异常', ok === false, ok);
        check('结果记为 error', rp.getRedPacketDailyState().result === 'error');
    }

    section('6. proto 类型齐全(协议早就定义, 只是一直没调用)');
    check('GetTodayClaimStatusRequest 存在', !!types.GetTodayClaimStatusRequest);
    check('GetTodayClaimStatusReply 存在', !!types.GetTodayClaimStatusReply);
    check('ClaimRedPacketRequest 存在', !!types.ClaimRedPacketRequest);
    check('ClaimRedPacketReply 存在', !!types.ClaimRedPacketReply);

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
