/**
 * 节令小礼 (solartermspb) - 查询节令列表 + 领取节令奖励
 *
 * 复用现有 sendMsgAsync 调用 gamepb.solartermspb.SolarTermsService:
 *   GetSolarTerms    查询全部节令(大暑/立秋/七夕/处暑...)及领取状态
 *   ClaimSolarTerms  按节令 id 领取小礼 (实测响应回奖励物品 + 更新后的节令)
 */

const { getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, toLong, log, logWarn } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');

const SERVICE = 'gamepb.solartermspb.SolarTermsService';

// 实测状态: 未开始=1, 可领取=2, 已领取=3, 已过期=4/5(4与5区别未确认)
const SOLAR_TERM_STATUS = {
    NOT_STARTED: 1,
    CLAIMABLE: 2,
    CLAIMED: 3,
};

function normalizeItem(item) {
    const id = toNum(item && item.id);
    const info = getItemById(id);
    return {
        id,
        name: info && info.name ? String(info.name) : `物品#${id}`,
        count: toNum(item && item.count),
        image: getItemImageById(id) || '',
    };
}

function normalizeTerm(term, serverTime) {
    if (!term) return null;
    const status = toNum(term.status);
    const startTime = toNum(term.start_time);
    const endTime = toNum(term.end_time);
    const now = toNum(serverTime) || Math.floor(Date.now() / 1000);
    return {
        id: toNum(term.id),
        name: String(term.name || ''),
        status,
        startTime,
        endTime,
        active: now >= startTime && now <= endTime,
        claimable: status === SOLAR_TERM_STATUS.CLAIMABLE,
        claimed: status === SOLAR_TERM_STATUS.CLAIMED,
        items: (Array.isArray(term.items) ? term.items : []).map(normalizeItem),
    };
}

async function getSolarTerms() {
    const body = types.GetSolarTermsRequest.encode(types.GetSolarTermsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetSolarTerms', body);
    const reply = types.GetSolarTermsReply.decode(replyBody);
    const serverTime = toNum(reply && reply.server_time);
    const terms = (Array.isArray(reply && reply.terms) ? reply.terms : [])
        .map(term => normalizeTerm(term, serverTime))
        .filter(Boolean)
        .sort((a, b) => a.startTime - b.startTime);
    return {
        updatedAt: Date.now(),
        serverTime,
        terms,
        claimableCount: terms.filter(t => t.claimable).length,
    };
}

async function claimSolarTerms(termId) {
    const id = toNum(termId);
    if (!id) throw new Error('缺少节令 ID');
    const body = types.ClaimSolarTermsRequest.encode(types.ClaimSolarTermsRequest.create({
        id: toLong(id),
    })).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'ClaimSolarTerms', body);
    const reply = types.ClaimSolarTermsReply.decode(replyBody);
    return {
        id,
        awards: (Array.isArray(reply && reply.awards) ? reply.awards : []).map(normalizeItem),
        term: normalizeTerm(reply && reply.term),
    };
}

// 节令小礼自动领取: 领取全部可领节令(开关关闭时直接返回)
async function checkAndClaimSolarTerms() {
    if (!isAutomationOn('solar_terms')) return { skipped: true };
    try {
        const state = await getSolarTerms();
        const claimable = state.terms.filter(t => t.claimable);
        if (!claimable.length) return { skipped: true, reason: 'nothing_claimable' };
        const results = [];
        for (const term of claimable) {
            try {
                const result = await claimSolarTerms(term.id);
                const awardText = (result.awards || []).map(a => `${a.name}×${a.count}`).join('、');
                log('活动', `节令小礼自动领取成功[${term.name}]${awardText ? `: ${awardText}` : ''}`, { module: 'activity', event: '节令小礼', result: 'success' });
                results.push(result);
            } catch (e) {
                logWarn('活动', `节令小礼自动领取失败[${term.name}]: ${e.message}`, { module: 'activity', event: '节令小礼', result: 'error' });
            }
        }
        return { claimed: results };
    } catch (e) {
        logWarn('活动', `节令小礼自动检测失败: ${e.message}`, { module: 'activity', event: '节令小礼', result: 'error' });
        return { error: e.message };
    }
}

module.exports = {
    SOLAR_TERM_STATUS,
    getSolarTerms,
    claimSolarTerms,
    checkAndClaimSolarTerms,
};
