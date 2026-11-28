/**
 * 图鉴领奖回归测试
 *
 * 线上 2026-11-28: 用户反馈「牧场的普通图鉴的总奖励没有自动领取, 巨大图鉴有」。
 * 根因(两层):
 *   1) 前置闸门照抄植物图鉴的 `harvest_count >= planted_count`, 但牧场普通动物
 *      图鉴(101)的条目**从不下发 field5(harvest_count)**(抓包 616 条 0 条带
 *      field5) → 101 类单条目判定恒 false;
 *   2) 更关键: 101 的**总进度奖励**与单条目 has_reward 无关。抓包 idx127 里
 *      28 条条目全部已领, 官方客户端仍发 ClaimAllRewardsV2, 回包 1002×200
 *      —— 用「单条目可领」当闸门会把总奖励整轮跳过。
 *
 * 用真实抓包帧验证(20261117-162604_牧场1):
 *   idx 93   植物列表: 40097 收获 8 < 需 10 → 不可领(保留节流)
 *   idx 127  动物列表: 28 条无一条单条目可领
 *   idx 211  官方仍发 ClaimAllRewardsV2 {1:101} (0865)
 *   idx 212  回包 items/bonus = 1002×200 (普通图鉴总奖励)
 *   idx 208  领奖后 2060001 has_reward=1
 *
 * 运行: node test/test-illustrated-claim.js
 */
const path = require('node:path');
const fs = require('node:fs');

const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'illustrated-claim-test';
isolateDataDir(SB, 'illustrated-claim-test');

const proto = require(path.join(SB, 'src/utils/proto'));
const { types } = proto;
const ill = require(path.join(SB, 'src/services/illustrated'));

const CAP = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures',
    '20261117-162604_牧场1.decoded.jsonl');

/** 按行号(idx)取抓包明文帧 */
function frame(idx) {
    for (const line of fs.readFileSync(CAP, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.idx === idx) return j;
    }
    throw new Error(`抓包里没有 idx=${idx}`);
}

function listItems(idx) {
    const body = Buffer.from(frame(idx).bodyHex || '', 'hex');
    return types.GetIllustratedListV2Reply.decode(body).items || [];
}

function claimReply(idx) {
    const body = Buffer.from(frame(idx).bodyHex || '', 'hex');
    return types.ClaimAllRewardsV2Reply.decode(body);
}

async function main() {
    await proto.loadProto();

section('1. 领奖请求编码: 101 = 牧场普通动物图鉴');
{
    const hex = types.ClaimAllRewardsV2Request.encode(
        types.ClaimAllRewardsV2Request.create({ list_type: 101 }),
    ).finish().toString('hex');
    check('ClaimAllRewardsV2 {1:101} = 0865(与抓包一致)', hex === '0865', hex);
}

section('2. 核心证据: 单条目全部已领时, 普通图鉴总奖励仍可领');
{
    const items = listItems(127);
    const perItemClaimable = items.filter(it => ill.isItemClaimable(it, ill.LIST_TYPE.RANCH_ANIMAL));
    check('抓包前置(idx127): 28 条条目没有一条单条目可领', items.length === 28 && perItemClaimable.length === 0,
        `${perItemClaimable.length}/${items.length}`);
    check('抓包前置: 官方客户端仍发了 ClaimAllRewardsV2 {1:101}',
        (frame(211).bodyHex || '') === '0865', frame(211).bodyHex);
    const rep = claimReply(212);
    const got = [...(rep.items || []), ...(rep.bonus_items || [])];
    check('回包拿到总奖励(1002 点券 ×200)', got.length === 2
        && got.every(it => Number(it.id) === 1002 && Number(it.count) === 200), got);
    check('旧「单条目可领」闸门会把这笔总奖励整轮跳过 → 这就是本次 bug', perItemClaimable.length === 0, null);
}

section('3. isItemClaimable: 101 无 field5 时按 planted && !has_reward 判定');
{
    const animal = listItems(127).find(it => Number(it.seed_id) === 2060001);
    check('真实条目 2060001(has_reward=1)不可领',
        ill.isItemClaimable(animal, ill.LIST_TYPE.RANCH_ANIMAL) === false, animal);
    check('已解锁未领(协议不下发 harvest_count)可领',
        ill.isItemClaimable({ planted: true, planted_count: 10 }, ill.LIST_TYPE.RANCH_ANIMAL) === true, null);
    check('未解锁条目不领',
        ill.isItemClaimable({ planted: false, planted_count: 10 }, ill.LIST_TYPE.RANCH_ANIMAL) === false, null);
    const locked = listItems(127).find(it => !it.planted);
    check('抓包里的未解锁条目也不领',
        ill.isItemClaimable(locked, ill.LIST_TYPE.RANCH_ANIMAL) === false, null);
}

section('4. 植物图鉴(1): 保留收获数节流, 不被动物规则带偏');
{
    const plants = listItems(93);
    const low = plants.find(it => Number(it.seed_id) === 40097);
    check('40097 已解锁未领但收获 8 < 需 10 → 不可领',
        !!low && ill.isItemClaimable(low, ill.LIST_TYPE.PLANT) === false,
        low && `${low.harvest_count}/${low.planted_count}`);
    check('达到阈值 → 可领',
        ill.isItemClaimable({ planted: true, planted_count: 10, harvest_count: 10 }, 1) === true, null);
    check('未达阈值 → 不可领',
        ill.isItemClaimable({ planted: true, planted_count: 10, harvest_count: 9 }, 1) === false, null);
    check('没有领奖阈值的条目不领',
        ill.isItemClaimable({ planted: true, planted_count: 0, harvest_count: 0 }, 1) === false, null);
}

section('5. formatItem(UI/统计)同步修正');
{
    const syn = { planted: true, planted_count: 10 };
    check('formatItem(已解锁未领动物, 101).canClaim = true',
        ill.formatItem(syn, ill.LIST_TYPE.RANCH_ANIMAL).canClaim === true, null);
    check('formatItem(动物, 不传类别) 保持植物规则(兼容旧调用)',
        ill.formatItem(syn).canClaim === false, null);
    const low = listItems(93).find(it => Number(it.seed_id) === 40097);
    check('formatItem(植物, 1).canClaim = false',
        ill.formatItem(low, ill.LIST_TYPE.PLANT).canClaim === false, null);
}

section('6. 定时任务/手动领取都不再用「单条目可领」当闸门');
{
    const taskSrc = fs.readFileSync(path.join(SB, 'src/services/task.js'), 'utf8');
    check('task.js 两类图鉴直接各发一次 claimAllRewards',
        /const reply = await claimAllRewards\(listType\)/.test(taskSrc), null);
    check('task.js 图鉴探针里不再用 isItemClaimable 当闸门',
        !/arr\.some\(it => isItemClaimable/.test(taskSrc), null);
    check('task.js 探针不再为闸门多查两次列表', !/getIllustratedList/.test(taskSrc), null);
    const illSrc = fs.readFileSync(path.join(SB, 'src/services/illustrated.js'), 'utf8');
    check('claimIllustratedRewards 不再用 arr.filter(可领) 拦截',
        !/arr\.filter\(\(it\) => isItemClaimable/.test(illSrc), null);
    check('weight 档奖励日志用 fmtReward(不再 [object Object])',
        /got\.map\(fmtReward\)/.test(illSrc), null);
}

finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
