/**
 * 业务态错误识别 + 网络层错误消息压缩 (2026-11-22 牧歌日志降噪的通用化)
 *
 * 背景: 网络层(network.js)把业务错误统一抛成
 *   "gamepb.xxx.Service.Method 错误: code=NNNN 中文原因"
 * 其中大量 code 是「无可领/已完成」的正常业务态(全领完、今日已做、限购用完),
 * 周期自查把它们当失败打 warn → 每轮刷屏/多段拼接超长日志。
 *
 * 这里提供两个工具:
 *   isBizStateError(e)  判断是否「无可领/已完成」类业务态 → 调用方静音或降级
 *   shortNetErr(e)      压缩消息前缀 → "code=NNNN 中文原因"(切片实现, 无回溯)
 */

/** 业务态特征(中文报文回执, 2026-11-22 盘点各活动接口实测语料) */
const BIZ_STATE_PATTERNS = [
    /已领取/,
    /已领过/,
    /已收取/,
    /已完成/,
    /今日已/,
    /不可领取/,
    /无可领取/,
    /次数已用完/,
    /限购次数/,
    /已过期/,
    /重复领取/,
];

/**
 * @param {Error|string} e
 * @returns {boolean} true = 业务态("无可领/已完成"), 调用方不应按失败告警
 */
function isBizStateError(e) {
    const msg = String((e && e.message) || e);
    return BIZ_STATE_PATTERNS.some((p) => p.test(msg));
}

/**
 * 压缩网络层错误消息: "gamepb.activitypb.ActivityService.Operate 错误: code=1034162 该档位奖励已领取"
 *   → "code=1034162 该档位奖励已领取"
 * 无 code= 的消息(如 "连接未打开")原样返回。
 * @param {Error|string} e
 * @returns {string} 压缩后的短消息(或原消息)
 */
function shortNetErr(e) {
    const msg = String((e && e.message) || e);
    const i = msg.indexOf('code=');
    if (i === -1) return msg;
    // 切片代替贪婪正则(避免多项式回溯); 码后多个空格压成一个
    return msg.slice(i).replace(/^(code=\d+)\s+/, '$1 ').trim();
}

module.exports = { isBizStateError, shortNetErr };
