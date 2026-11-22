/**
 * 牧场建筑 / 地块 —— 升级、加速、解锁、摆放
 *
 * 协议依据(2026-11-17 线上 RPC 探测 + 官方文档):
 *   docs/mc-ranch/建筑升级进度·地块解锁进度·加速道具功能文档.md
 *   docs/mc-ranch/建筑编辑与收纳功能文档.md
 *
 * 服务: gamepb.homesteadpb.HomesteadService (文档里叫 mcHomeService)
 *
 * 错误码(官方):
 *   10441116 没有足够的放置空间     10441121 建筑正在升级中
 *   10441119 该建筑无法收纳         10441122 升级未完成
 *   10441126 建筑背包中不存在该实例 10441125 加速道具数量过多
 *   10441117 已达最高等级           1045126  未找到该建筑
 */
const network = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');

const SERVICE = 'gamepb.homesteadpb.HomesteadService';

// 已发起升级、等待竣工的建筑实例(进程内记忆)。
// 服务端没有可靠的"可领取"标志(AllCells 没这个字段),
// 与其每轮对所有建筑盲试, 不如只记我们真正发起过的那些。
const _pendingUpgrades = new Set();
let _scannedOnce = false;   // 重启后是否已做过一次全量探测

const HOME_ERR = {
    NO_SPACE: 10441116,
    NOT_REMOVABLE: 10441119,
    UPGRADING: 10441121,
    NOT_READY: 10441122,
    NOT_READY_2: 1045122,   // 升级尚未完成(实测线上实际返回这个, 不是 10441122)
    SPEEDUP_TOO_MANY: 10441125,
    NO_SUCH_INSTANCE: 10441126,
    MAX_LEVEL: 10441117,
    NOT_FOUND: 1045126,
    RATE_LIMITED: 1045101,   // 网络繁忙(限流)
    MAX_LEVEL_2: 1045117,    // 该建筑已是最高等级(实测)
    FARM_LEVEL_LOW: 1045134, // 牧场等级不足(实测)
};

function parseHomeErrorCode(e) {
    const m = /code=(\d+)/.exec(String((e && e.message) || e || ''));
    return m ? Number(m[1]) : 0;
}

/** 是不是"当前状态不满足"类错误(不算故障) */
function isExpectedHomeError(e) {
    const c = parseHomeErrorCode(e);
    return c === HOME_ERR.UPGRADING || c === HOME_ERR.NOT_READY || c === HOME_ERR.NOT_READY_2
        || c === HOME_ERR.MAX_LEVEL || c === HOME_ERR.NOT_FOUND
        || c === HOME_ERR.NO_SUCH_INSTANCE || c === HOME_ERR.NO_SPACE
        || c === HOME_ERR.NOT_REMOVABLE || c === HOME_ERR.RATE_LIMITED
        || c === HOME_ERR.MAX_LEVEL_2 || c === HOME_ERR.FARM_LEVEL_LOW;
}

async function call(method, RequestType, payload = {}) {
    const body = RequestType.encode(RequestType.create(payload)).finish();
    const { body: replyBody } = await network.sendMsgAsync(SERVICE, method, body);
    return replyBody;
}

// ============ 建筑列表 ============

async function getBuildingList() {
    const replyBody = await call('GetBuildingList', types.GetBuildingListRequest, {});
    const reply = types.GetBuildingListReply.decode(replyBody);
    return {
        items: (reply.items || []).map(it => ({
            instId: toNum(it.inst_id),
            buildingId: toNum(it.building_id),
            level: toNum(it.level),
            status: toNum(it.status),
        })),
        hasReadyUpgrade: !!reply.has_ready_upgrade,
    };
}

// ============ 建筑升级 ============

/** 发起升级 @param instId 建筑实例 id */
async function upgradeBuilding(instId) {
    const replyBody = await call('UpgradeBuilding', types.UpgradeBuildingRequest, {
        inst_id: toLong(toNum(instId)),
    });
    const reply = types.UpgradeBuildingReply.decode(replyBody);
    return {
        instId: toNum(reply.upgrade && reply.upgrade.inst_id),
        level: toNum(reply.upgrade && reply.upgrade.level),
        endTime: toNum(reply.upgrade && reply.upgrade.end_time),
    };
}

/** 领取升级完成结果 */
async function completeBuildingUpgrade(instId) {
    const replyBody = await call('CompleteBuildingUpgrade', types.CompleteBuildingUpgradeRequest, {
        inst_id: toLong(toNum(instId)),
    });
    const reply = types.CompleteBuildingUpgradeReply.decode(replyBody);
    return {
        facility: reply.facility ? {
            instId: toNum(reply.facility.inst_id),
            buildingId: toNum(reply.facility.building_id),
            level: toNum(reply.facility.level),
        } : null,
        item: reply.item ? { instId: toNum(reply.item.inst_id) } : null,
    };
}

/** 加速升级(1 道具 = 1 秒) */
async function speedUpBuildingUpgrade(instId, itemId, count) {
    const replyBody = await call('SpeedUpBuildingUpgrade', types.SpeedUpBuildingUpgradeRequest, {
        inst_id: toLong(toNum(instId)),
        item_id: toLong(toNum(itemId)),
        count: toLong(toNum(count) || 1),
    });
    const reply = types.SpeedUpBuildingUpgradeReply.decode(replyBody);
    return {
        endTime: toNum(reply.upgrade && reply.upgrade.end_time),
        consumed: (reply.consumed || []).map(i => ({ id: toNum(i.id), count: toNum(i.count) })),
    };
}

// ============ 地块解锁 ============

async function unlockRegion(regionId) {
    const replyBody = await call('UnlockRegion', types.UnlockRegionRequest, {
        region_id: toLong(toNum(regionId)),
    });
    const reply = types.UnlockRegionReply.decode(replyBody);
    return {
        status: toNum(reply.region && reply.region.status),
        occupied: toNum(reply.region_occupied_count),
        quota: toNum(reply.region_quota_count),
    };
}

async function completeRegionUnlock(regionId) {
    const replyBody = await call('CompleteRegionUnlock', types.CompleteRegionUnlockRequest, {
        region_id: toLong(toNum(regionId)),
    });
    const reply = types.CompleteRegionUnlockReply.decode(replyBody);
    return { status: toNum(reply.region && reply.region.status) };
}

async function speedUpRegionUnlock(regionId, itemId, count) {
    const replyBody = await call('SpeedUpRegionUnlock', types.SpeedUpRegionUnlockRequest, {
        region_id: toLong(toNum(regionId)),
        item_id: toLong(toNum(itemId)),
        count: toLong(toNum(count) || 1),
    });
    const reply = types.SpeedUpRegionUnlockReply.decode(replyBody);
    return {
        status: toNum(reply.region && reply.region.status),
        consumed: (reply.consumed || []).map(i => ({ id: toNum(i.id), count: toNum(i.count) })),
    };
}

/** 全量地块状态(登录/校准) */
async function getAllCells() {
    const replyBody = await call('AllCells', types.AllCellsRequest, {});
    const reply = types.AllCellsReply.decode(replyBody);
    return {
        cells: (reply.cells || []).map(c => ({
            regionId: toNum(c.region_id),
            cellType: toNum(c.cell_type),
            seq: toNum(c.seq),
            status: toNum(c.status),          // 1=锁定 2=已解锁
            instId: toNum(c.inst_id),
            capacity: toNum(c.capacity),
        })),
        buildings: (reply.buildings || []).map(b => ({
            instId: toNum(b.inst_id),
            buildingId: toNum(b.building_id),
            level: toNum(b.level),
            status: toNum(b.status),
        })),
        occupied: toNum(reply.region_occupied_count),
        quota: toNum(reply.region_quota_count),
        speedUp: reply.region_speed_up ? [{
            itemId: toNum(reply.region_speed_up.item_id),
            ownCount: toNum(reply.region_speed_up.own_count),
            secsPerItem: toNum(reply.region_speed_up.secs_per_item),
        }] : [],
    };
}

// ============ 建筑编辑与收纳 ============

async function placeFacility(instId, positionX, positionY, rotation = 0) {
    const replyBody = await call('PlaceFacility', types.PlaceFacilityRequest, {
        inst_id: toLong(toNum(instId)),
        position_x: toLong(toNum(positionX)),
        position_y: toLong(toNum(positionY)),
        rotation: toLong(toNum(rotation)),
    });
    const reply = types.PlaceFacilityReply.decode(replyBody);
    return { instId: toNum(reply.facility && reply.facility.inst_id) };
}

async function moveFacility(instanceId, newX, newY, newRotation = 0) {
    const replyBody = await call('MoveFacility', types.MoveFacilityRequest, {
        instance_id: toLong(toNum(instanceId)),
        new_position_x: toLong(toNum(newX)),
        new_position_y: toLong(toNum(newY)),
        new_rotation: toLong(toNum(newRotation)),
    });
    const reply = types.MoveFacilityReply.decode(replyBody);
    return { instId: toNum(reply.facility && reply.facility.inst_id) };
}

async function removeFacility(instanceId) {
    const replyBody = await call('RemoveFacility', types.RemoveFacilityRequest, {
        instance_id: toLong(toNum(instanceId)),
    });
    const reply = types.RemoveFacilityReply.decode(replyBody);
    return { instId: toNum(reply.item && reply.item.inst_id) };
}

// ============ 设施激活(解锁棚) 2026-11-22 抓包 20261122-222723_解锁棚 定案 ============

// 槽位/配置 id: 10001=窝(gid 6001001) 10002=喂食机(gid 7001001) 10003=棚(gid 6002001)
const FACILITY_SHED_SLOT = 10003;
const FACILITY_SHED_GID = 6002001;

/** 激活(解锁)设施: slot=10003 解锁棚(响应 Facility{slot,gid,level}) */
async function activateFacility(slot) {
    const replyBody = await call('ActivateFacility', types.ActivateFacilityRequest, {
        slot: toLong(toNum(slot)),
    });
    const reply = types.ActivateFacilityReply.decode(replyBody);
    return {
        slot: toNum(reply.facility && reply.facility.slot),
        gid: toNum(reply.facility && reply.facility.gid),
        level: toNum(reply.facility && reply.facility.level),
    };
}

/**
 * 自动解锁棚(跟窝一样纳入 autoUpgradeBuildings 的自动升级/竣工):
 * AllCells.buildings 里出现棚(gid 6002001) = 已解锁, 不发请求;
 * 没有才发 ActivateFacility(10003)。解锁后下一轮 autoUpgradeBuildings 自然轮到它。
 * @returns {Promise<{activated:boolean, alreadyUnlocked:boolean}>}
 */
async function autoActivateShed() {
    const result = { activated: false, alreadyUnlocked: false };
    let buildings;
    try {
        buildings = (await getAllCells()).buildings;
    } catch (e) {
        if (!isExpectedHomeError(e)) {
            logWarn('牧场', `读取建筑状态失败(棚解锁判定): ${e.message}`, { module: 'ranch', event: '棚解锁', result: 'error' });
        }
        return result;
    }
    if (buildings.some(b => b.buildingId === FACILITY_SHED_GID)) {
        result.alreadyUnlocked = true;
        return result;
    }
    try {
        const r = await activateFacility(FACILITY_SHED_SLOT);
        result.activated = true;
        log('牧场', `棚已解锁(slot=${r.slot || FACILITY_SHED_SLOT}, gid=${r.gid || FACILITY_SHED_GID}, Lv${r.level || '?'})`, {
            module: 'ranch', event: '棚解锁', result: 'ok',
        });
        await sleep(400);
    } catch (e) {
        // 等级不足(1045134)/材料不足/已激活等都是正常态, 本轮跳过
        if (!isExpectedHomeError(e)) {
            logWarn('牧场', `棚解锁失败: ${e.message}`, { module: 'ranch', event: '棚解锁', result: 'error' });
        }
    }
    return result;
}

// ============ 自动化 ============

/**
 * 自动建筑升级 + 领竣工(对照农场"自动升级土地")。
 * 策略: 有已竣工的先领 → 没在升级且未满级的发起升级。每轮最多 3 个, 避免刷屏。
 */
async function autoUpgradeBuildings(opts = {}) {
    const result = { completed: 0, upgraded: 0, details: [] };
    const maxPerRound = Math.max(1, toNum(opts.maxPerRound) || 3);
    // ⚠ 实测(20261117): GetBuildingList 返回空(那是"未放置的建筑背包"),
    //   已放置的建筑在 AllCellsReply.buildings(#4) 里。
    let list;
    try {
        const all = await getAllCells();
        list = {
            items: all.buildings.map(b => ({ instId: b.instId, buildingId: b.buildingId, level: b.level, status: b.status })),
            hasReadyUpgrade: false,
        };
    } catch (e) {
        if (!isExpectedHomeError(e)) {
            logWarn('牧场', `读取建筑列表失败: ${e.message}`, { module: 'ranch', event: '建筑升级', result: 'error' });
        }
        return result;
    }
    // 1. 领取已完成的升级
    // ⚠ 不能对每个建筑盲目发 CompleteBuildingUpgrade(线上实测会刷 1045122 升级尚未完成,
    //   而且是纯浪费请求)。只对"我们发起过升级"的建筑尝试领取。
    const pendingUpgrades = _pendingUpgrades;
    // 进程重启后 _pendingUpgrades 是空的, 但可能真有升级中的建筑。
    // 首轮对全部建筑静默探一次, 把"正在升级"的收进 pending(不会重复刷日志)。
    if (!pendingUpgrades.size && !_scannedOnce) {
        _scannedOnce = true;
        for (const it of list.items) {
            try {
                const r = await completeBuildingUpgrade(it.instId);
                if (r.facility) {
                    result.completed += 1;
                    result.details.push(`竣工#${it.instId}→Lv${r.facility.level}`);
                    log('牧场', `建筑#${it.instId} 升级完成 → Lv${r.facility.level}`, {
                        module: 'ranch', event: '建筑升级', result: 'ok', instId: it.instId, level: r.facility.level,
                    });
                }
            } catch (e) {
                const code = parseHomeErrorCode(e);
                // 还在升级中 → 收进待领列表
                if (code === HOME_ERR.NOT_READY_2 || code === HOME_ERR.NOT_READY || code === HOME_ERR.UPGRADING) {
                    pendingUpgrades.add(it.instId);
                }
            }
            await sleep(300);
        }
    }
    for (const instId of [...pendingUpgrades]) {
        if (result.completed >= maxPerRound) break;
        try {
            const r = await completeBuildingUpgrade(instId);
            if (r.facility) {
                result.completed += 1;
                result.details.push(`竣工#${instId}→Lv${r.facility.level}`);
                log('牧场', `建筑#${instId} 升级完成 → Lv${r.facility.level}`, {
                    module: 'ranch', event: '建筑升级', result: 'ok', instId, level: r.facility.level,
                });
                pendingUpgrades.delete(instId);   // 领到了, 移除
            }
            await sleep(400);
        } catch (e) {
            const code = parseHomeErrorCode(e);
            // 还在升级中/未完成 → 保留在待领列表, 下次再试
            if (code === HOME_ERR.NOT_READY_2 || code === HOME_ERR.NOT_READY || code === HOME_ERR.UPGRADING) {
                // 静默, 下次继续
            } else {
                pendingUpgrades.delete(instId);   // 其他错误(没这个建筑等), 不再重试
                if (!isExpectedHomeError(e)) {
                    logWarn('牧场', `领取竣工失败 #${instId}: ${e.message}`, { module: 'ranch', event: '建筑升级', result: 'error' });
                }
            }
        }
    }
    // 2. 发起新升级
    for (const it of list.items) {
        if (result.upgraded >= maxPerRound) break;
        // 实测 status: 9/10/11 = 正常(非升级中); 升级中的值未观测到, 先不按 status 过滤
        // (交给服务端返回 10441121 判断)
        try {
            const r = await upgradeBuilding(it.instId);
            result.upgraded += 1;
            pendingUpgrades.add(it.instId);   // 记下, 后续轮次只对它在尝试领竣工
            result.details.push(`升级#${it.instId}→Lv${r.level}`);
            log('牧场', `建筑#${it.instId} 开始升级 → Lv${r.level}`, {
                module: 'ranch', event: '建筑升级', result: 'ok', instId: it.instId, level: r.level,
            });
            await sleep(500);
        } catch (e) {
            // 满级(10441117)/升级中(10441121)/材料不足 都属正常
            if (!isExpectedHomeError(e)) {
                logWarn('牧场', `升级失败 #${it.instId}: ${e.message}`, { module: 'ranch', event: '建筑升级', result: 'error' });
            }
        }
    }
    return result;
}

/**
 * 自动地块解锁 + 领竣工。
 * @returns {{completed:number, unlocked:number, details:string[]}}
 */
async function autoUnlockRegions(opts = {}) {
    const result = { completed: 0, unlocked: 0, details: [] };
    const maxPerRound = Math.max(1, toNum(opts.maxPerRound) || 2);
    let all;
    try {
        all = await getAllCells();
    } catch (e) {
        if (!isExpectedHomeError(e)) {
            logWarn('牧场', `读取地块状态失败: ${e.message}`, { module: 'ranch', event: '地块解锁', result: 'error' });
        }
        return result;
    }
    // ⚠ 实测(20261117): 地块 status 1=锁定(61 个) 2=已解锁(30 个)。
    //   配额 25/25 满时不能再解锁, 直接跳过 —— 否则会对 61 个锁定地块乱发请求被限流(1045101)。
    if (all.quota > 0 && all.occupied >= all.quota) {
        log('牧场', `地块配额已满(${all.occupied}/${all.quota}), 跳过解锁`, {
            module: 'ranch', event: '地块解锁', result: 'skip',
        });
        return result;
    }
    // 真正"解锁中待领取"的地块无法从 status 区分, 只对首个锁定项试一次, 失败即停
    for (const c of [all.cells.find(x => x.status === 1)].filter(Boolean)) {
        if (result.completed >= maxPerRound) break;
        try {
            await completeRegionUnlock(c.regionId);
            result.completed += 1;
            result.details.push(`地块${c.regionId}`);
            log('牧场', `地块#${c.regionId} 解锁完成`, {
                module: 'ranch', event: '地块解锁', result: 'ok', regionId: c.regionId,
            });
            await sleep(400);
        } catch (e) {
            if (!isExpectedHomeError(e)) {
                logWarn('牧场', `地块#${c.regionId} 领取失败: ${e.message}`, { module: 'ranch', event: '地块解锁', result: 'error' });
            }
        }
    }
    // 锁定的(status=1)按序号从小到大尝试发起解锁; 额度/材料不足就停
    const locked = all.cells.filter(c => c.status === 1).sort((a, b) => a.seq - b.seq).slice(0, 1);
    for (const c of locked) {
        if (result.unlocked >= maxPerRound) break;
        try {
            await unlockRegion(c.regionId);
            result.unlocked += 1;
            result.details.push(`发起${c.regionId}`);
            log('牧场', `地块#${c.regionId} 开始解锁`, {
                module: 'ranch', event: '地块解锁', result: 'ok', regionId: c.regionId,
            });
            await sleep(500);
        } catch {
            // 额度不足(region_quota 满)/材料不足 → 正常, 停
            // 限流/额度不足/材料不足都属正常, 静默停止(每轮只试一次)
            break;
        }
    }
    return result;
}

module.exports = {
    HOME_ERR,
    isExpectedHomeError,
    parseHomeErrorCode,
    getBuildingList,
    upgradeBuilding,
    completeBuildingUpgrade,
    speedUpBuildingUpgrade,
    unlockRegion,
    completeRegionUnlock,
    speedUpRegionUnlock,
    getAllCells,
    placeFacility,
    moveFacility,
    removeFacility,
    activateFacility,
    autoActivateShed,
    autoUpgradeBuildings,
    autoUnlockRegions,
};
