/**
 * 牧歌成长值档位领取回归测试 (2026-11-22 根因修复)
 *
 * 病根: claimMugeActivity 的 1704 段, cmd=82(任务领取) 与 cmd=83(成长值档位领取)
 *   原本共用一个 try 块, 且 82 一抛就 throw 跳出循环。而 4 账号任务全部已领时,
 *   82 必回 1034164「该任务奖励已领取」并抛出 → 83 从不执行 → 成长值档位永远
 *   卡在"可领"。修复: 两条命令各自独立 try/catch。
 *
 * 本测试打桩 ActivityService.Operate: 82 抛 1034164, 83 正常返回成长值体,
 * 断言 83 仍被执行、成长值档位被统计、skipped 里只有"活动任务"没有"成长值档位"。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
isolateDataDir(SB, 'muge-claim');

const { types } = require(`${SB}/src/utils/proto`);
const { toLong, toNum } = require(`${SB}/src/utils/utils`);

const t = createChecker();

const SUB = { TIERS: 2026111702, INVITE: 2026111703, TASKS: 2026111704, SHARE: 2026111705 };

const seenCmds = []; // 记录 Operate 调用的 cmd 顺序, 验证 83 没被 82 阻断

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
            // 任务全部已领 → 服务器回 1034164, 必须抛错(复现线上)
            throw new Error('code=1034164 该任务奖励已领取');
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

    const r = await activity.claimMugeActivity({ verbose: true });

    t.section('回归: 82 抛"已领取" 时, 83 仍必须执行');
    t.check('82 与 83 都被调用', seenCmds.includes(82) && seenCmds.includes(83), seenCmds);
    t.check('83 在 82 之后(未被阻断)', seenCmds.indexOf(83) > seenCmds.indexOf(82), seenCmds);
    t.check('成长值档位已统计(1/2档)', r.growth === 1, r.growth);
    t.check('成长值已读出(90)', r.growthValue === 90, r.growthValue);
    t.check('详情含成长值档位', (r.details.join(',') || '').includes('成长值90'), r.details);
    t.check('skipped 有"活动任务"(82 抛错)', r.skipped.some(s => s.includes('活动任务')), r.skipped);
    t.check('skipped 无"成长值档位"(83 没被连累)', !r.skipped.some(s => s.includes('成长值档位')), r.skipped);

    t.finish();
}

main().catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
