/**
 * 土地等级 ↔ 类型 ↔ 显示名 的唯一映射表。
 *
 * 为什么集中:
 *   这套"等级 0~6 → 类型 key → 中文名"的映射原本散在三处:
 *     · core/src/services/farm.js        (施肥范围过滤用它)
 *     · web/src/components/LandCard.vue  (地块卡片显示名与配色)
 *     · web/src/views/Settings.vue       (施肥范围勾选项)
 *   2026-11 新增"蓝晶土地(6级)"时, 三处都要改, 漏一处就会出现
 *   "设置里能勾蓝晶、地块卡片却显示空白"。
 *
 * ⚠ 两套命名不要混:
 *   · normal 这一档在**施肥范围**语境叫"普通土地"(与其他几档并列)
 *   · 在**地块卡片**语境叫"普通"(它是默认等级, 不需要"土地"后缀)
 *   所以这里同时给出 label(长) 与 shortLabel(短), 由调用方按场景选。
 */

/** 等级上限: 文档/校验用 */
const MAX_LAND_LEVEL = 6;

/**
 * 等级 → 类型 key。
 * 5 级紫晶、6 级蓝晶是 2026-11 新增的上限档, 高等级一律归入蓝晶。
 */
function getLandTypeByLevel(level) {
    const lv = Number(level) || 0;
    if (lv >= 6) return 'blue';
    if (lv === 5) return 'amethyst';
    if (lv === 4) return 'gold';
    if (lv === 3) return 'black';
    if (lv === 2) return 'red';
    return 'normal';
}

/**
 * 类型 key → 元信息。
 *   label      施肥范围等处用的完整名(带"土地")
 *   shortLabel 地块卡片用的短名
 *   level      对应的土地等级(用于反查)
 */
const LAND_TYPES = {
    normal: { label: '普通土地', shortLabel: '普通', level: 0 },
    // 1 级黄土地: 施肥范围里与普通土地同组(后端 getLandTypeByLevel 也归到 normal),
    // 但地块卡片上要能显示出"黄土地", 所以单独留一档仅供展示
    yellow: { label: '黄土地', shortLabel: '黄土地', level: 1 },
    red: { label: '红土地', shortLabel: '红土地', level: 2 },
    black: { label: '黑土地', shortLabel: '黑土地', level: 3 },
    gold: { label: '金土地', shortLabel: '金土地', level: 4 },
    amethyst: { label: '紫晶土地', shortLabel: '紫晶土地', level: 5 },
    blue: { label: '蓝晶土地', shortLabel: '蓝晶土地', level: 6 },
};

// 施肥范围勾选顺序(高等级在前, 与面板展示一致)
const LAND_TYPE_KEYS = ['blue', 'amethyst', 'gold', 'black', 'red', 'normal'];
// 展示用顺序(含 1 级黄土地), 供前端按等级渲染
const LAND_TYPE_DISPLAY_ORDER = ['normal', 'yellow', 'red', 'black', 'gold', 'amethyst', 'blue'];

function getLandTypeLabel(type) {
    const meta = LAND_TYPES[String(type || '')];
    return meta ? meta.label : '';
}

function getLandTypeShortLabel(type) {
    const meta = LAND_TYPES[String(type || '')];
    return meta ? meta.shortLabel : '';
}

/** 施肥范围勾选项(供前端直接渲染) */
function getLandTypeOptions() {
    return LAND_TYPE_KEYS.map(value => ({ label: LAND_TYPES[value].label, value }));
}

/** 地块卡片用的"等级 → 名称"表(含 1 级黄土地) */
function getLandLevelLabels() {
    return LAND_TYPE_DISPLAY_ORDER
        .map((key) => ({ level: LAND_TYPES[key].level, name: LAND_TYPES[key].shortLabel }))
        .sort((a, b) => a.level - b.level);
}

module.exports = {
    MAX_LAND_LEVEL,
    LAND_TYPE_DISPLAY_ORDER,
    LAND_TYPES,
    LAND_TYPE_KEYS,
    getLandTypeByLevel,
    getLandTypeLabel,
    getLandTypeShortLabel,
    getLandTypeOptions,
    getLandLevelLabels,
};
