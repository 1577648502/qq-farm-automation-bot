/**
 * 宠物看家奖励(护主奖励) 回归测试
 *
 * 背景(2026-11-18):
 *   后端 GetGuardReward / ClaimGuardReward 一直存在(路由 /api/pet/rewards 也在),
 *   但前端页面从来没调用过 —— 有奖励也看不见、领不到。
 *
 * 这次除了接页签, 还顺手补了物品名解析:
 *   原先接口只返回 {id, count}, 页面只能显示 "#80011 x5";
 *   现在后端把 name 一起解析(货币固定叫法 + ItemInfo 兜底 + #id 退化)。
 *
 * 锁住三件事:
 *   1) 有护主狗/无护主狗 都能正确返回 can_claim;
 *   2) 奖励带 name, 且货币类用固定中文名(不查配置);
 *   3) 领取结果分开返回 items / bonus_items(服务端分两段给)。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'pet-reward-test';
isolateDataDir(SB, 'pet-reward-test');

const proto = require(`${SB}/src/utils/proto`);
const network = require(`${SB}/src/utils/network`);
const { types } = require(`${SB}/src/utils/proto`);

function installStub(handlers) {
    const calls = [];
    network.sendMsgAsync = async (service, method, body) => {
        calls.push({ service, method, body });
        const h = handlers[method] || handlers[`${service}.${method}`];
        if (!h) throw new Error(`未预期请求: ${service}.${method}`);
        return { body: h(body) };
    };
    return calls;
}

/** pet.js 在模块加载时解构 sendMsgAsync, 必须桩好再 require */
function freshPet() {
    const p = require.resolve(`${SB}/src/services/pet`);
    delete require.cache[p];
    return require(p);
}

proto.loadProto().then(async () => {
    section('1. 有护主狗 + 可领: 返回奖励并解析名字');
    {
        installStub({
            GetGuardReward: () => types.GetGuardRewardReply.encode(types.GetGuardRewardReply.create({
                has_huzhu_dog: true,
                can_claim: true,
                rewards: [
                    { id: 1005, count: 5 },      // 金豆豆(货币, 固定叫法)
                    { id: 1002, count: 30 },     // 点券(货币)
                    { id: 80011, count: 2 },     // 普通道具(查 ItemInfo, 查不到就 #id)
                ],
            })).finish(),
        });
        const pet = freshPet();
        const r = await pet.getGuardReward();

        check('has_huzhu_dog = true', r.has_huzhu_dog === true, r.has_huzhu_dog);
        check('can_claim = true', r.can_claim === true, r.can_claim);
        check('奖励 3 条', r.rewards.length === 3, r.rewards.length);
        check('金豆豆用固定名(不是 #1005)', r.rewards[0].name === '金豆豆', r.rewards[0]);
        check('点券用固定名', r.rewards[1].name === '点券', r.rewards[1]);
        // 80011 是否在 ItemInfo 里不影响断言: 要么查到真名, 要么退化 #80011, 不能是空串
        check('普通道具有名字或退化成 #id',
            typeof r.rewards[2].name === 'string' && r.rewards[2].name.length > 0,
            r.rewards[2]);
        check('数量原样返回', r.rewards[0].count === 5 && r.rewards[2].count === 2,
            r.rewards.map(x => x.count));
    }

    section('2. 没有护主狗: 不报错, can_claim=false');
    {
        installStub({
            GetGuardReward: () => types.GetGuardRewardReply.encode(types.GetGuardRewardReply.create({
                has_huzhu_dog: false,
                can_claim: false,
                rewards: [],
            })).finish(),
        });
        const pet = freshPet();
        const r = await pet.getGuardReward();
        check('has_huzhu_dog = false', r.has_huzhu_dog === false, r.has_huzhu_dog);
        check('can_claim = false', r.can_claim === false, r.can_claim);
        check('奖励为空数组', Array.isArray(r.rewards) && r.rewards.length === 0, r.rewards);
    }

    section('3. 接口报错: 返回安全默认值, 不抛异常');
    {
        installStub({
            GetGuardReward: () => { throw new Error('网络错误'); },
        });
        const pet = freshPet();
        let threw = false;
        let r = null;
        try { r = await pet.getGuardReward(); } catch { threw = true; }
        check('不抛异常', !threw);
        check('返回默认结构', r && r.has_huzhu_dog === false && r.can_claim === false,
            r);
    }

    section('4. 领取: items 与 bonus_items 分开返回, 都带名字');
    {
        installStub({
            ClaimGuardReward: () => types.ClaimGuardRewardReply.encode(types.ClaimGuardRewardReply.create({
                items: [{ id: 1002, count: 50 }],
                bonus_items: [{ id: 1007, count: 10 }],
            })).finish(),
        });
        const pet = freshPet();
        const r = await pet.claimGuardReward();
        check('items 1 条', r.items.length === 1, r.items);
        check('bonus_items 1 条', r.bonus_items.length === 1, r.bonus_items);
        check('items 带名字(点券)', r.items[0].name === '点券', r.items[0]);
        check('bonus_items 带名字(金券)', r.bonus_items[0].name === '金券', r.bonus_items[0]);
    }

    section('5. 领取失败: 返回空数组, 不抛');
    {
        installStub({
            ClaimGuardReward: () => { throw new Error('服务端拒绝'); },
        });
        const pet = freshPet();
        let threw = false;
        let r = null;
        try { r = await pet.claimGuardReward(); } catch { threw = true; }
        check('不抛异常', !threw);
        check('items/bonus_items 都是空数组',
            r && Array.isArray(r.items) && Array.isArray(r.bonus_items)
            && r.items.length === 0 && r.bonus_items.length === 0, r);
    }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
