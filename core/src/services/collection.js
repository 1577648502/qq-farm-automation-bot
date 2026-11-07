/**
 * 典藏室（藏品 · 珍藏室）—— 只读展示 + 新增接口探测
 *
 * ════════ 抓包来源 ════════
 * 2026-11-07 抓包 `20261107-112023_典藏室和快乐独享领取` 里出现的新接口:
 *   gamepb.collectionpb.CollectionService.GetCollections
 *   请求: 0a 01 01              → {#1: bytes[0x01]}
 *   响应: 0a 02 08 01  12 00    → {#1: {#1: 1}, #2: ""}
 * ⚠ 服务端只回了一个空壳(客户端打开典藏室面板时也只是探测一下), 没有下发藏品明细。
 *   所以**藏品清单必须从背包反推**: 藏品是 type=35 的物品
 *   (700001/710001/720001/730001/740001 五个系列, 每系列 6 款, 共 30 款;
 *    desc 统一写着"可收进珍藏室陈列展示"), 展台是 type=34 (610201~610303),
 *   进度值是 3002「典藏收藏点」。
 *   GetCollections 的请求/响应字段照样实现(用于探测活动是否开放/是否有红点),
 *   真正可看的数据以背包为准 —— 这也是客户端面板的来源。
 *
 * ════════ 藏品系列(ItemInfo 静态表) ════════
 *   700001~700006  icon_collect_5_x  果冻系列
 *   710001~710006  icon_collect_1_x  氧气小精灵
 *   720001~720006  icon_collect_2_x  田园灵偶
 *   730001~730006  icon_collect_3_x  漫游客
 *   740001~740006  icon_collect_4_x  青叶风灵
 * 系列号藏在图标路径 `icon_collect_<系列>_<款式>` 里, 用它分组即可, 不需要额外配置表。
 */

const protobuf = require('protobufjs');
const { sendMsgAsync } = require('../utils/network');
const { getItemById, getItemImageById, getAllItems } = require('../config/gameConfig');
const { log, toNum } = require('../utils/utils');
const { getBag, getBagItems } = require('./warehouse');

const SERVICE = 'gamepb.collectionpb.CollectionService';

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

/** 极简 wire 解析(只读, 不依赖 .proto) */
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
const bufToStr = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : '');

/**
 * 调 GetCollections
 * 请求 {#1: <1 字节状态>}: 实测客户端传 0x01(二进制状态位), 用 raw writer 构造,
 * 不能走 .proto(collectionpb 表不在仓库里, 字段号按抓包硬编码)。
 * 返回 { ok, raw, flag1, text } —— 服务端拒绝时抛异常由调用方捕获。
 */
async function getCollections(flagByte = 1) {
    const w = protobuf.Writer.create();
    w.uint32((1 << 3) | 2).bytes(Buffer.from([flagByte & 0xff]));
    const { body } = await sendMsgAsync(SERVICE, 'GetCollections', w.finish());
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
    const fields = parseWire(buf);
    const box = findField(fields, 1);
    const inner = box && box.w === 2 ? parseWire(box.v) : [];
    return {
        ok: true,
        rawHex: buf.toString('hex'),
        flag1: Number((findField(inner, 1) || {}).v || 0),
        text: bufToStr((findField(fields, 2) || {}).v),
        // 明细还没见服务端下发过: 有 #3..#N 时原样带出去, 方便后续版本再解析
        detailHex: fields.filter((x) => x.f >= 3 && x.w === 2).map((x) => x.v.toString('hex')),
    };
}

/** 静态藏品目录: 从 ItemInfo 里按 type=35 收集, 用图标路径分组 */
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

/** 背包 → { 按物品ID: 数量 } */
function bagCountMap(bagReply) {
    const map = new Map();
    for (const it of (getBagItems(bagReply) || [])) {
        const id = toNum(it && it.id);
        const count = toNum(it && it.count);
        if (id > 0 && count > 0) map.set(id, (map.get(id) || 0) + count);
    }
    return map;
}

/**
 * 典藏室概览(页面主数据)
 *   藏品: 每个系列已拥有/总数, 逐款数量
 *   展台: 已拥有的展台
 *   进度: 3002 典藏收藏点
 */
async function getCollectionOverview({ probe = true } = {}) {
    const bagReply = await getBag();
    const counts = bagCountMap(bagReply);

    const catalog = buildCollectionCatalog();
    let ownedTotal = 0;
    const series = catalog.map((s) => {
        const items = s.items.map((it) => {
            const count = counts.get(it.id) || 0;
            if (count > 0) ownedTotal += 1;
            return { ...it, count, owned: count > 0 };
        });
        return {
            series: s.series,
            name: s.name,
            total: items.length,
            owned: items.filter((x) => x.owned).length,
            items,
        };
    });

    // 目录里没收录(type=35 但/或 ItemInfo 未同步到)的藏品: 直接从背包兜底展示
    const knownIds = new Set(catalog.flatMap((s) => s.items.map((x) => x.id)));
    const extra = [];
    for (const [id, count] of counts.entries()) {
        const info = getItemById(id);
        if (!info || Number(info.type) !== ITEM_TYPE_COLLECTION || knownIds.has(id)) continue;
        extra.push({
            id,
            name: String(info.name || `藏品#${id}`),
            desc: String(info.desc || ''),
            image: getItemImageById(id),
            count,
            owned: true,
        });
    }

    // 展台: type=34
    const pedestals = [];
    for (const item of (getAllItems() || [])) {
        if (Number(item.type) !== ITEM_TYPE_PEDESTAL) continue;
        const id = Number(item.id) || 0;
        if (id <= 0) continue;
        const count = counts.get(id) || 0;
        pedestals.push({
            id,
            name: String(item.name || `展台#${id}`),
            desc: String(item.desc || ''),
            image: getItemImageById(id),
            count,
            owned: id === 610100 || count > 0,   // 610100「默认」始终可用
        });
    }
    pedestals.sort((a, b) => a.id - b.id);

    const point = counts.get(ITEM_ID_COLLECTION_POINT) || 0;
    const normalPoint = counts.get(3001) || 0;

    // 新接口探测: 失败不影响页面(该接口目前只回空壳)
    let endpoint = { ok: false, skipped: !probe };
    if (probe) {
        try {
            endpoint = await getCollections();
        } catch (e) {
            endpoint = { ok: false, error: e.message };
        }
    }

    return {
        updatedAt: Date.now(),
        catalogTotal: catalog.reduce((n, s) => n + s.items.length, 0),
        ownedTotal,
        series,
        extra,
        pedestals,
        ownedPedestals: pedestals.filter((p) => p.owned).length,
        points: { collection: point, normal: normalPoint },
        endpoint,
    };
}

/**
 * 手动刷新时的简单日志(供 /api/collection/refresh 之类接口使用)
 */
async function refreshCollection(params = {}) {
    const overview = await getCollectionOverview(params);
    log('典藏室', `典藏室数据已刷新: 拥有藏品 ${overview.ownedTotal}/${overview.catalogTotal} 款, 展台 ${overview.ownedPedestals} 个, 典藏收藏点 ${overview.points.collection}`, {
        module: 'activity',
        event: '典藏室',
        result: 'ok',
        owned: overview.ownedTotal,
        total: overview.catalogTotal,
    });
    return overview;
}

module.exports = {
    SERVICE,
    ITEM_TYPE_COLLECTION,
    ITEM_TYPE_PEDESTAL,
    ITEM_ID_COLLECTION_POINT,
    getCollections,
    buildCollectionCatalog,
    getCollectionOverview,
    refreshCollection,
};