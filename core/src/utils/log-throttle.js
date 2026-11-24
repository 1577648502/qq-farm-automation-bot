/**
 * 通用日志节流(从 ranch.js 抽出, 供跨服务共用):
 * 静态条件的 skip 日志("配额已满"/"不可购买"/"没有空槽位")每轮巡查都刷,
 * 页面被灌满。这里按 key + signature 节流: 同一状态在间隔内只放行一次,
 * 状态真的变了(signature 不同)立刻放行 —— 和农场的"状态变化才提示"同一策略。
 */
const _state = new Map();

function shouldLogOnce(key, signature = '', minIntervalMs = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    const prev = _state.get(key);
    // 状态变了 → 立刻提示一次(例如从 4/4 变成 3/4, 或幼崽数量变化)
    if (!prev || prev.sig !== signature || now - prev.at >= minIntervalMs) {
        _state.set(key, { sig: signature, at: now });
        return true;
    }
    return false;
}

/** 测试/重启用: 清空节流状态 */
function resetLogOnceState() {
    _state.clear();
}

module.exports = {
    shouldLogOnce,
    resetLogOnceState,
};
