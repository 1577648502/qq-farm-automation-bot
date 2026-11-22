/**
 * 失败熔断器回归测试 (2026-11-22 "照顾失败刷屏"教训的防回归)
 *
 * 覆盖:
 *   1. 阈值语义: 前 threshold-1 次照常告警(false), 第 threshold 次 'open' + 熔断跳过
 *   2. 半开试探失败: 'extend' 静默续期, 不再打日志
 *   3. 半开试探成功(无 success() 挂点): 下一轮 isOpen() 自动完全复位
 *   4. 健康轮次断链: 中间成功过就重新计数, 零星失败不误熔断
 *   5. success() 手动复位
 *   6. guardPeriodic 包装: 熔断中不再调用底层操作, 日志受控
 *   7. 周期任务仿真: 20秒节奏连挂 50 轮 / 31分钟节奏连挂 50 轮, 日志条数恒定, 恢复后自愈
 *
 * 时间用虚拟时钟(熔断器内部走 Date.now(), 冷却最小被钳到 10s, 真实等待太慢)。
 * 所有轮次遵循真实接入点约定: 每轮先 isOpen() 再操作。
 */
const { createFailureBreaker, guardPeriodic } = require('../src/utils/failure-breaker');
const { createChecker } = require('./harness');

const t = createChecker();

async function main() {
    const REAL_NOW = Date.now;
    let now = 1700000000000;
    Date.now = () => now;
    const advance = (ms) => { now += ms; };
    const COOLDOWN = 30 * 60 * 1000;

    try {
        t.section('阈值语义: 前 2 次照常告警, 第 3 次熔断');
        {
            const b = createFailureBreaker();
            t.check('第1次失败返回 false', b.failure() === false);
            t.check('第2次失败返回 false', b.failure() === false);
            t.check('第3次失败返回 open', b.failure() === 'open');
            t.check('熔断中 isOpen()=true', b.isOpen() === true);
            advance(60 * 1000);
            t.check('冷却期内仍熔断', b.isOpen() === true);
        }

        t.section('半开试探失败: extend 静默续期');
        {
            const b = createFailureBreaker();
            b.failure(); b.failure(); b.failure();
            advance(COOLDOWN + 60 * 1000);
            t.check('冷却过后放行试探', b.isOpen() === false);
            t.check('试探失败返回 extend(调用方静默)', b.failure() === 'extend');
            t.check('续期后重新熔断', b.isOpen() === true);
            advance(COOLDOWN + 60 * 1000);
            t.check('冷却过后再次放行', b.isOpen() === false);
            t.check('再次静默续期', b.failure() === 'extend');
        }

        t.section('半开试探成功: 无 success() 挂点也自动复位');
        {
            const b = createFailureBreaker();
            b.failure(); b.failure(); b.failure();
            advance(COOLDOWN + 60 * 1000);
            t.check('试探轮放行', b.isOpen() === false);
            advance(60 * 1000); // 试探轮正常跑完, 无 failure() 到来
            t.check('下一轮 isOpen 仍放行', b.isOpen() === false);
            t.check('已自动复位(fails=0)', b.stats().fails === 0);
            t.check('复位后失败按新计数告警(false)', b.failure() === false);
        }

        t.section('健康轮次断链: 中间成功过就重新计数');
        {
            const b = createFailureBreaker();
            b.isOpen(); b.failure(); // 轮1: 失败
            t.check('失败1 计数=1', b.stats().fails === 1);
            advance(60 * 1000); b.isOpen(); // 轮2: 健康(紧跟失败轮, 计数保留)
            advance(60 * 1000); b.isOpen(); // 轮3: 健康 → 断链清零
            t.check('健康轮次后计数已清零', b.stats().fails === 0);
            advance(COOLDOWN);
            b.isOpen();
            t.check('隔天零星失败重新计为第1次', b.failure() === false && b.stats().fails === 1);
            t.check('零星失败不熔断', b.isOpen() === false);
            // 对照: 中间没有健康轮次的连续失败仍然会熔断(经 reset 后需凑满3个失败轮)
            b.isOpen(); b.failure();
            b.isOpen(); b.failure();
            b.isOpen(); b.failure();
            t.check('连续失败第3次熔断', b.isOpen() === true);
        }

        t.section('success() 手动复位');
        {
            const b = createFailureBreaker();
            b.failure(); b.failure();
            b.success();
            t.check('复位后失败重新计数', b.failure() === false);
            t.check('仍需第3次才 open', b.failure() === false && b.failure() === 'open');
        }

        t.section('guardPeriodic 包装: 调用与日志双受控');
        {
            const b = createFailureBreaker();
            const logs = [];
            let calls = 0;
            const log = (lvl, msg) => logs.push(msg);
            const boom = async () => { calls += 1; throw new Error('boom'); };
            for (let i = 0; i < 3; i++) await guardPeriodic(b, '测试操作', boom, log);
            t.check('3 轮 3 次调用', calls === 3);
            t.check('前2轮是普通失败日志', (logs[0] || '').includes('失败') && !(logs[0] || '').includes('暂停'));
            t.check('第3轮是暂停日志', (logs[2] || '').includes('暂停30分钟'));
            await guardPeriodic(b, '测试操作', boom, log);
            t.check('熔断中不调底层(仍3次)', calls === 3);
            t.check('熔断中不打日志(仍3条)', logs.length === 3);
            advance(COOLDOWN + 60 * 1000);
            await guardPeriodic(b, '测试操作', boom, log);
            t.check('试探轮调用了底层(4次)', calls === 4);
            t.check('试探失败静默(日志仍3条)', logs.length === 3);
            advance(COOLDOWN + 60 * 1000);
            const ok = async () => { calls += 1; return 'fine'; };
            await guardPeriodic(b, '测试操作', ok, log);
            const r = await guardPeriodic(b, '测试操作', ok, log);
            t.check('恢复后正常调用(6次)', calls === 6);
            t.check('恢复后返回正常结果', r === 'fine');
            t.check('全程日志仍只有3条', logs.length === 3);
        }

        t.section('周期仿真A: 20秒节奏连挂 50 轮(照顾失败刷屏同款)');
        {
            const b = createFailureBreaker();
            let req = 0; const logs = [];
            for (let i = 0; i < 50; i++) {
                if (!b.isOpen()) {
                    req += 1;
                    try { throw new Error('未知错误 code=1045999'); } catch {
                        const st = b.failure();
                        if (st === 'open') logs.push('暂停');
                        else if (!st) logs.push('失败');
                    }
                }
                advance(20 * 1000);
            }
            t.check(`50 轮只发 ${req} 次请求(前3轮)`, req === 3, req);
            t.check(`日志 ${logs.length} 条(原来要刷 50 条)`, logs.length === 3, logs.length);
        }

        t.section('周期仿真B: 31分钟节奏连挂 50 轮(每轮冷却都过期, 持续试探)');
        {
            const b = createFailureBreaker();
            let req = 0; const logs = [];
            for (let i = 0; i < 50; i++) {
                if (!b.isOpen()) {
                    req += 1;
                    try { throw new Error('boom'); } catch {
                        const st = b.failure();
                        if (st === 'open') logs.push('暂停');
                        else if (!st) logs.push('失败');
                    }
                }
                advance(31 * 60 * 1000);
            }
            t.check(`日志恒定 ${logs.length} 条`, logs.length === 3, logs.length);
            t.check('每轮都有试探请求(30分钟一次)', req === 50, req);

            t.section('周期仿真C: 故障恢复后自愈回正常语义');
            for (let i = 0; i < 3; i++) {
                if (!b.isOpen()) req += 1; // 成功轮: 不调 failure() 也不调 success()
                advance(31 * 60 * 1000);
            }
            t.check('恢复后自动复位(fails=0)', b.stats().fails === 0);
            t.check('恢复期间日志零新增', logs.length === 3, logs.length);
        }
    } finally {
        Date.now = REAL_NOW;
    }

    t.finish();
}

main();
