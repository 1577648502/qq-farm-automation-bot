/**
 * 分享协议回归测试
 *
 * 抓包 20261015 的 ReportShare 响应同时包含:
 *   result[0] = { code: 1, reward: ... }
 *   result[1] = { code: 102, reward: {} }
 * 旧 proto 把 result 当单值消息，后一个 code=102 会覆盖成功结果。
 *
 * 运行: node test/test-share-protocol.js
 */
const { setupSandbox, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
const DUPLICATE_RESULT_HEX = '0a0808011204081c10010a0408661200';

(async () => {
    const proto = require(`${SB}/src/utils/proto`);
    await proto.loadProto();
    const { types } = proto;

    section('1. ReportShare 多 result 协议');
    {
        const reply = types.ReportShareReply.decode(Buffer.from(DUPLICATE_RESULT_HEX, 'hex'));
        check('result 解析为数组', Array.isArray(reply.result), reply.result);
        check('保留成功和附加结果',
            reply.result.map(item => Number(item.code)).join(',') === '1,102',
            reply.result.map(item => Number(item.code)));
    }

    section('2. 微信礼包 scene=0 请求体');
    {
        const body = types.ReportShareRequest.encode(types.ReportShareRequest.create({
            share_type: 1,
            scene: 0,
        })).finish();
        check('编码为抓包中的 08012000', body.toString('hex') === '08012000', body.toString('hex'));
    }

    const calls = [];
    const network = require(`${SB}/src/utils/network`);
    network.sendMsgAsync = async (service, method, body) => {
        calls.push({ service, method, body: Buffer.from(body) });
        if (method === 'CheckCanShare') return { body: Buffer.from('0801', 'hex') };
        if (method === 'ReportShare') return { body: Buffer.from(DUPLICATE_RESULT_HEX, 'hex') };
        if (method === 'ClaimShareReward') return { body: Buffer.alloc(0) };
        throw new Error(`未 stub 的接口: ${service}.${method}`);
    };

    // sendMsgAsync 在 require 时被解构，必须先打桩再加载 service。
    const share = require(`${SB}/src/services/share`);

    section('3. 分享任务不再被附加 code=102 阻断');
    {
        calls.length = 0;
        const ok = await share.performDailyShare(true);
        check('分享任务返回成功', ok === true, ok);
        check('继续调用了 ClaimShareReward',
            calls.some(call => call.method === 'ClaimShareReward'),
            calls.map(call => call.method));
    }

    section('4. 每日/周末礼包使用 scene=0');
    {
        calls.length = 0;
        const ok = await share.performDailyWechatGift(true);
        check('微信礼包触发成功', ok === true, ok);
        const report = calls.find(call => call.method === 'ReportShare');
        check('发送 ReportShare', !!report, calls.map(call => call.method));
        check('请求体是 08012000', report && report.body.toString('hex') === '08012000',
            report && report.body.toString('hex'));
    }

    finish();
})().catch((e) => {
    console.log('测试异常:', e && e.message);
    process.exit(1);
});
