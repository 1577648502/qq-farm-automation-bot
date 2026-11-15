/**
 * 客户端版本号自动跟进。
 *
 * 背景(抓包实测结论):
 *   版本号形如 `1.16.3.8_20261028` = `主.次.补丁_资源日期`。
 *   服务端在 LoginReply / HeartbeatReply 的 `version_info` 里**不给完整版本号**
 *   (version_recommend 恒为占位值 0.2.0.0), 但会给 `res_version` —— 也就是
 *   真实的资源日期(20260826 → 20260922 → 20261001 → 20261028 …), 它会随游戏更新变化。
 *
 *   所以能做到的自动跟进是:
 *     资源日期变了 → 把版本号的日期段换成新日期 → 重连后若服务器仍拒绝,
 *     说明 `主.次.补丁` 也变了, 这时只能报日志让用户手动更新(无法凭空猜出补丁号)。
 *
 * 为什么不直接在运行时改 CONFIG.clientVersion:
 *   版本号三段在服务端是有校验的, 只有日期段能从 res_version 确定, 三段号猜错会让
 *   登录直接失败; 而且已建立的连接用的还是老版本号, 改了也得重连才生效。
 *   所以这里**只观察并给出建议**, 由管理面板提供"一键应用"(只替换日期段),
 *   用户确认后写入配置并重连 —— 这样猜错也只影响他自己点的那一次。
 */
const { logWarn } = require('./utils');

const VERSION_PATTERN = /^(\d+\.\d+\.\d+\.\d+)_(\d{8})$/;

/** 拆出版本号里的资源日期, 解析不出来返回空串 */
function getResourceDateOf(clientVersion) {
    const m = VERSION_PATTERN.exec(String(clientVersion || '').trim());
    return m ? m[2] : '';
}

/** 用新资源日期替换版本号的日期段; 原版本号格式不认识时返回空串 */
function withResourceDate(clientVersion, resVersion) {
    const m = VERSION_PATTERN.exec(String(clientVersion || '').trim());
    const date = String(resVersion || '').trim();
    if (!m || !/^\d{8}$/.test(date)) return '';
    return `${m[1]}_${date}`;
}

/**
 * 计算"根据服务器的资源版本, 本地版本号应该变成什么"。
 * @returns {{ outdated: boolean, suggested: string, localDate: string, remoteDate: string }}
 */
function resolveVersionSuggestion(clientVersion, versionInfo) {
    const resVersion = versionInfo && versionInfo.res_version ? String(versionInfo.res_version) : '';
    const localDate = getResourceDateOf(clientVersion);
    const remoteDate = /^\d{8}$/.test(resVersion) ? resVersion : '';
    const outdated = !!remoteDate && !!localDate && remoteDate > localDate;
    return {
        outdated,
        suggested: outdated ? withResourceDate(clientVersion, remoteDate) : '',
        localDate,
        remoteDate,
    };
}

/**
 * 上一次观察到的版本结论(供管理面板展示)。
 * 服务器只在下发 version_info 时才带资源日期, 这里留一份最近结果,
 * 面板/接口读它就知道"本地版本是否落后"。按账号区分(不同账号可能连不同服)。
 */
const latestByAccount = new Map();
// 同一条"本地版本 → 远端日期"只告警一次, 否则每次心跳都会刷一条日志
const warnedKeys = new Set();

/** 账号键归一: 数字/字符串/空值都能落到同一个 key 上 */
function versionStateKey(accountId) {
    return String(accountId || 'default');
}

function getVersionState(accountId = '') {
    return latestByAccount.get(versionStateKey(accountId)) || null;
}

function clearVersionState(accountId = '') {
    latestByAccount.delete(versionStateKey(accountId));
    warnedKeys.clear();
}

/**
 * 处理服务器下发的 version_info: 记录结论 + 落后时告警。
 *
 * 为什么不在运行时直接改 CONFIG.clientVersion:
 *   版本号只有日期段能确定, 三段号猜错会让登录直接失败; 而且已经建立的连接
 *   用的还是老版本号, 改了也得重连才生效。自动改反而更容易把人搞下线。
 *   这里只观察并把建议交给面板, 由用户决定是否一键应用。
 *
 * @param versionInfo LoginReply/HeartbeatReply 的 version_info
 * @param currentVersion 当前使用的版本号
 * @param accountId 账号(用于区分状态)
 * @returns 结论; versionInfo 为空时返回 null
 */
function observeVersionInfo(versionInfo, currentVersion, accountId = '') {
    if (!versionInfo) return null;
    const status = Number(versionInfo.status) || 0;
    const result = resolveVersionSuggestion(currentVersion, versionInfo);
    const state = {
        ...result,
        status,
        checkedAt: Date.now(),
        currentVersion: String(currentVersion || ''),
    };
    latestByAccount.set(versionStateKey(accountId), state);

    if (!result.outdated) return result;

    // 同一个"本地版本 → 远端日期"只告警一次, 免得每次心跳刷屏
    const warnKey = `${currentVersion}->${result.remoteDate}`;
    if (!warnedKeys.has(warnKey)) {
        warnedKeys.add(warnKey);
        logWarn('系统', `服务器资源版本已更新到 ${result.remoteDate}（本地版本号 ${currentVersion}）；`
            + `建议改成 ${result.suggested}。若改后仍登录失败，说明主版本号也变了，需要手动更新`, {
            module: 'version',
            event: '版本跟进',
            result: 'outdated',
            status,
            localDate: result.localDate,
            remoteDate: result.remoteDate,
            suggested: result.suggested,
        });
    }
    return result;
}

module.exports = {
    resolveVersionSuggestion,
    observeVersionInfo,
    getVersionState,
    clearVersionState,
};
