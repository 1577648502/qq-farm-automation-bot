/**
 * 配置备份 / 恢复 —— 用于**迁移服务器**（导出所有可保存的配置，导入到新机器）
 *
 * 备份范围（**只含配置与凭据，不含日志/统计/缓存**）：
 *   store.json        全部配置（账号配置、默认配置、界面主题、离线提醒、公告、公告已读、系统配置、
 *                     全局微信配置、管理员密码哈希）
 *   accounts.json     账号列表（含 Code）
 *   users.json        用户/管理员
 *   qcby-code.json    qcby 自动取码配置（可选）
 *   cards.json        卡密（可选）
 *   card-claim.json   卡密领取设置（可选）
 * **不备份**：logs/（日志）、stats/（统计）、known_friend_gids/（好友缓存）、gameConfig/（游戏素材，可用 pnpm sync:game-config 重新生成）、
 *            login-logs.json / login-attempts.json（运行时）
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDataDir, ensureDataDir } = require('../config/runtime-paths');

const APP_ID = 'qq-farm-automation-bot';
const BACKUP_VERSION = 1;

const BACKUP_FILES = [
    { name: 'store.json', required: true, desc: '全部配置(账号配置/自动化/界面/公告/提醒/管理员密码)' },
    { name: 'accounts.json', required: true, desc: '账号列表(含 Code)' },
    { name: 'users.json', required: true, desc: '用户/管理员' },
    { name: 'qcby-code.json', required: false, desc: 'qcby 自动取码配置' },
    { name: 'cards.json', required: false, desc: '卡密' },
    { name: 'card-claim.json', required: false, desc: '卡密领取设置' },
];

const NOT_BACKED_UP = [
    'logs/（日志）',
    'stats/（统计）',
    'known_friend_gids/（好友缓存）',
    'gameConfig/（游戏素材，可 pnpm sync:game-config 重新生成）',
    'login-logs.json / login-attempts.json（运行时）',
];

/** 导出全部配置为一个可下载的 JSON 对象 */
function exportConfigs() {
    ensureDataDir();
    const dir = getDataDir();
    const files = {};
    const manifest = [];
    for (const f of BACKUP_FILES) {
        const fp = path.join(dir, f.name);
        if (!fs.existsSync(fp)) {
            manifest.push({ name: f.name, desc: f.desc, required: f.required, present: false });
            continue;
        }
        let text = '';
        try { text = fs.readFileSync(fp, 'utf8'); } catch (e) { text = ''; }
        // 只接受合法 JSON，避免导出坏文件
        try { JSON.parse(text); } catch (e) { text = ''; }
        if (text) {
            files[f.name] = text;
            manifest.push({ name: f.name, desc: f.desc, required: f.required, present: true, bytes: Buffer.byteLength(text) });
        } else {
            manifest.push({ name: f.name, desc: f.desc, required: f.required, present: false });
        }
    }
    return {
        app: APP_ID,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        exportedAtMs: Date.now(),
        manifest,
        notBackedUp: NOT_BACKED_UP,
        files,
    };
}

/** 导入前的结构校验；返回 { ok, reason } */
function validatePayload(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: '备份内容为空或格式错误' };
    if (payload.app !== APP_ID) return { ok: false, reason: `不是本程序的备份文件（app=${payload.app || '缺失'}）` };
    if (Number(payload.version) !== BACKUP_VERSION) return { ok: false, reason: `备份版本不支持（version=${payload.version}）` };
    const files = payload.files;
    if (!files || typeof files !== 'object') return { ok: false, reason: '备份里没有 files' };
    for (const f of BACKUP_FILES) {
        const txt = files[f.name];
        if (txt === undefined || txt === null || txt === '') {
            if (f.required) return { ok: false, reason: `缺少必需文件：${f.name}` };
            continue;
        }
        if (typeof txt !== 'string') return { ok: false, reason: `${f.name} 不是文本` };
        try { JSON.parse(txt); } catch (e) { return { ok: false, reason: `${f.name} 不是合法 JSON` }; }
    }
    // 结构化校验：store.json 至少要有 accountConfigs（防呆：避免导入空配置把系统打空）
    try {
        const st = JSON.parse(files['store.json']);
        if (!st || typeof st !== 'object' || !('accountConfigs' in st)) {
            return { ok: false, reason: 'store.json 结构异常（缺少 accountConfigs）' };
        }
    } catch (e) {
        return { ok: false, reason: 'store.json 解析失败' };
    }
    return { ok: true };
}

/** 把当前数据目录下的这些文件复制一份到 data/backup-<时间>/（导入前的安全兜底） */
function snapshotCurrent() {
    const dir = getDataDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dst = path.join(dir, `backup-${stamp}`);
    fs.mkdirSync(dst, { recursive: true });
    const copied = [];
    for (const f of BACKUP_FILES) {
        const src = path.join(dir, f.name);
        if (!fs.existsSync(src)) continue;
        try {
            fs.copyFileSync(src, path.join(dst, f.name));
            copied.push(f.name);
        } catch (e) { /* 单个复制失败不阻断 */ }
    }
    return { dir: dst, copied };
}

/** 原子写（先写 .tmp 再 rename） */
function writeAtomic(fp, text) {
    const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, String(text), 'utf8');
    fs.renameSync(tmp, fp);
}

/**
 * 导入配置
 * @param {object} payload 由 exportConfigs 生成的对象
 * @param {object} [opts] { skipSnapshot?: boolean }
 * @returns {{ok:boolean, reason?:string, written?:string[], skipped?:string[], backupDir?:string}}
 */
function importConfigs(payload, opts = {}) {
    const v = validatePayload(payload);
    if (!v.ok) return { ok: false, reason: v.reason };
    ensureDataDir();
    const dir = getDataDir();
    let backupDir = '';
    if (!opts.skipSnapshot) {
        try { backupDir = snapshotCurrent().dir; } catch (e) { /* 快照失败不阻断，但要提示 */ }
    }
    const written = [];
    const skipped = [];
    for (const f of BACKUP_FILES) {
        const txt = payload.files[f.name];
        if (txt === undefined || txt === null || txt === '') { skipped.push(f.name); continue; }
        try {
            writeAtomic(path.join(dir, f.name), txt);
            written.push(f.name);
        } catch (e) {
            return { ok: false, reason: `写入 ${f.name} 失败：${e.message}`, written, backupDir };
        }
    }
    return { ok: true, written, skipped, backupDir };
}

module.exports = {
    APP_ID,
    BACKUP_VERSION,
    BACKUP_FILES,
    NOT_BACKED_UP,
    exportConfigs,
    validatePayload,
    importConfigs,
};
