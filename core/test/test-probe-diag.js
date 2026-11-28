/**
 * probeSellTargets 候选判定诊断(2026-11-28):
 * "没有可卖的候选摊位(全离线/额度0)" — 卖出条件 = ok && !redirected && quotaLeft>0。
 * 摊位 quotaLeft 是**每日接收额度**(好友卖给你占 8000/天), 自己的号互相卖,
 * 额度天天被对方卖满 → quotaLeft=0 → 候选永远为空。
 * 本测试锁定: quotaLeft=0 或 redirected 的行绝不进 best, 即使 effPrice 最高。
 */
const { setupSandbox, createChecker } = require('./harness');
const SB = setupSandbox();
const { section, check, finish } = createChecker();

// 直接复刻 probeSellTargets 的筛选逻辑(不连网, 纯逻辑锁定)
function pickBest(rows) {
    const sellable = rows.filter((x) => x.ok && !x.redirected && x.quotaLeft > 0);
    sellable.sort((a, b) => b.effPrice - a.effPrice);
    return sellable[0] || null;
}

section('候选判定: 额度0/离线/重定向 都不可卖');
{
    const rows = [
        { gid: 1, name: '哈哈', ok: true, redirected: false, quotaLeft: 0, effPrice: 999 },
        { gid: 2, name: '南桕', ok: false, redirected: false, quotaLeft: 500, effPrice: 888 },
        { gid: 3, name: '北栕', ok: true, redirected: true, quotaLeft: 500, effPrice: 777 },
        { gid: 4, name: '润出去', ok: true, redirected: false, quotaLeft: 300, effPrice: 100 },
    ];
    const best = pickBest(rows);
    check(best && best.gid === 4, `额度0/离线/重定向全剔除, 选中唯一可卖(best=${best && best.name})`);

    const none = pickBest(rows.slice(0, 3));
    check(none === null, '全是额度0/离线/重定向 → best=null(即"没有可卖的候选摊位")');
}

finish();
