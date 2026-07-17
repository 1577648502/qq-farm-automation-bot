/**
 * qcby 取 code 配置加载器
 *
 * 优先级：环境变量 > data/qcby-code.json > 默认值。
 * 首次运行若文件不存在，会生成一份带注释说明的示例文件（enabled=false），
 * 用户填好后重启生效。
 */
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');

const CONFIG_FILENAME = 'qcby-code.json';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_CONFIG = {
    _说明: '通过 qcby 公开接口 GET /mywc?wxid=&appId= 自动获取「经典农场」小程序 code。填好后将 enabled 改为 true 并重启。',
    enabled: false,
    baseUrl: 'http://127.0.0.1:8110',
    protocol: 'mywc',
    intervalMs: DEFAULT_INTERVAL_MS,
    runOnStart: true,
    appid: '',
    authHeader: '',
    codePath: '',
    _accounts说明: 'accounts: 把 qcby 账号与农场实例 accountId 绑定；mywc/vx 用 wxid，yyb 用 ref；appid、protocol 可按账号覆盖顶层。',
    accounts: [
        { accountId: '', wxid: '', appid: '', protocol: '' },
    ],
};

function toBool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const s = String(value).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function readFileConfig() {
    const file = getDataFile(CONFIG_FILENAME);
    try {
        if (!fs.existsSync(file)) {
            ensureDataDir();
            fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
            return { fileCreated: true, config: {} };
        }
        const raw = fs.readFileSync(file, 'utf-8');
        return { fileCreated: false, config: JSON.parse(raw) || {} };
    } catch (_) {
        return { fileCreated: false, config: {} };
    }
}

function normalizeAccounts(rawAccounts, env) {
    let list = Array.isArray(rawAccounts) ? rawAccounts.slice() : [];

    // 单账号环境变量便捷映射
    const envAccountId = String(env.QCBY_ACCOUNT_ID || '').trim();
    const envWxid = String(env.QCBY_WXID || '').trim();
    const envRef = String(env.QCBY_REF || '').trim();
    if (envAccountId && (envWxid || envRef)) {
        list.push({ accountId: envAccountId, wxid: envWxid, ref: envRef, appid: '' });
    }

    return list
        .map(item => ({
            accountId: String((item && item.accountId) || '').trim(),
            wxid: String((item && item.wxid) || '').trim(),
            ref: String((item && item.ref) || '').trim(),
            appid: String((item && item.appid) || '').trim(),
            protocol: String((item && item.protocol) || '').trim().toLowerCase(), // 可选：覆盖全局 protocol（vx/yyb）
        }))
        .filter(item => item.accountId && (item.wxid || item.ref));
}

function loadQcbyCodeConfig(env = process.env) {
    const { config: fileCfg, fileCreated } = readFileConfig();

    const merged = {
        enabled: toBool(env.QCBY_ENABLED, fileCfg.enabled === true),
        baseUrl: String(env.QCBY_BASE_URL || fileCfg.baseUrl || DEFAULT_CONFIG.baseUrl).trim(),
        protocol: String(env.QCBY_PROTOCOL || fileCfg.protocol || 'mywc').trim().toLowerCase(),
        intervalMs: Math.max(30 * 1000, Number(env.QCBY_INTERVAL_MS || fileCfg.intervalMs || DEFAULT_INTERVAL_MS)),
        runOnStart: toBool(env.QCBY_RUN_ON_START, fileCfg.runOnStart !== false),
        appid: String(env.QCBY_APPID || fileCfg.appid || '').trim(),
        authHeader: String(env.QCBY_AUTH_HEADER || fileCfg.authHeader || '').trim(),
        codePath: String(env.QCBY_CODE_PATH || fileCfg.codePath || '').trim(),
        accounts: normalizeAccounts(fileCfg.accounts, env),
        fileCreated,
        configFile: getDataFile(CONFIG_FILENAME),
    };

    return merged;
}

/**
 * 轻量判断 qcby 取码是否启用（不创建/写入配置文件，供其它模块安全调用）。
 */
function isQcbyCodeEnabled(env = process.env) {
    if (env.QCBY_ENABLED !== undefined && env.QCBY_ENABLED !== '') {
        return toBool(env.QCBY_ENABLED, false);
    }
    try {
        const file = getDataFile(CONFIG_FILENAME);
        if (!fs.existsSync(file)) return false;
        const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) || {};
        return cfg.enabled === true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    loadQcbyCodeConfig,
    isQcbyCodeEnabled,
    CONFIG_FILENAME,
    DEFAULT_INTERVAL_MS,
};
