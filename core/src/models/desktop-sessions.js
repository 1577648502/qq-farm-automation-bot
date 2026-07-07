/**
 * 桌面登录 Session 数据管理
 * 持久化扫码登录的 QQ session 记录（QQ号、PID、状态等）
 */
const path = require('node:path');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');

const SESSIONS_FILE = getDataFile('desktop-sessions.json');
const LEGACY_OWNER_USERNAME = 'carsen';

/**
 * @typedef {Object} DesktopSession
 * @property {string} uin - QQ号
 * @property {string} nickname - QQ昵称
 * @property {number|null} pid - QQ.exe 进程PID (null=未启动)
 * @property {'offline'|'online'|'login_failed'} status - 登录状态
 * @property {string} cookies - 登录 cookies (JSON string)
 * @property {number} createdAt - 创建时间戳
 * @property {number} lastActiveAt - 最后活跃时间戳
 * @property {string} processPath - QQ.exe 路径
 */

/** @type {{ sessions: DesktopSession[] }} */
let cache = null;

function load() {
    if (cache) return cache;
    cache = readJsonFile(SESSIONS_FILE, () => ({ sessions: [] }));
    if (!Array.isArray(cache.sessions)) cache.sessions = [];
    return cache;
}

function save() {
    ensureDataDir();
    writeJsonFileAtomic(SESSIONS_FILE, cache || { sessions: [] });
}

function getSessionOwner(session) {
    return String((session && session.ownerUsername) || LEGACY_OWNER_USERNAME).trim();
}

function canAccessSession(session, currentUser) {
    if (!session || !currentUser) return false;
    if (currentUser.role === 'admin') return true;
    return getSessionOwner(session) === String(currentUser.username || '').trim();
}

function filterVisibleSessions(sessions, currentUser) {
    const list = Array.isArray(sessions) ? sessions : [];
    return list.filter(session => canAccessSession(session, currentUser));
}

/**
 * 获取所有 session
 */
function getAll() {
    return load().sessions;
}

/**
 * 按 uin 查找 session
 * @param {string} uin
 * @returns {DesktopSession|undefined}
 */
function findByUin(uin) {
    return load().sessions.find(s => s.uin === String(uin).trim());
}

/**
 * 添加或更新 session
 * @param {DesktopSession} session
 */
function upsert(session) {
    const data = load();
    const idx = data.sessions.findIndex(s => s.uin === session.uin);
    if (idx >= 0) {
        data.sessions[idx] = { ...data.sessions[idx], ...session };
    } else {
        data.sessions.push(session);
    }
    save();
}

/**
 * 删除 session
 * @param {string} uin
 */
function remove(uin) {
    const data = load();
    data.sessions = data.sessions.filter(s => s.uin !== String(uin).trim());
    save();
}

/**
 * 更新 session 状态
 * @param {string} uin
 * @param {Partial<DesktopSession>} updates
 */
function update(uin, updates) {
    const data = load();
    const session = data.sessions.find(s => s.uin === String(uin).trim());
    if (session) {
        Object.assign(session, updates);
        save();
    }
}

module.exports = {
    getAll,
    findByUin,
    upsert,
    remove,
    update,
    canAccessSession,
    filterVisibleSessions,
    getSessionOwner,
    LEGACY_OWNER_USERNAME,
};
