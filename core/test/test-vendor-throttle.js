/**
 * 游商"当前不可购买"刷屏回归测试 (2026-11-28)
 *
 * 根因: shouldLogOnce 的"签名变了立刻放行"策略 + 每轮固定打 80011+80012 两条
 *   → 两个签名交替, 互相把对方顶掉, 24h 节流完全失效, 每轮 daily 巡查刷 2 条。
 * 修复: 节流 key 加上 itemId(每商品独立记忆), 签名固定为 'skip' —— 商品 A 和 B
 *   互不干扰, 同一商品 24h 内只报一次。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');
const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'vendor-throttle-test');

const { shouldLogOnce, resetLogOnceState } = require(`${SB}/src/utils/log-throttle`);

section('旧行为复现: 同 key 交替签名 → 每次放行(刷屏根因)');
{
    resetLogOnceState();
    let count = 0;
    for (let i = 0; i < 6; i++) {
        if (shouldLogOnce('k', i % 2 ? '80011' : '80012', 24 * 3600 * 1000)) count++;
    }
    check(count === 6, `交替签名全放行(旧缺陷实证, count=${count})`);
}

section('修复后: 每商品独立 key + 固定签名 → 24h 各一条');
{
    resetLogOnceState();
    let count = 0;
    for (let round = 0; round < 100; round++) {
        for (const id of ['80012', '80011', '80013']) {
            if (shouldLogOnce(`ranch_vendor_skip:${id}`, 'skip', 24 * 3600 * 1000)) count++;
        }
    }
    check(count === 3, `100 轮 × 3 商品只记 3 条(count=${count})`);
}

section('状态变化仍立刻放行(不同错误原因不吞)');
{
    resetLogOnceState();
    const a = shouldLogOnce('ranch_vendor_skip:80011', 'skip', 24 * 3600 * 1000);
    const b = shouldLogOnce('ranch_vendor_skip:80011', 'sold_out', 24 * 3600 * 1000);
    check(a && b, '原因变化(签名变)立刻提示一次');
}

finish();
