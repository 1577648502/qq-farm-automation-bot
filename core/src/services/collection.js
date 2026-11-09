/**
 * 典藏室(珍藏室) —— 藏品查询 / 展示 / 升星 / 评分奖励
 *
 * ══════════════════════════════════════════════════════════════════
 * 协议依据: 2026-11-07 抓包 `20261107-155647_典藏室`(这次是真数据, 不是空壳)
 *
 *   GetCollections          C->S 0a0101                  查询
 *   UpgradeCollection       C->S 08 01 10 <itemId>       升星
 *   SwitchSceneDisplay      C->S 0a0a 0801 1206 0801 10<itemId>  切换展示
 *   ClaimCollectionReward   C->S 08 01                   领取评分奖励
 *   DisplayChangeNotify     S->C  展示变更推送(结构同 SwitchSceneDisplay 回显)
 *
 * GetCollections 回复实测:
 *   #1 = 1
 *   #2(repeated 藏品) { #1 藏品ID, #2 星级, #3 已激活, #4 获得时间, #5 疑似展示位 }
 *   #5 = 1000  已领到的评分档位
 *   #6 = 1200  当前累计评分
 *   #2 { #1: 场景, #2: { #1: 展示位, #2: 藏品ID } }   ← 当前展示位(与 entries 同字段号)
 *
 * UpgradeCollection 回复实测: #1=1 #2=itemId #3=升级后星级 #4=升级后评分
 *   700005: 600  700004: 1200   (严格等比 300 → 600 → 1200)
 *
 * ClaimCollectionReward 回复实测: #2=1200(当前评分) #3=1000(覆盖到的档位) #4{#50=1000}
 *
 * ══════════════════════════════════════════════════════════════════
 * ══════════════════════════════════════════════════════════════════
 * 2026-11-09 抓包 `20261109-082655_典藏室激活个升星` 复核(关键):
 *
 *   ① **没有"激活"接口**。整个会话只有 4 次 GetCollections、2 次 UpgradeCollection、
 *      1 次 ClaimCollectionReward, 没有任何其它 collection 请求。
 *      新获得的 700002 直接以 activated=1 出现在 GetCollections 里
 *      (获得时间 1794153658, 早于本次抓包) → **激活由服务端在发放时完成**,
 *      客户端(和我们)都不需要、也无法发激活请求。
 *
 *   ② **升星不消耗背包物品**: 背包 61 项里一个藏品都没有, 两次 UpgradeCollection
 *      仍然成功。所以"背包有同名精灵才能升星"是错误判断(已删除),
 *      能不能升只能由服务端判定(不足时回 `1000019 xxx不足`)。
 *
 *   ③ 升星返回值 #4 = **全房间累计评分**: 600 → 1200 → 1800 → 2280
 *      (前三次各 +600, 第二次升 700005 额外 +480)。
 *
 *   ④ #5 是**该藏品的吞噬次数**(不是"已领档位"/"展示位"):
 *      700005 升到 2 星时由 1 → 2, 700002 新获得时为 1。
 *
 *   ⑤ ClaimCollectionReward 成功: 评分 2280, 覆盖到 2000 档
 *      (说明档位间隔不是线性的, 仍需以服务端反馈为准)。
 * ══════════════════════════════════════════════════════════════════
 *
 * 两个由用户确认的关键事实:
 *   ① 藏品**不在背包里**(ItemService.Bag 中没有 type=35 物品),
 *      获得 = 开藏品礼包后服务端直接登记到这里, `#3 activated=1` 即"已激活";
 *      客户端**不需要**发任何激活请求 —— 抓包里全程没有 Use 请求。
 *   ② 升星消耗的是**同名精灵本身**(从盒子里开出来的),
 *      所以 43.9s 第二次升 700005 失败: `1000019 桃米不足`(背包里没有第二个桃米)。
 *      → 自动升星必须**先确认背包里有同名精灵**, 否则必定失败刷错误日志。
 */

const protobuf = require('protobufjs');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { getItemById, getItemImageById, getAllItems } = require('../config/gameConfig');
const { log, toNum, sleep } = require('../utils/utils');

const SERVICE = 'gamepb.collectionpb.CollectionService';

/** 典藏室开启等级(用户确认: 125 级才开启) */
const COLLECTION_UNLOCK_LEVEL = 125;

/** 连续这么多次升星失败就放弃本轮(通常意味着材料耗尽, 继续试只是白刷请求) */
const MAX_CONSECUTIVE_FAIL = 3;

// 物品类型
const ITEM_TYPE_COLLECTION = 35;   // 藏品(可陈列)
const ITEM_TYPE_PEDESTAL = 34;     // 展台
const ITEM_ID_COLLECTION_POINT = 3002;  // 典藏收藏点(进度值)

/** 藏品系列: 图标路径里的 icon_collect_<n>_<m> → 系列 n */
const SERIES_NAMES = {
    1: '氧气小精灵',
    2: '田园灵偶',
    3: '漫游客',
    4: '青叶风灵',
    5: '果冻系列',
};

// ============ 通用 wire 工具(展示位与 entries 共用字段号, 只能自己拆) ============

function parseWire(buf) {
    const out = [];
    const reader = protobuf.Reader.create(buf);
    try {
        while (reader.pos < reader.len) {
            const tag = reader.uint64();
            const f = Math.floor(Number(tag) / 8);
            const w = Number(tag) & 7;
            if (w === 0) out.push({ f, w, v: reader.uint64().toString() });
            else if (w === 2) out.push({ f, w, v: Buffer.from(reader.bytes()) });
            else if (w === 1) { out.push({ f, w, v: buf.slice(reader.pos, reader.pos + 8) }); reader.skip(8); }
            else if (w === 5) { out.push({ f, w, v: buf.slice(reader.pos, reader.pos + 4) }); reader.skip(4); }
            else break;
        }
    } catch { /* 截断保底 */ }
    return out;
}
const findField = (fields, f) => fields.find((x) => x.f === f) || null;
const num = (x) => {
    if (!x) return 0;
    if (Buffer.isBuffer(x.v)) return 0;      // wire2 不是数字
    const n = Number(x.v);
    return Number.isFinite(n) ? n : 0;
};

// ============ 查询 ============

/**
 * 解析展示位: 形如 { #1: 场景, #2: { #1: 展示位, #2: 藏品ID, #3: ? } }
 * 返回 { scene, slot, itemId }
 */
function parseDisplay(buf) {
    if (!buf || !buf.length) return null;
    const top = parseWire(buf);
    const inner = findField(top, 2);
    const body = inner && inner.w === 2 ? parseWire(inner.v) : [];
    return {
        scene: num(findField(top, 1)),
        slot: num(findField(body, 1)),
        itemId: num(findField(body, 2)),
        field3: num(findField(body, 3)),
    };
}

/**
 * 解析 GetCollections 原始回包
 *
 * 实测结构(2026-11-07 抓包 68.75s, 54B):
 *   外层 {
 *     #1: <状态内层>,                       ← 藏品与评分都在这里
 *     #2: <展示位> = { #1: 场景, #2: { #1: 展示位, #2: 藏品ID } }
 *   }
 *   状态内层 { #1: 1, #2(repeated 藏品), #5: 已领评分, #6: 当前评分 }
 *   藏品 { #1 item_id, #2 星级, #3 已激活, #4 获得时间, #5 疑似展示位 }
 */
function parseCollectionsReply(buf) {
    const out = { field1: 0, entries: [], displays: [], claimedScore: 0, totalScore: 0 };
    if (!buf || !buf.length) return out;
    const top = parseWire(buf);

    // 状态内层: 外层 #1
    const boxed = findField(top, 1);
    const inner = boxed && boxed.w === 2 ? parseWire(boxed.v) : top;
    out.field1 = num(findField(inner, 1));
    out.claimedScore = num(findField(inner, 5));
    out.totalScore = num(findField(inner, 6));
    for (const x of inner) {
        if (x.f !== 2 || x.w !== 2) continue;
        const sub = parseWire(x.v);
        const id = num(findField(sub, 1));
        if (id <= 0) continue;
        out.entries.push({
            itemId: id,
            star: num(findField(sub, 2)),
            activated: num(findField(sub, 3)),
            obtainedAt: num(findField(sub, 4)),
            // 11-09 抓包: 700005 升到 2 星时 #5 由 1 → 2, 与星级同步增长
            // (旧推测"展示位"被证伪: 展示位在外层 #2, 与这里无关)
            devour: num(findField(sub, 5)),
        });
    }

    // 展示位: 外层 #2(与内层的藏品同字段号, 但在不同层)
    for (const x of top) {
        if (x.f !== 2 || x.w !== 2) continue;
        const d = parseDisplay(x.v);
        if (d && (d.itemId > 0 || d.slot > 0)) out.displays.push(d);
    }
    return out;
}

async function getCollectionsRaw() {
    // ⚠ 抓包请求是 0a 01 01: #1 为 wire2(bytes), 内容 1 字节 0x01。
    //   用 .proto 编码 int32 会变成 08 01, 与客户端不一致 → 手工拼。
    const body = Buffer.from([0x0a, 0x01, 0x01]);
    const { body: reply } = await sendMsgAsync(SERVICE, 'GetCollections', body);
    return Buffer.isBuffer(reply) ? reply : Buffer.from(reply || []);
}

/** 查询典藏室状态(解析后的结构) */
async function getCollections() {
    const buf = await getCollectionsRaw();
    const parsed = parseCollectionsReply(buf);
    return { ok: true, rawHex: buf.toString('hex'), ...parsed };
}

// ============ 静态目录(ItemInfo) ============

let catalogCache = null;
function buildCollectionCatalog() {
    if (catalogCache) return catalogCache;
    const series = new Map();
    for (const item of (getAllItems() || [])) {
        if (Number(item.type) !== ITEM_TYPE_COLLECTION) continue;
        const id = Number(item.id) || 0;
        if (id <= 0) continue;
        const icon = String(item.icon_res || '');
        const m = icon.match(/icon_collect_(\d+)_(\d+)/);
        const seriesNo = m ? Number(m[1]) : 0;
        const slot = m ? Number(m[2]) : 0;
        if (!series.has(seriesNo)) {
            series.set(seriesNo, {
                series: seriesNo,
                name: SERIES_NAMES[seriesNo] || `系列${seriesNo}`,
                items: [],
            });
        }
        series.get(seriesNo).items.push({
            id,
            name: String(item.name || `藏品#${id}`),
            desc: String(item.desc || ''),
            image: getItemImageById(id),
            slot,
        });
    }
    const list = Array.from(series.values()).sort((a, b) => a.series - b.series);
    for (const s of list) s.items.sort((a, b) => a.slot - b.slot);
    catalogCache = list;
    return catalogCache;
}

/** 背包里同名精灵的数量(升星消耗的就是它) */
function bagSpiritCounts() {
    try {
        // 避免循环依赖: warehouse 在调用时才 require
        const { getBag, getBagItems } = require('./warehouse');
        return { getBag, getBagItems };
    } catch {
        return null;
    }
}

async function getSpiritCountsInBag() {
    const api = bagSpiritCounts();
    if (!api) return new Map();
    const counts = new Map();
    try {
        const bag = await api.getBag();
        for (const it of (api.getBagItems(bag) || [])) {
            const id = toNum(it && it.id);
            const c = toNum(it && it.count);
            if (id > 0 && c > 0) counts.set(id, (counts.get(id) || 0) + c);
        }
    } catch { /* 读背包失败按 0 处理 */ }
    return counts;
}

// ============ 展示 ============

/**
 * 切换展示
 * @param itemId 藏品ID; 0 = 清空展示位(抓包 30.0s: #2{1,0,0})
 */
async function switchSceneDisplay(itemId = 0, opts = {}) {
    const scene = Math.max(1, toNum(opts.scene) || 1);
    const slot = Math.max(1, toNum(opts.slot) || 1);
    const w = protobuf.Writer.create();
    const inner = protobuf.Writer.create();
    inner.uint32(8).int32(slot);
    if (toNum(itemId) > 0) inner.uint32(16).int64(toNum(itemId));
    else { inner.uint32(16).int32(0); inner.uint32(24).int32(0); }   // 清空与抓包一致
    const mid = protobuf.Writer.create();
    mid.uint32(8).int32(scene);
    mid.uint32(18).bytes(inner.finish());
    w.uint32(10).bytes(mid.finish());
    const body = w.finish();
    const { body: reply } = await sendMsgAsync(SERVICE, 'SwitchSceneDisplay', body);
    const replyBuf = Buffer.isBuffer(reply) ? reply : Buffer.from(reply || []);
    return { ok: true, itemId: toNum(itemId), display: parseDisplay(replyBuf), rawHex: replyBuf.toString('hex') };
}

// ============ 升星 ============

/**
 * 升星
 * ⚠ 消耗的是**同名精灵**(背包里的同 itemId 物品), 没货时服务端回
 *   `1000019 xxx不足`。调用方应先用 checkUpgradeAffordable 判断。
 */
async function upgradeCollection(itemId) {
    const id = toNum(itemId);
    if (id <= 0) throw new Error('无效的藏品ID');
    const body = types.UpgradeCollectionRequest.encode(
        types.UpgradeCollectionRequest.create({ field1: 1, item_id: id }),
    ).finish();
    const { body: reply } = await sendMsgAsync(SERVICE, 'UpgradeCollection', body);
    const replyBuf = Buffer.isBuffer(reply) ? reply : Buffer.from(reply || []);
    const fields = parseWire(replyBuf);
    const info = getItemById(id) || {};
    const result = {
        ok: true,
        itemId: id,
        name: String(info.name || `藏品#${id}`),
        star: num(findField(fields, 3)),
        score: num(findField(fields, 4)),
        rawHex: replyBuf.toString('hex'),
    };
    log('典藏室', `已升星「${result.name}」→ ${result.star} 星 (评分 ${result.score})`, {
        module: 'activity', event: '典藏室', result: 'ok', itemId: id, star: result.star,
    });
    return result;
}

/**
 * @deprecated 背包判定已失效: 2026-11-09 抓包确认藏品不在背包里。
 * 仅保留为页面展示用(背包里有多少个同名精灵), **不要**用它拦截升星请求。
 */
async function checkUpgradeAffordable(itemId, counts = null) {
    const id = toNum(itemId);
    const bag = counts || await getSpiritCountsInBag();
    return { inBag: bag.get(id) || 0 };
}

// ============ 评分奖励 ============

/**
 * 领取评分奖励
 *
 * 抓包实测请求只有 `08 01`(#1=1), 服务端按当前评分发放所有**达标且有档位**的奖励。
 *
 * ⚠ 关键教训(用户实测): `#6 当前评分 > #5 已领档位` 并不等于"有奖励可领"!
 *   抓包 61s 领取成功后 #5 仍是 1000、#6 仍是 1200 —— 说明 #5 记录的是
 *   **已领到的档位值**, 而档位之间有间隔(下一个档位可能是 2000),
 *   1200 够不到 2000 档 → 服务端回 `1047006 暂无可领取的奖励`。
 *   档位表在 config/CollectionScoreReward(已混淆), 无法离线推出间隔,
 *   **所以只能以服务端反馈为准**: 把 1047006 当成"当前没有可领"的正常结果,
 *   而不是错误。
 */
const ERR_NO_REWARD = 1047006;

async function claimCollectionReward() {
    const body = types.ClaimCollectionRewardRequest.encode(
        types.ClaimCollectionRewardRequest.create({ field1: 1 }),
    ).finish();
    let replyBuf;
    try {
        const { body: reply } = await sendMsgAsync(SERVICE, 'ClaimCollectionReward', body);
        replyBuf = Buffer.isBuffer(reply) ? reply : Buffer.from(reply || []);
    } catch (e) {
        const msg = String((e && e.message) || '');
        if (msg.includes(`code=${ERR_NO_REWARD}`) || msg.includes('暂无可领取')) {
            // 服务端说没有可领的 → 不是错误, 也不该每次都刷日志
            return { ok: true, claimed: false, reason: '当前没有达到新档位(奖励按档位间隔发放)', totalScore: 0, claimedScore: 0, rewardHex: '' };
        }
        throw e;
    }
    const fields = parseWire(replyBuf);
    const result = {
        ok: true,
        claimed: true,
        totalScore: num(findField(fields, 2)),
        claimedScore: num(findField(fields, 3)),
        rewardHex: (() => { const x = findField(fields, 4); return x && x.w === 2 ? x.v.toString('hex') : ''; })(),
    };
    log('典藏室', `已领取藏品评分奖励 (评分 ${result.totalScore}, 覆盖到 ${result.claimedScore} 档)`, {
        module: 'activity', event: '典藏室', result: 'ok', score: result.totalScore, claimed: result.claimedScore,
    });
    return result;
}

// ============ 概览(页面主数据) ============

/**
 * 典藏室概览
 *   · 目录(30 款) × 服务端状态(星级/激活/获得时间)
 *   · 当前展示位
 *   · 评分(累计评分 / 已领档位)
 *
 * ⚠ 2026-11-09 抓包纠正: 藏品**不在背包里**(背包 61 项无一藏品), 但升级照常成功。
 *   所以"背包有同名精灵才能升星"是错的判断 —— 能否升星只能由服务端判定
 *   (会回 `1000019 xxx不足` / `1047006 暂无可领取` 这类错误码)。
 */
async function getCollectionOverview({ probe = true } = {}) {
    const level = toNum((getUserState() || {}).level) || 0;
    // 等级不够时服务端还没开这个功能, 请求没有意义(也会报错) → 直接跳过
    const locked = level > 0 && level < COLLECTION_UNLOCK_LEVEL;
    const server = (probe && !locked) ? await getCollections().catch(() => null) : null;
    const spiritCounts = await getSpiritCountsInBag();

    const byId = new Map((server ? server.entries : []).map((e) => [e.itemId, e]));
    const catalog = buildCollectionCatalog();
    let ownedTotal = 0;
    const series = catalog.map((s) => {
        const items = s.items.map((it) => {
            const st = byId.get(it.id) || null;
            const owned = !!(st && st.activated > 0);
            if (owned) ownedTotal += 1;
            return {
                ...it,
                owned,
                activated: st ? st.activated : 0,
                star: st ? st.star : 0,
                obtainedAt: st ? st.obtainedAt : 0,
                // 该藏品的吞噬次数(#5) —— 11-09 抓包: 700005 升到 2 星时 #5 由 1 变 2
                devour: st ? (st.devour || 0) : 0,
            };
        });
        return {
            series: s.series,
            name: s.name,
            total: items.length,
            owned: items.filter((x) => x.owned).length,
            items,
        };
    });

    // 服务端登记了、但本地目录没收录的藏品(配置同步滞后时兜底)
    const knownIds = new Set(catalog.flatMap((s) => s.items.map((x) => x.id)));
    const extra = [];
    for (const e of (server ? server.entries : [])) {
        if (knownIds.has(e.itemId)) continue;
        const info = getItemById(e.itemId) || {};
        extra.push({
            id: e.itemId,
            name: String(info.name || `藏品#${e.itemId}`),
            desc: String(info.desc || ''),
            image: getItemImageById(e.itemId),
            owned: e.activated > 0,
            activated: e.activated,
            star: e.star,
            obtainedAt: e.obtainedAt,
            devour: e.devour || 0,
        });
    }

    // 展台(type=34, 背包里)
    const pedestals = [];
    for (const item of (getAllItems() || [])) {
        if (Number(item.type) !== ITEM_TYPE_PEDESTAL) continue;
        const id = Number(item.id) || 0;
        if (id <= 0) continue;
        const count = spiritCounts.get(id) || 0;
        pedestals.push({
            id,
            name: String(item.name || `展台#${id}`),
            desc: String(item.desc || ''),
            image: getItemImageById(id),
            count,
            owned: id === 610100 || count > 0,
        });
    }
    pedestals.sort((a, b) => a.id - b.id);

    return {
        updatedAt: Date.now(),
        level,
        unlockLevel: COLLECTION_UNLOCK_LEVEL,
        locked,
        serverOk: !!server,
        catalogTotal: catalog.reduce((n, s) => n + s.items.length, 0),
        ownedTotal,
        series,
        extra,
        pedestals,
        ownedPedestals: pedestals.filter((p) => p.owned).length,
        points: {
            collection: spiritCounts.get(ITEM_ID_COLLECTION_POINT) || 0,
            normal: spiritCounts.get(3001) || 0,
        },
        display: server && server.displays.length ? server.displays[server.displays.length - 1] : null,
        displays: server ? server.displays : [],
        score: {
            total: server ? server.totalScore : 0,
            // #5: 已领到的档位值(不是"已领分数")
            claimedTier: server ? server.claimedScore : 0,
            // ⚠ 不能由 total > claimedTier 推断可领: 实测 1200 > 1000 仍回 1047006
            //   真实可领状态只以 claimCollectionReward 的服务端反馈为准
            claimable: null,
        },
    };
}

// ============ 自动化流程 ============

/**
 * 典藏室日常: 展示 → 升星 → 领评分奖励
 *
 * @param opts.autoDisplay  有藏品但没有展示时, 自动把评分最高的摆上去(默认 true)
 * @param opts.autoUpgrade  背包里有同名精灵就升星(默认 true; 没货绝不发请求)
 * @param opts.autoClaim    评分奖励有新增可领时自动领(默认 true)
 * @param opts.maxUpgrades  单次最多升几次星(默认 10, 防止一次把库存全烧掉)
 *
 * ⚠ 升星消耗同名精灵, 抓包里第二次升 700005 就因"桃米不足"失败 →
 *   本流程每个藏品先看背包同名声, 只升到库存用完为止, 不做无效请求。
 */
async function runCollectionTasks(opts = {}) {
    const autoDisplay = opts.autoDisplay !== false;
    const autoUpgrade = opts.autoUpgrade !== false;
    const autoClaim = opts.autoClaim !== false;
    const maxUpgrades = Math.max(0, Math.min(200, Number(opts.maxUpgrades) || 10));

    const out = { ok: true, state: null, display: null, upgraded: [], claimed: null, skipped: [] };
    const level = toNum((getUserState() || {}).level) || 0;
    if (level > 0 && level < COLLECTION_UNLOCK_LEVEL) {
        return { ok: true, skipped: [`典藏室 ${COLLECTION_UNLOCK_LEVEL} 级开启(当前 ${level} 级)`], level, locked: true, upgraded: [], display: null, claimed: null };
    }
    let state;
    try {
        state = await getCollections();
    } catch (e) {
        return { ok: false, reason: `查询典藏室失败: ${e.message}` };
    }
    out.state = { entries: state.entries, score: { total: state.totalScore, claimedTier: state.claimedScore } };

    const activated = state.entries.filter((e) => e.activated > 0);
    if (!activated.length) {
        out.skipped.push('还没有已激活的藏品(开藏品礼包获得后会自动激活)');
    }

    // ① 展示: 有藏品但展示位为空 → 摆评分最高的
    if (autoDisplay && activated.length) {
        const cur = state.displays[state.displays.length - 1];
        const curItemId = cur ? cur.itemId : 0;
        const curValid = curItemId > 0 && activated.some((e) => e.itemId === curItemId);
        if (!curValid) {
            // 优先摆已升星的(评分高), 平手时摆最近获得的
            const pick = activated.slice().sort((a, b) => (b.star - a.star) || (b.obtainedAt - a.obtainedAt))[0];
            try {
                const r = await switchSceneDisplay(pick.itemId, { scene: cur ? cur.scene : 1, slot: cur ? cur.slot : 1 });
                out.display = r;
                log('典藏室', `已把「${(getItemById(pick.itemId) || {}).name || pick.itemId}」摆上展示位`, {
                    module: 'activity', event: '典藏室', result: 'ok', itemId: pick.itemId,
                });
            } catch (e) {
                out.skipped.push(`切换展示失败: ${e.message}`);
            }
        }
    }

    // ② 升星: **不做本地预判**, 由服务端判定能不能升
    //   ⚠ 曾经的错误做法: 只在"背包里有同名精灵"时才升 —— 但 2026-11-09 抓包显示
    //     藏品根本不在背包里(背包 61 项无一藏品), 升级却照样成功。
    //     所以"能不能升"只有服务端知道(不足时回 1000019 xxx不足)。
    //   策略: 从星级最低的开始试, 每个藏品一轮最多试 1 次; 连续 N 个都升不动就整体放弃,
    //         避免低星全部升满时每次巡检都白刷一堆失败请求。
    if (autoUpgrade && maxUpgrades > 0) {
        const candidates = activated
            .slice()
            .sort((a, b) => (a.star - b.star) || (a.obtainedAt - b.obtainedAt));
        let budget = maxUpgrades;
        let consecutiveFail = 0;
        for (const e of candidates) {
            if (budget <= 0 || consecutiveFail >= MAX_CONSECUTIVE_FAIL) break;
            const name = (getItemById(e.itemId) || {}).name || e.itemId;
            try {
                const r = await upgradeCollection(e.itemId);
                out.upgraded.push({ itemId: e.itemId, name: r.name, star: r.star, score: r.score });
                budget -= 1;
                consecutiveFail = 0;
                await sleep(600);
            } catch (err) {
                consecutiveFail += 1;
                const msg = String((err && err.message) || '');
                out.skipped.push(`${name} 升星失败: ${msg}`);
            }
        }
        if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) {
            out.skipped.push('连续多次升星失败, 本轮停止(通常是材料不足)');
        }
    }

    // ③ 评分奖励: **每次先试着领一次**, 由服务端判定有没有可领的档位
    //   (档位间隔未知, 不能用"评分 > 已领档位"猜; 服务端回 1047006 就是没有)
    if (autoClaim) {
        try {
            const r = await claimCollectionReward();
            out.claimed = r.claimed ? r : null;
            if (!r.claimed) out.skipped.push(r.reason || '当前没有可领取的评分奖励');
        } catch (e) {
            out.skipped.push(`领取评分奖励失败: ${e.message}`);
        }
    }

    return out;
}

module.exports = {
    SERVICE,
    ITEM_TYPE_COLLECTION,
    ITEM_TYPE_PEDESTAL,
    ITEM_ID_COLLECTION_POINT,
    SERIES_NAMES,
    __testing: { parseWire, parseDisplay, parseCollectionsReply },
    getCollections,
    getCollectionsRaw,
    buildCollectionCatalog,
    getSpiritCountsInBag,
    switchSceneDisplay,
    upgradeCollection,
    checkUpgradeAffordable,
    claimCollectionReward,
    getCollectionOverview,
    runCollectionTasks,
};