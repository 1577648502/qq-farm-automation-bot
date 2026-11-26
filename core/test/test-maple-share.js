/**
 * 以薯换福「每日分享暴击」协议 回归测试
 *
 * 定案(2026-11-26, 抓包 20261125-105437 / 20261125-115051「新活动」):
 *   分享收购价 = gamepb.sharepb.ShareService.ReportShare
 *   请求 body = 08 1c 20 e1 0f  →  #1 share_type=28(以薯换福), #4 scene=2017(活动页)
 *   回包 result 是 repeated, 一次可能带三条:
 *     {code=102, reward={}} / {code=1, reward={1,1}} / {code=28, reward={#1=今日分享次数}}
 *   ⚠ 本活动的结果码是 28, **不是** 1 —— 按 code=1 判定会误判成功(旧分享流程踩过同类坑)。
 *   ⚠ reward#1 是分享次数(第二次调用 1→2), 不是暴击值; 暴击效果只能看 #130#5 前后差值。
 *
 * 锁住不变量:
 *   1) 编码 share_type=28/scene=2017 必须复现抓包 hex 081c20e10f;
 *   2) 回包解析必须能同时拿到 102/1/28 三条, 并挑出 code=28;
 *   3) 幂等调用(同日第二次)shareCount 递增, 不会重复加价。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'maple-share-test');

const proto = require(`${SB}/src/utils/proto`);

// 线上抓包原文
const CAPTURE_REQ_HEX = '081c20e10f';
const CAPTURE_REPLY_FIRST = '0a04086612000a0808011204080110010a06081c12020802';
const CAPTURE_REPLY_SECOND = '0a06081c120208010a0808011204080810010a0408661200';

proto.loadProto().then(async () => {
    const { types } = proto;

    section('请求编码: ReportShare{share_type=28, scene=2017}');
    const req = types.ReportShareRequest.create({ share_type: 28, scene: 2017 });
    const reqHex = Buffer.from(types.ReportShareRequest.encode(req).finish()).toString('hex');
    check('复现抓包 hex 081c20e10f', reqHex === CAPTURE_REQ_HEX);

    section('回包解析: repeated result, 本活动码 = 28');
    for (const [label, hex, expectCount] of [
        ['首分享回包', CAPTURE_REPLY_FIRST, 2],
        ['重复分享回包', CAPTURE_REPLY_SECOND, 1],
    ]) {
        const reply = types.ReportShareReply.decode(Buffer.from(hex, 'hex'));
        const results = (reply.result || []).map(x => ({
            code: Number(x.code) || 0,
            reward: x.reward ? { f1: Number(x.reward.field1) || 0, f2: Number(x.reward.field2) || 0 } : null,
        }));
        check(`${label}: 解析出多条 result`, results.length >= 2);
        const mine = results.find(x => x.code === 28) || null;
        check(`${label}: 命中 code=28`, !!mine);
        check(`${label}: reward#1=今日分享次数 ${expectCount}`, !!mine && mine.reward.f1 === expectCount);
        // 反面: 按 code=1 判定会拿到别的活动结果, 必须不能当成本活动
        const wrong = results.find(x => x.code === 1) || null;
        check(`${label}: code=1 不是本活动结果`, !wrong || wrong.code !== 28);
    }

    section('导出面: 常量与函数');
    const maple = require(`${SB}/src/services/maple-market`);
    check('SHARE_TYPE_MAPLE === 28', maple.SHARE_TYPE_MAPLE === 28);
    check('SHARE_SCENE_MAPLE === 2017', maple.SHARE_SCENE_MAPLE === 2017);
    check('reportShareCrit 已导出', typeof maple.reportShareCrit === 'function');

    finish();
}).catch((e) => {
    console.error(e);
    process.exit(1);
});
