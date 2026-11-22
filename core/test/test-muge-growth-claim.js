/**
 * 牧歌成长值档位领取回归测试 (2026-11-22 根因修复)
 *
 * 病根1: claimMugeActivity 的 1704 段, cmd=82(任务领取) 与 cmd=83(成长值档位领取)
 *   原本共用一个 try 块, 且 82 一抛就 throw 跳出循环。而 4 账号任务全部已领时,
 *   82 必回 1034164「该任务奖励已领取」并抛出 → 83 从不执行 → 成长值档位永远
 *   卡在"可领"。修复: 两条命令各自独立 try/catch。
 *
 * 病根2: 「无可领」类业务态(1034162/1034164/1034166)被当失败塞进 skipped,
 *   且网络层错误消息带全前缀 → verbose 日志一条超长。修复: 这类码不进 skipped,
 *   真失败消息压缩为 code=NNNN 中文。
 *
 * 本测试打桩 ActivityService.Operate, 两个场景:
 *   场景1: 82 回 1034164(正常态) → 83 仍执行, skipped 干净
 *   场景2: 82 抛真错误(未知码) → skipped 有压缩后的"活动任务", 83 仍执行
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
isolateDataDir(SB, 'muge-claim');

const { types } = require(`${SB}/src/utils/proto`);
const { toLong, toNum } = require(`${SB}/src/utils/utils`);

const t = createChecker();

const SUB = { TIERS: 2026111702, INVITE: 2026111703, TASKS: 2026111704, SHARE: 2026111705 };

let seenCmds = [];  // 记录 Operate 调用的 cmd 顺序, 验证 83 没被 82 阻断
let err82 = null;   // 82 命令抛出的错误(可按场景切换)

async function main() {
    await require(`${SB}/src/utils/proto`).loadProto();
    const net = require(`${SB}/src/utils/network`);
    // ⚠ activity.js 在 require 时就解构了 network.sendMsgAsync, 必须先打桩再 require,
    //   否则拿到的是未打桩的实现(连接未打开)。
    net.sendMsgAsync = async (service, method, body) => {
        if (method !== 'Operate') throw new Error(`意外方法 ${method}`);
        const req = types.ActivityOperateRequest.decode(Buffer.from(body || []));
        const cmd = toNum(req.cmd);
        seenCmds.push(cmd);

        if (cmd === 82) {
            // 任务全部已领 → 服务器回 1034164(业务态); 场景2 会换成真错误
            throw err82;
        }
        if (cmd === 83) {
            // 成长值档位领取成功, 返回带 growthValue/growthTiers 的完整体
            return {
                body: types.ActivityOperateReply.encode(types.ActivityOperateReply.create({
                    id: toLong(SUB.TASKS), cmd: toLong(83),
                    activity: {
                        muge_tasks: {
                            tasks: [],
                            growthValue: toLong(90),
                            growthTiers: [
                                { seq: 1, requiredGrowth: toLong(30), status: toLong(3) },   // 已领
                                { seq: 2, requiredGrowth: toLong(60), status: toLong(2) },   // 可领
                            ],
                        },
                    },
                })).finish(),
            };
        }
        if (cmd === 87) {
            // 分享前置探测: 无分享任务 → 不进领取循环
            return {
                body: types.ActivityOperateReply.encode(types.ActivityOperateReply.create({
                    id: toLong(SUB.SHARE), cmd: toLong(87),
                    activity: { muge_share: { tasks: [] } },
                })).finish(),
            };
        }
        // 85(档位)/84(助力): 返回空体, 不产生 detail
        return {
            body: types.ActivityOperateReply.encode(types.ActivityOperateReply.create({
                id: toLong(cmd || 0), cmd: toLong(cmd),
            })).finish(),
        };
    };

    const activity = require(`${SB}/src/services/activity`);

    // ---- 场景1: 82 回业务态 1034164("已领取") ----
    err82 = new Error('gamepb.activitypb.ActivityService.Operate 错误: code=1034164 该任务奖励已领取');
    seenCmds = [];
    const r1 = await activity.claimMugeActivity({ verbose: true });

    t.section('场景1: 82 回"已领取"(正常态) → 83 仍执行, skipped 干净');
    t.check('82 与 83 都被调用', seenCmds.includes(82) && seenCmds.includes(83), seenCmds);
    t.check('83 在 82 之后(未被阻断)', seenCmds.indexOf(83) > seenCmds.indexOf(82), seenCmds);
    t.check('成长值档位已统计(1/2档)', r1.growth === 1, r1.growth);
    t.check('成长值已读出(90)', r1.growthValue === 90, r1.growthValue);
    t.check('详情含成长值档位', (r1.details.join(',') || '').includes('成长值90'), r1.details);
    t.check('1034164 不进 skipped(正常态不刷日志)',
        !r1.skipped.some(s => s.includes('活动任务')), r1.skipped);
    t.check('skipped 无"成长值档位"(83 没被连累)',
        !r1.skipped.some(s => s.includes('成长值档位')), r1.skipped);
    t.check('skipped 为空数组', r1.skipped.length === 0, r1.skipped);

    // ---- 场景2: 82 抛真错误(未知码) → 压缩消息进 skipped, 83 仍执行 ----
    err82 = new Error('gamepb.activitypb.ActivityService.Operate 错误: code=1034199 服务器内部错误');
    seenCmds = [];
    const r2 = await activity.claimMugeActivity({ verbose: true });

    t.section('场景2: 82 抛真错误 → skipped 有压缩消息, 83 仍执行');
    t.check('83 仍被执行(真错误也不阻断)', seenCmds.includes(83), seenCmds);
    t.check('skipped 有"活动任务"(真失败要记录)',
        r2.skipped.some(s => s.includes('活动任务')), r2.skipped);
    t.check('消息已压缩(保留 code=1034199)',
        r2.skipped.some(s => s.includes('活动任务: code=1034199 服务器内部错误')), r2.skipped);
    t.check('长前缀已去除(不含 gamepb.activitypb)',
        !r2.skipped.some(s => s.includes('gamepb.activitypb')), r2.skipped);
    t.check('成长值档位仍被统计', r2.growth === 1, r2.growth);

    t.finish();
}

main().catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
