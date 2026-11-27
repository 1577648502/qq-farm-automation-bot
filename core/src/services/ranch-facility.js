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
const { shouldLogOnce } = require('../utils/log-throttle');

const SERVICE = 'gamepb.homesteadpb.HomesteadService';

/**
 * 建筑实例 → 显示名(2026-11-23 用户要求: 升级日志里的 #10003 编号改成真实名字)。
 * 线上实测(instId ↔ buildingId ↔ kind, 4 账号一致):
 *   10001=窝  10002=牧草机(槽位固定, GetFacilityDetail 名称="牧草机")
 *   10003=棚(解锁后固定在 10003; acc3/4/6 早期实例=3 的那批 6002001 也是棚)
 *   10000=留言板(装饰)  其余未知 → 退回 #编号。
 * ⚠ 旧观测"棚实例不固定(=3)"是升级前老号的状态; 解锁接口把棚放到 slot 10003,
 *   AllCells 里 inst_id=10003 → 两者都是棚, 统一按段判。
 */
function buildingInstName(instId) {
    const id = Number(instId) || 0;
    if (id === 10001) return '窝';
    if (id === 10002) return '牧草机';
    if (id === 10003) return '棚';
    if (id === 10000) return '留言板';
    if (id >= 1 && id <= 999) return '棚';   // 早期解锁的棚实例段(实测 inst=3)
    return `#${id}`;
}

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

// 棚解锁有服务端等级门槛(2026-11-22 用户定案"到等级自动解锁就行"):
// 1045134 牧场等级不足时记下当时玩家等级, 30 分钟窗口内不再发请求;
// 玩家等级一变(升级了)立即放行重试 —— 等级一到就自动解锁, 不空打请求。
// ⭐ 门槛定案(2026-11-27 五号线上对照): **牧场22级**, 见下方 SHED_ACTIVATE_LEVEL 注释。
//   (2026-11-26 的"21级"结论已被推翻: 21级的账号3/账号4 都没有棚组, 服务端也不报错。)
// ⚠ 升档(UpgradeBuilding)门槛 牧场25级: 润出去激活成功后升级报 1045134。
//   低等级账号每轮的 1045115 由 unlockShed breaker(3 次→30min 熔断)兜底, 不会刷屏。
// ⚠ 已解锁判定: 已激活棚 buildingId 仍是 6002001(FacilitiesNotify 定案),
//   区分标志是 instId=10003(激活后升格标准槽位); 未激活是编辑器实例 instId=3。
//   RanchDetail 返回棚组 = 已解锁, 这是唯一可靠信号(2026-11-26 润出去抓包实锤)。
const SHED_LEVEL_RETRY_MS = 30 * 60 * 1000;
let _shedLevelBlock = { until: 0, levelSeen: 0 };
let _shedUnlockedLogged = false;   // 解锁成功日志只打一次(2026-11-23 重复刷屏修复)
// ⚠ 2026-11-26: "已激活但档1"和"未激活"的 buildingId 都是 6002001, 无法从 AllCells 区分。
//   激活成功后在这里记住(进程内), 避免每轮重复发 ActivateFacility(重复发无害但刷日志)。
const _shedActivated = new Set();

function getPlayerLevelForShed() {
    try {
        const { getUserState } = require('../utils/network');
        const st = getUserState() || {};
        // ⭐ 牧场等级(BasicInfo#20, 服务端权威) — 旧读 level=农场等级, 门槛判断全错
        const rl = Number(st.ranchLevel) || 0;
        // ⚠ 2026-11-27: #20 会滞后一级(账号2 服务端报 22, 按 BigFarmLevel 表 exp 236597 已是 23),
        //   所以取两者较大值, 免得"经验够了但等级字段没刷新"把号卡在门槛外。
        const byExp = levelFromRanchExp(st.ranchExp);
        const best = Math.max(rl, byExp);
        if (best > 0) return best;
        return Number(st.level) || 0;
    } catch {
        return 0;
    }
}

/** 按 BigFarmLevel 等级表从牧场经验反推等级(表来自 delayRes, 65 级非线性, 六号实测吻合) */
let _bigFarmLevels = null;
function levelFromRanchExp(ranchExp) {
    const n = Number(ranchExp) || 0;
    if (!(n > 0)) return 0;
    if (!_bigFarmLevels) {
        try { _bigFarmLevels = require('../gameConfig/BigFarmLevel.json'); } catch { _bigFarmLevels = []; }
    }
    let lvl = 0;
    for (const row of _bigFarmLevels) {
        if (n >= (Number(row.exp) || 0)) lvl = Math.max(lvl, Number(row.level) || 0);
    }
    return lvl;
}

/**
 * 自动解锁棚(跟窝一样纳入 autoUpgradeBuildings 的自动升级/竣工):
 * 服务端 GetRanchDetail 返回棚组 = 已解锁, 不发请求;
 * 否则按牧场等级决定是否发 ActivateFacility。解锁后下一轮 autoUpgradeBuildings 自然轮到它。
 *
 * 判据演变(全部线上实测, 勿回退):
 * ⚠ 2026-11-23: buildingId 会随升级变档(窝 6001001→…→6001004, 棚 6002001→6002002),
 *   判"已解锁"必须按段而不是 ===6002001。(旧判定 `>=6002001` 把 6002001 当已解锁
 *   → 润出去/acc3/4/6 的棚永远停在档1。)
 * ⚠ 2026-11-26 三次实锤(用户抓包 20261126-134733_润出去 定案, 推翻"6002002=已激活"):
 *   已激活棚 buildingId **仍是 6002001**(FacilitiesNotify #2=6002001, #10=capacity=3),
 *   北栎 11-23 的 6002002 是**升档后**的 id, 不是激活后 —— isShedBuildingId(>=6002002)
 *   对激活但未升档的棚判"未解锁" → 每轮空发 ActivateFacility → 1045115(账号1 的日志根因)。
 *   可靠信号只有两个: RanchDetail 返回棚组, 或棚建筑 instId=10003(激活后升格标准槽位;
 *   未激活是编辑器实例 instId=3)。
 * ⚠ 激活门槛 = 牧场22级(2026-11-27 五号线上对照, 见 SHED_ACTIVATE_LEVEL 注释):
 *   21级的账号3/账号4 都没有棚组(而且发 ActivateFacility 服务端不报错也不解锁),
 *   22级的账号2、39级的账号1 有棚组 —— 旧"21级"结论来自一次字段滞后的抓包, 已推翻。
 *   (激活参数本身仍须传棚建筑实例号, 见 getShedInstIdFromBuildings。)
 * @returns {Promise<{activated:boolean, alreadyUnlocked:boolean, skipped?:string}>}
 */

// 棚激活最低牧场等级 = 22(2026-11-27 五号线上对照定案, 推翻此前"21级"):
//   有棚: 账号1 牧场39级(exp 785736, pen 6) / 账号2 牧场22级(exp 236597, pen 3)
//   无棚: 账号3 牧场21级(exp 200457) / 账号4 牧场21级(exp 190403) / 账号6 牧场20级(exp 183830)
//   BigFarmLevel 表 Lv22 门槛 = 208200 exp → 21 级(188800~208199)经验再高也没有棚组。
//   ⚠ 21 级发 ActivateFacility(10003) 服务端**不报错也不解锁**(账号3 实测: 回 facility 回显,
//     GetRanchDetail 仍无棚组) —— 别把"请求成功"当解锁, 判据只有 RanchDetail 的棚组。
//   ⚠ 21 级往棚里放 75xxx 巨大崽报 1045206"该动物与栏舍类型不符", 那是棚不存在、
//     请求落到窝上导致的, 不是幼崽选错。
const SHED_ACTIVATE_LEVEL = 22;
function isShedBuildingId(buildingId) {
    const id = Number(buildingId) || 0;
    return id >= 6002002 && id <= 6002999;
}

/**
 * 棚是否已解锁 —— 可靠判据(2026-11-26 定案): 服务端 GetRanchDetail 返回棚组。
 * 已激活棚 buildingId 仍是 6002001(AllCells 区分不了), 棚组出现 = 服务端已开放。
 * RanchDetail 查询失败/场景未解锁时返回 false(调用方继续走激活尝试, 有等级窗口兜底)。
 * 检测结果缓存 10min, 避免每轮激活检查都打一次 GetRanchDetail。
 */
let _shedGroupCheck = { at: 0, unlocked: false };
const SHED_GROUP_CHECK_TTL = 10 * 60 * 1000;

/**
 * 从 AllCells.buildings 里找棚建筑(6002001~6002999 段)的真实实例号。
 * 未激活棚是编辑器实例(实测 3/4/6 号都是 instId=3), 激活后升格成 10003。
 * 查不到返回 0(调用方退回 FACILITY_SHED_SLOT=10003 兜底)。
 */
function getShedInstIdFromBuildings(buildings) {
    const shed = (buildings || []).find(b => {
        const id = Number(b.buildingId) || 0;
        return id >= 6002001 && id <= 6002999;
    });
    return shed ? (Number(shed.instId) || 0) : 0;
}

/** 手动激活入口用: 实时查 AllCells 拿棚实例号(查不到退回 10003) */
async function getShedInstId() {
    try {
        return getShedInstIdFromBuildings((await getAllCells()).buildings) || FACILITY_SHED_SLOT;
    } catch {
        return FACILITY_SHED_SLOT;
    }
}

async function isShedGroupPresent() {
    if (Date.now() - _shedGroupCheck.at < SHED_GROUP_CHECK_TTL) return _shedGroupCheck.unlocked;
    try {
        // 循环依赖不能 require('./ranch'), 直接发同一 RPC(空 body=看自己, 与 ranch.getRanchDetail 同形)
        const body = types.GetRanchDetailRequest.encode(types.GetRanchDetailRequest.create({})).finish();
        const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'GetRanchDetail', body);
        const reply = types.GetRanchDetailReply.decode(replyBody);
        const hasPen = (reply.ranches || []).some(r => toNum(r.husbandry_type) === 2);
        _shedGroupCheck = { at: Date.now(), unlocked: hasPen };
        return hasPen;
    } catch {
        // 查询失败不当成"未解锁"(可能是场景/网络瞬时问题), 缓存一个短窗口避免重试风暴
        _shedGroupCheck = { at: Date.now() - SHED_GROUP_CHECK_TTL + 60 * 1000, unlocked: _shedGroupCheck.unlocked };
        return _shedGroupCheck.unlocked;
    }
}

async function autoActivateShed() {
    const result = { activated: false, alreadyUnlocked: false };
    // ① 最可靠信号: RanchDetail 有棚组 = 服务端已开放, 直接短路
    if (_shedActivated.size > 0 || (await isShedGroupPresent())) {
        result.alreadyUnlocked = true;
        return result;
    }
    // ② 激活门槛 = 牧场等级(见 SHED_ACTIVATE_LEVEL 注释), 不够直接等升级, 不空打请求
    const lvl = getPlayerLevelForShed();
    if (lvl > 0 && lvl < SHED_ACTIVATE_LEVEL) {
        result.skipped = `牧场${lvl}级<${SHED_ACTIVATE_LEVEL}级(激活门槛)`;
        return result;
    }
    let buildings;
    try {
        buildings = (await getAllCells()).buildings;
    } catch (e) {
        if (!isExpectedHomeError(e)) {
            logWarn('牧场', `读取建筑状态失败(棚解锁判定): ${e.message}`, { module: 'ranch', event: '棚解锁', result: 'error' });
        }
        return result;
    }
    if (buildings.some(b => isShedBuildingId(b.buildingId))) {
        result.alreadyUnlocked = true;
        return result;
    }
    // 等级不足窗口: 等级没变就不发请求(到等级立即放行)
    if (Date.now() < _shedLevelBlock.until && getPlayerLevelForShed() === _shedLevelBlock.levelSeen) {
        result.skipped = '等级不足(等待升级)';
        return result;
    }
    // ⚠ #1 = 棚建筑实例号(AllCells.buildings 里 6002xxx 段的 instId), 不是固定 10003。
    //   激活成功后该实例升格成 10003(润出去抓包实测); 传错号服务端回 1045115"建筑不存在"。
    //   查不到真实实例号时退回 10003(兼容润出去型布局, 棚实例本来就是 10003 的号)。
    const shedInst = getShedInstIdFromBuildings(buildings) || FACILITY_SHED_SLOT;
    try {
        const r = await activateFacility(shedInst);
        result.activated = true;
        _shedLevelBlock = { until: 0, levelSeen: 0 };
        _shedActivated.add(String(shedInst));                        // 记住已激活, 档1(6002001)也不重复发
        _shedGroupCheck = { at: Date.now(), unlocked: true };       // 激活成功, 同步刷新棚组缓存
        // 2026-11-23: 解锁成功日志只打一次(模块内记忆) —— 旧逻辑因 buildingId 变档误判,
        // 同一号 24h 刷了 50 条"棚已解锁"; 且响应里的 level(#3=7)是服务端内部值,
        // 不是小程序显示的棚档位(6002002 实显 Lv3), 打出来只会误导, 不再带等级。
        if (!_shedUnlockedLogged) {
            _shedUnlockedLogged = true;
            log('牧场', `棚已解锁(instId=${shedInst}, slot=${r.slot || shedInst}, gid=${r.gid || FACILITY_SHED_GID})`, {
                module: 'ranch', event: '棚解锁', result: 'ok',
            });
        }
        await sleep(400);
    } catch (e) {
        const code = parseHomeErrorCode(e);
        if (code === HOME_ERR.FARM_LEVEL_LOW) {
            // 到等级自动解锁: 记住"当前等级还不够", 升级后(等级变化)立即重试
            _shedLevelBlock = { until: Date.now() + SHED_LEVEL_RETRY_MS, levelSeen: getPlayerLevelForShed() };
        } else if (!isExpectedHomeError(e)) {
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
                    result.details.push(`${buildingInstName(it.instId)}竣工→Lv${r.facility.level}`);
                    log('牧场', `${buildingInstName(it.instId)}(inst=${it.instId}) 升级完成 → Lv${r.facility.level}`, {
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
                result.details.push(`${buildingInstName(instId)}竣工→Lv${r.facility.level}`);
                log('牧场', `${buildingInstName(instId)}(inst=${instId}) 升级完成 → Lv${r.facility.level}`, {
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
                    logWarn('牧场', `领取${buildingInstName(instId)}竣工失败(inst=${instId}): ${e.message}`, { module: 'ranch', event: '建筑升级', result: 'error' });
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
            result.details.push(`${buildingInstName(it.instId)}开始升级→Lv${r.level}`);
            log('牧场', `${buildingInstName(it.instId)}(inst=${it.instId}) 开始升级 → Lv${r.level}`, {
                module: 'ranch', event: '建筑升级', result: 'ok', instId: it.instId, level: r.level,
            });
            await sleep(500);
        } catch (e) {
            // 满级(10441117)/升级中(10441121)/材料不足 都属正常
            if (!isExpectedHomeError(e)) {
                logWarn('牧场', `${buildingInstName(it.instId)}升级失败(inst=${it.instId}): ${e.message}`, { module: 'ranch', event: '建筑升级', result: 'error' });
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
    //   配额满是静态条件, 6 小时提示一次就够(2.6h 内曾刷 91 条)。
    if (all.quota > 0 && all.occupied >= all.quota) {
        if (shouldLogOnce('ranch_land_quota_full', `${all.occupied}/${all.quota}`, 6 * 60 * 60 * 1000)) {
            log('牧场', `地块配额已满(${all.occupied}/${all.quota}), 跳过解锁`, {
                module: 'ranch', event: '地块解锁', result: 'skip',
            });
        }
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
    getShedInstId,
    autoActivateShed,
    autoUpgradeBuildings,
    autoUnlockRegions,
};
