/**
 * 实时接口清单 —— 开关一开, 机器人边跑边把「出现了哪些 service.method」打到操作台
 *
 * 为什么还要这个(明明有了 protocol-observer):
 *   观察器落盘给人**事后**看; 但更新上线那天, 你想立刻知道"是不是有新接口在响"。
 *   这个模块只做实时可见性, 不做存储 —— 存储是 protocol-observer 的职责。
 *
 * 触发词: 环境变量 FARM_PROTO_LOG=1, 或面板上开关协议观察器时自动带上。
 * 输出行刻意很短(一行一个接口), 方便 grep / 复制进 issue。
 */
const enabled = () => process.env.FARM_PROTO_LOG === '1';

const seen = new Map();

/** 打一行; 同一接口只在首次出现时打, 避免刷屏 */
function logInterface(key, dir) {
    if (!enabled() || !key) return;
    if (seen.has(key)) {
        const rec = seen.get(key);
        rec.count += 1;
        return;
    }
    seen.set(key, { firstAt: Date.now(), count: 1, dir });
    // 不用 log(): 那会进面板日志并做过滤, 这里要的是纯净的操作台输出
    console.log(`[proto] + ${key}`);
}

function seenCount() {
    return seen.size;
}

function reset() {
    seen.clear();
}

module.exports = { logInterface, seenCount, reset, enabled };
