/**
 * 协议观察器 —— 让机器人自己把「游戏改了什么」记下来
 *
 * 为什么需要:
 *   以前每次游戏更新活动, 都要手动 mitmproxy 抓包 + 解码 + 人工比对, 一次半小时。
 *   但机器人本来就在跑同一条网关连接, 而且它手里的**请求体是加密前的明文**
 *   (network.encodeMsg 在加密之前调用本模块), 比 mitmproxy 抓 C→S 还全。
 *
 * 做什么:
 *   1) 被动记录每个 service.method 的「字段结构指纹」(字段号 + wire type, 不含具体值);
 *   2) 与基线(baseline.json)对比, 自动标出 **新接口 / 老接口的新字段**;
 *   3) 对 ActivityService.List 额外做结构化提取: 活动组/子活动/标题/时间,
 *      以及每个子活动 body 用的是哪个字段号、这个字段号在 proto 里有没有定义
 *      —— 新玩法一上线就会以「未定义字段号」的形式露头。
 *
 * 开销控制:
 *   - 指纹计算纯内存, 不落盘; 只有首次出现/采样窗口内的帧才写原始 hex;
 *   - catalog 每 FLUSH_INTERVAL_MS 或进程退出时原子落盘;
 *   - 每个接口最多保留 MAX_SAMPLES_PER_KEY 条样本, 单个样本超过 MAX_SAMPLE_BYTES 截断。
 *
 * 关闭: FARM_PROTOCOL_OBSERVER=0
 * 目录: data/protocol/
 *   catalog-<账号>.json   该账号采到的接口清单(每进程一份, 不会互相覆盖)
 *   baseline.json         基线(共享), 面板上点「以此为准」才更新
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('../config/runtime-paths');
const wire = require('./wire');

const FLUSH_INTERVAL_MS = 5000;
const MAX_SAMPLES_PER_KEY = 4;
const MAX_SAMPLE_BYTES = 8192;
const MAX_KEYS = 3000;
const MAX_FIELD_PATHS_PER_KEY = 600;
// 指纹抽样(2026-11-22 性能优化): footprint 全量 wire 解析是 WS 热路径开销大头。
// 前 30 帧逐帧解析摸清结构; 连续 10 帧无新字段视为结构稳定 → 降频到每 40 帧探一次;
// 探到新字段立即恢复逐帧窗口 —— 新玩法上线仍能在 ≤40 帧内被发现(回归测试锁定)。
const FOOTPRINT_WARMUP_FRAMES = 30;
const FOOTPRINT_STABLE_ROUNDS = 10;
const FOOTPRINT_SAMPLE_EVERY = 40;
// 落盘策略: 只有结构变化(新接口/新字段/新样本/活动快照)才 5s 内落盘;
// 纯计数/lastSeenAt 变化走 10 分钟心跳, 不再每 5 秒全量重写 catalog JSON(×4 账号)。
const HEARTBEAT_FLUSH_MS = 10 * 60 * 1000;

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';

let enabled = process.env.FARM_PROTOCOL_OBSERVER !== '0';
let startedAt = 0;
let flushTimer = null;
let dirty = false;
let lastFlushAt = 0;
let protoReflection = null;

/** key = "service.method" 或 "[Notify] xxx" */
const catalog = new Map();
let baseline = null;
/** 最近一次活动列表的结构化快照: groupId -> group(按 id 合并, 不互相覆盖) */
let activityGroups = new Map();
let activitySummaries = new Map();
let activityAt = 0;

function dataDir() {
    return path.join(getDataDir(), 'protocol');
}
function fileOf(name) {
    return path.join(dataDir(), name);
}
/** 每个 worker 进程只写自己账号的文件, 避免多账号互相覆盖 */
function catalogFile() {
    // 账号 id 在 worker 里由 workerData 写进环境变量(见 core/worker.js 顶部)
    const id = String(process.env.FARM_ACCOUNT_ID || '').trim() || 'default';
    const safe = id.replace(/[^\w.-]/g, '_');
    return fileOf(`catalog-${safe}.json`);
}

function ensureDir() {
    try {
        fs.mkdirSync(dataDir(), { recursive: true });
    } catch { /* 目录建不出来就让写文件失败, 不影响主流程 */ }
}

function writeJsonAtomic(filePath, value) {
    ensureDir();
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

/** 取 proto 反射信息(字段号集合), 拿不到就返回 null —— 观察器不能因为 proto 挂了而失效 */
function getProtoReflection() {
    if (protoReflection !== null) return protoReflection;
    try {
        const { getRoot } = require('./proto');
        const root = getRoot();
        if (!root) return (protoReflection = false);
        const activityData = root.lookupType('gamepb.activitypb.ActivityData');
        const knownBodyFields = new Map();
        for (const [name, field] of Object.entries(activityData.fields)) {
            knownBodyFields.set(field.id, name);
        }
        protoReflection = { activityData, knownBodyFields };
    } catch {
        protoReflection = false;
    }
    return protoReflection;
}

function emptyEntry(key) {
    return {
        key,
        count: 0,
        firstSeenAt: Date.now(),
        lastSeenAt: 0,
        dirs: {},
        fieldPaths: [],
        stableRounds: 0,        // 连续多少帧没发现新字段(结构稳定性计数)
        _hadSet: null,          // fieldPaths 的 Set 缓存(避免每帧重建), 不落盘
        errors: 0,
        samples: [],
        bytes: { min: 0, max: 0 },
    };
}

function getEntry(key) {
    let entry = catalog.get(key);
    if (!entry) {
        if (catalog.size >= MAX_KEYS) return null;
        entry = emptyEntry(key);
        catalog.set(key, entry);
    }
    return entry;
}

/**
 * 记录一帧
 * @param {'C->S'|'S->C'} dir
 * @param {string} key service.method 或 [Notify] xxx
 * @param {Buffer} body 明文业务 body(请求为加密前明文)
 * @param {{errorCode?:number, errorMessage?:string}} [meta]
 */
/**
 * 这个接口的 body 能不能落盘存样本。
 *
 * 为什么不能全存: 观察器记的是**解密后的明文**。登录/账号/支付类请求里带
 * openID、device_id、订单号这类标识, 存进 data/protocol/ 等于把凭据明文留在磁盘。
 * 这些接口仍然参与指纹统计(能发现结构变化), 只是不保留原始字节。
 *
 * 排查这类接口时用 FARM_PROTO_LOG=1 看实时日志, 或临时把环境变量
 * FARM_PROTOCOL_SAMPLE_ALL=1 打开(自担风险, 仅调试用)。
 */
const SENSITIVE_KEY_PATTERNS = [
    /UserService\.Login/i,
    /UserService\.PlayerLogin/i,
    /UserService\.DecryptOpenData/i,
    /paypb\./i,
    /recharge/i,
    /\.Auth/i,
    /Token/i,
    /Verify/i,
];

function shouldKeepSample(key) {
    if (process.env.FARM_PROTOCOL_SAMPLE_ALL === '1') return true;
    return !SENSITIVE_KEY_PATTERNS.some(re => re.test(String(key || '')));
}

/**
 * 记录一帧
 *
 * ⚠ 这个函数在 WS 收发的热路径上(network.encodeMsg / handleMessage 直接调用)。
 *   它**绝对不能抛异常** —— 一旦抛出去就会打断登录/心跳/所有业务请求。
 *   所以整段包在 try/catch 里, 采集失败只丢这一帧, 不影响游戏。
 *
 * @param {'C->S'|'S->C'} dir 方向
 * @param {string} key service.method 或 [Notify] xxx
 * @param {Buffer} body 明文业务 body(请求为加密前明文)
 * @param {{errorCode?:number, errorMessage?:string}} [meta] 错误信息(仅统计用)
 */
function observe(dir, key, body, meta = {}) {
    if (!enabled || !key) return;
    try {
        observeUnsafe(dir, key, body, meta);
    } catch {
        // 故意静默: 观察器是附加能力, 任何情况下都不该让它影响游戏网络
    }
}

/** 真正的采集逻辑; 调用方 observe() 已兜住异常 */
function observeUnsafe(dir, key, body, meta = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
    const entry = getEntry(key);
    if (!entry) return;

    // 实时可见性: FARM_PROTO_LOG=1 时每个新接口打一行
    const wasNew = entry.count === 0;
    if (wasNew) require('./protocol-log').logInterface(key, dir);

    entry.count += 1;
    entry.lastSeenAt = Date.now();
    entry.dirs[dir] = (entry.dirs[dir] || 0) + 1;
    if (buf.length) {
        entry.bytes.min = entry.bytes.min ? Math.min(entry.bytes.min, buf.length) : buf.length;
        entry.bytes.max = Math.max(entry.bytes.max, buf.length);
    }
    if (meta.errorCode) entry.errors += 1;

    // 指纹: 只对非空 body 且"值得解析"的帧算(抽样规则见文件头常量)
    let grew = false;
    if (buf.length
        && (entry.count <= FOOTPRINT_WARMUP_FRAMES
            || entry.stableRounds < FOOTPRINT_STABLE_ROUNDS
            || entry.count % FOOTPRINT_SAMPLE_EVERY === 0)) {
        const fp = wire.footprint(buf);
        // 缓存 Set 代替每帧 `new Set(fieldPaths)`(热路径分配大头之一)
        const had = entry._hadSet || (entry._hadSet = new Set(entry.fieldPaths));
        for (const p of fp.paths) {
            if (!had.has(p) && entry.fieldPaths.length < MAX_FIELD_PATHS_PER_KEY) {
                entry.fieldPaths.push(p);
                had.add(p);
                grew = true;
            }
        }
    }
    entry.stableRounds = grew ? 0 : (entry.stableRounds || 0) + 1;
    if (grew) dirty = true;

    // 采样本: 结构有增长时必存; 否则按数量采样。
    // ⚠ 只存**结构安全**的接口: 登录/鉴权类请求体里有 openID、device_id 等设备标识,
    //   落盘就是明文写在 data/protocol/ 里。这类一律不存样本(指纹照样采, 不影响发现结构变化)。
    if (buf.length && shouldKeepSample(key)
        && entry.samples.length < MAX_SAMPLES_PER_KEY
        && (grew || entry.count % FOOTPRINT_SAMPLE_EVERY === 0)) {
        entry.samples.push({
            at: Date.now(),
            dir,
            bytes: buf.length,
            hex: buf.subarray(0, MAX_SAMPLE_BYTES).toString('hex'),
            truncated: buf.length > MAX_SAMPLE_BYTES,
        });
        dirty = true;
    }

    if (key === `${ACTIVITY_SERVICE}.List` && dir === 'S->C') {
        try { harvestActivityList(buf); } catch { /* 结构提取失败不影响采集 */ }
    }

    if (wasNew) dirty = true;
    scheduleFlush();
}

/**
 * 裸 wire 提取: 活动组 → 子活动 → body 字段号(除 head=1 外)。
 * 路径: ListReply#1(ActivityGroup) → #2(ActivityData) → #1(ActivityHead#1=id) + 其它字段号
 * @returns {Map<number, number[]>} childId -> [body field no...]
 */
function harvestRawBodyFields(buf) {
    const out = new Map();
    const top = wire.parseFields(buf).fields;
    for (const groupField of top) {
        if (groupField.no !== 1 || !groupField.bytes) continue;
        const groupFields = wire.parseFields(groupField.bytes).fields;
        for (const childField of groupFields) {
            if (childField.no !== 2 || !childField.bytes) continue;
            const dataFields = wire.parseFields(childField.bytes).fields;
            const headField = dataFields.find(f => f.no === 1);
            if (!headField || !headField.bytes) continue;
            const headFields = wire.parseFields(headField.bytes).fields;
            const idField = headFields.find(f => f.no === 1);
            const childId = idField ? Number(idField.value) || 0 : 0;
            if (!childId) continue;
            const bodyNos = dataFields.filter(f => f.no !== 1).map(f => f.no);
            out.set(childId, bodyNos);
        }
    }
    return out;
}

/** 从 ActivityService.List 的回复里抽出活动组/子活动结构 */
function harvestActivityList(buf) {
    const reflection = getProtoReflection();
    if (!reflection) return;
    const { activityData } = reflection;

    let reply;
    try {
        reply = require('./proto').types.ActivityListReply.decode(buf);
    } catch {
        return;
    }
    if (!reply || !Array.isArray(reply.groups)) return;

    // 另走一遍裸 wire: proto 里没定义的字段号 protobufjs 会直接丢掉, 而新玩法恰恰
    // 就是"没定义"的那种(2026-11-18 的「故友重逢」= ActivityData#109 就是这么漏的)。
    // 所以每组子活动的真实 body 字段号必须以裸 wire 为准。
    const rawBodyFieldsByChildId = harvestRawBodyFields(buf);

    const groups = [];
    for (const group of reply.groups) {
        const head = group && group.head;
        if (!head) continue;
        const children = [];
        for (const child of (Array.isArray(group.children) ? group.children : [])) {
            const ch = child && child.head;
            if (!ch) continue;
            const childId = Number(ch.id) || 0;

            // 已定义字段: 走 proto 反射拿名字(便于读)
            const fieldsByName = new Map();
            for (const [name, value] of Object.entries(child)) {
                if (name === 'head' || !value) continue;
                const fieldDef = activityData.fields[name];
                if (!fieldDef) continue;
                fieldsByName.set(fieldDef.id, name);
            }
            // 以裸 wire 的字段号为准, 能同时覆盖"已定义"和"proto 未定义"两种情况
            const rawFields = rawBodyFieldsByChildId.get(childId) || [];
            const bodyFields = rawFields.map((no) => ({
                no,
                name: fieldsByName.get(no) || `field${no}`,
                defined: fieldsByName.has(no),
            }));
            // 兜底: 裸 wire 没抓到(理论上不会)时仍用反射结果
            if (!bodyFields.length) {
                for (const [no, name] of fieldsByName) {
                    bodyFields.push({ no, name, defined: true });
                }
            }

            children.push({
                id: childId,
                name: ch.name || '',
                type: Number(ch.type) || 0,
                status: Number(ch.status) || 0,
                startTime: Number(ch.start_time) || 0,
                endTime: Number(ch.end_time) || 0,
                clientId: Number(ch.client_id) || 0,
                bodyFields,
            });
        }
        groups.push({
            id: Number(head.id) || 0,
            name: head.name || '',
            startTime: Number(head.start_time) || 0,
            endTime: Number(head.end_time) || 0,
            status: Number(head.status) || 0,
            children,
        });
    }

    // ⚠ ListRequest#1 是场景号(1=农场, 2=牧场), 两个场景各返回自己的活动组。
    //   必须按 groupId 合并, 否则后一次响应会把前一次的组冲掉(实测牧场那次只剩 1 个组)。
    for (const g of groups) activityGroups.set(g.id, g);
    for (const a of (Array.isArray(reply.all_activities) ? reply.all_activities : [])) {
        const id = Number(a && a.id) || 0;
        if (id) activitySummaries.set(id, { id, name: (a && a.name) || '' });
    }
    activityAt = Date.now();
    dirty = true;
}

function snapshot() {
    const baseKeys = new Map();
    if (baseline && Array.isArray(baseline.interfaces)) {
        for (const it of baseline.interfaces) baseKeys.set(it.key, it);
    }
    const interfaces = [];
    for (const entry of catalog.values()) {
        const base = baseKeys.get(entry.key);
        const basePaths = base ? new Set(base.fieldPaths || []) : null;
        const newFields = basePaths
            ? entry.fieldPaths.filter(p => !basePaths.has(p))
            : [];
        interfaces.push({
            key: entry.key,
            count: entry.count,
            errors: entry.errors,
            firstSeenAt: entry.firstSeenAt,
            lastSeenAt: entry.lastSeenAt,
            dirs: entry.dirs,
            bytes: entry.bytes,
            fieldPaths: entry.fieldPaths,
            newFields,
            isNew: !base,
            samples: entry.samples,
        });
    }
    interfaces.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    const baseActivity = baseline && baseline.activity ? baseline.activity : null;
    const knownGroups = new Set(
        baseActivity && Array.isArray(baseActivity.groupIds) ? baseActivity.groupIds : [],
    );
    const knownChildren = new Set(
        baseActivity && Array.isArray(baseActivity.childIds) ? baseActivity.childIds : [],
    );

    let activity = null;
    if (activityGroups.size) {
        activity = {
            at: activityAt,
            groups: [...activityGroups.values()].map(g => ({
                ...g,
                isNew: baseline ? !knownGroups.has(g.id) : false,
                children: g.children.map(c => ({
                    ...c,
                    isNew: baseline ? !knownChildren.has(c.id) : false,
                    // body 字段在 proto 里没定义 => 新玩法, 需要补 .proto
                    undefinedBodyFields: c.bodyFields.filter(f => !f.defined).map(f => f.no),
                })),
            })),
            summaries: [...activitySummaries.values()],
        };
    }

    return {
        accountId: String(process.env.FARM_ACCOUNT_ID || '').trim() || 'default',
        generatedAt: Date.now(),
        startedAt,
        baselineAt: baseline ? baseline.frozenAt : 0,
        baselineInterfaces: baseline && Array.isArray(baseline.interfaces) ? baseline.interfaces.length : 0,
        interfaceCount: interfaces.length,
        interfaces,
        newInterfaces: interfaces.filter(i => i.isNew).map(i => i.key),
        activity,
    };
}

/** 把当前 catalog 冻结成新基线(面板上的「以此为准」) */
function freezeBaseline() {
    const snap = snapshot();
    const groupIds = [];
    const childIds = [];
    if (activityGroups.size) {
        for (const g of activityGroups.values()) {
            groupIds.push(g.id);
            for (const c of g.children) childIds.push(c.id);
        }
    }
    const next = {
        frozenAt: Date.now(),
        interfaces: snap.interfaces.map(i => ({
            key: i.key,
            fieldPaths: i.fieldPaths,
            dirs: i.dirs,
        })),
        activity: { groupIds, childIds },
    };
    writeJsonAtomic(fileOf('baseline.json'), next);
    baseline = next;
    return next;
}

function loadBaseline() {
    const raw = readJsonSafe(fileOf('baseline.json'), null);
    baseline = (raw && Array.isArray(raw.interfaces)) ? raw : null;
    return baseline;
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
    }, FLUSH_INTERVAL_MS);
    if (flushTimer.unref) flushTimer.unref();
}

function flush(force = false) {
    // 结构没变且距上次落盘不足心跳间隔 → 跳过(计数/lastSeenAt 的变化不值得
    // 每 5 秒全量重写一份几 MB 的 catalog JSON × 4 个账号)
    if (!dirty && !force && Date.now() - lastFlushAt < HEARTBEAT_FLUSH_MS) return false;
    dirty = false;
    lastFlushAt = Date.now();
    try {
        const snap = snapshot();
        // catalog-<账号>.json 只存结构化数据 + 少量样本
        writeJsonAtomic(catalogFile(), snap);
        return true;
    } catch {
        dirty = true;
        return false;
    }
}

function reset() {
    catalog.clear();
    activityGroups = new Map();
    activitySummaries = new Map();
    activityAt = 0;
    dirty = true;
    lastFlushAt = 0;
    flush(true);
}

function start() {
    if (startedAt) return true;
    startedAt = Date.now();
    loadBaseline();
    ensureDir();
    // 进程退出前落盘, 避免丢最后一次采集(force: 退出时无条件写, 不受心跳门控)
    const onExit = () => { try { flush(true); } catch {} };
    process.once('exit', onExit);
    return true;
}

function stop() {
    enabled = false;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
}

function isEnabled() { return enabled; }
function setEnabled(value) { enabled = !!value; }

module.exports = {
    start,
    stop,
    observe,
    snapshot,
    freezeBaseline,
    loadBaseline,
    flush,
    reset,
    isEnabled,
    setEnabled,
    __private: { harvestActivityList, getProtoReflection },
};
