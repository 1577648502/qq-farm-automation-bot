/**
 * 协议目录聚合 —— 主进程侧把各账号 worker 采到的 catalog 合并成一份视图
 *
 * 为什么在运行时侧而不是 worker 里:
 *   worker 只负责"边跑边记", 面板需要的是**所有账号合并后的结论**;
 *   合并逻辑集中在这里, worker 就不必知道自己有多少同伴。
 *
 * 对外只暴露只读查询 + 一个 freezeBaseline(把当前结果定成基线)。
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('../config/runtime-paths');
const wire = require('../utils/wire');

function protocolDir() {
    return path.join(getDataDir(), 'protocol');
}

function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function listCatalogFiles() {
    const dir = protocolDir();
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter(n => /^catalog-.+\.json$/.test(n))
        .map(n => path.join(dir, n));
}

/** 读所有账号的原始 catalog(含样本 hex), 给 /api/protocol/inspect 用 */
function listRawCatalogs() {
    const out = [];
    for (const file of listCatalogFiles()) {
        const data = readJsonSafe(file);
        if (!data) continue;
        const accountId = String(data.accountId || path.basename(file).replace(/^catalog-|\.json$/g, ''));
        out.push({ ...data, accountId });
    }
    return out;
}

/**
 * 汇总所有账号采集结果, 并与 baseline.json 对比
 *
 * ⚠ 数据源是 worker 各写各的 catalog 文件 + 一份共享 baseline, 都可能:
 *   · 版本比当前代码旧(镜像更新了但 docker volume 里留着旧文件)
 *   · 写了一半(进程被 kill)
 *   · 被手工改坏
 *   所以这里整体兜住: 出问题返回空视图 + error, 绝不让 /api/protocol/overview 直接 500
 *   —— 页面至少要能显示"为什么是空的", 而不是一个错误框。
 *
 * @returns {{
 *   generatedAt:number,
 *   sources: Array<{accountId:string, at:number, interfaceCount:number}>,
 *   interfaceCount:number,
 *   newInterfaces:string[],
 *   interfaces:Array<object>,
 *   activity:object|null,
 *   activityChange:object|null,
 * }} 合并后的接口/活动视图(无数据时 interfaceCount=0)
 */
function getOverview() {
    try {
        return getOverviewUnsafe();
    } catch (e) {
        return {
            generatedAt: Date.now(),
            hasBaseline: false,
            baselineAt: 0,
            baselineInterfaces: 0,
            sources: [],
            interfaceCount: 0,
            newInterfaces: [],
            interfacesWithNewFields: [],
            interfaces: [],
            activity: null,
            activityChange: null,
            error: `汇总失败: ${e && e.message ? e.message : e}`,
            errorDetail: String((e && e.stack) || '').slice(0, 500),
        };
    }
}

function getOverviewUnsafe() {
    const baseline = readJsonSafe(path.join(protocolDir(), 'baseline.json'));
    const baseKeys = new Map();
    const baseGroups = new Set();
    const baseChildren = new Set();
    if (baseline && Array.isArray(baseline.interfaces)) {
        for (const it of baseline.interfaces) baseKeys.set(it.key, it);
    }
    if (baseline && baseline.activity) {
        for (const id of (baseline.activity.groupIds || [])) baseGroups.add(Number(id));
        for (const id of (baseline.activity.childIds || [])) baseChildren.add(Number(id));
    }

    const merged = new Map();     // key -> 合并后的接口
    const sources = [];
    let activity = null;
    let latestActivityAt = 0;

    for (const file of listCatalogFiles()) {
        const data = readJsonSafe(file);
        if (!data) continue;
        const accountId = String(data.accountId || path.basename(file).replace(/^catalog-|\.json$/g, ''));
        sources.push({
            accountId,
            at: Number(data.generatedAt) || 0,
            interfaceCount: Array.isArray(data.interfaces) ? data.interfaces.length : 0,
        });

        for (const it of (Array.isArray(data.interfaces) ? data.interfaces : [])) {
            if (!it || !it.key) continue;
            const cur = merged.get(it.key) || {
                key: it.key,
                count: 0,
                errors: 0,
                firstSeenAt: 0,
                lastSeenAt: 0,
                dirs: {},
                fieldPaths: [],
                bytes: { min: 0, max: 0 },
                samples: [],
                accounts: [],
            };
            cur.count += Number(it.count) || 0;
            cur.errors += Number(it.errors) || 0;
            cur.firstSeenAt = cur.firstSeenAt ? Math.min(cur.firstSeenAt, Number(it.firstSeenAt) || cur.firstSeenAt) : Number(it.firstSeenAt) || 0;
            cur.lastSeenAt = Math.max(cur.lastSeenAt, Number(it.lastSeenAt) || 0);
            for (const [d, n] of Object.entries(it.dirs || {})) cur.dirs[d] = (cur.dirs[d] || 0) + n;
            for (const p of (it.fieldPaths || [])) if (!cur.fieldPaths.includes(p)) cur.fieldPaths.push(p);
            const b = it.bytes || {};
            if (b.min) cur.bytes.min = cur.bytes.min ? Math.min(cur.bytes.min, b.min) : b.min;
            if (b.max) cur.bytes.max = Math.max(cur.bytes.max, b.max);
            for (const s of (it.samples || [])) {
                if (cur.samples.length < 2) cur.samples.push({ accountId, ...s });
            }
            if (!cur.accounts.includes(accountId)) cur.accounts.push(accountId);
            merged.set(it.key, cur);
        }

        if (data.activity && data.activity.at && data.activity.at > latestActivityAt) {
            latestActivityAt = data.activity.at;
            activity = data.activity;
        }
    }

    const interfaces = [...merged.values()].map(it => {
        const base = baseKeys.get(it.key);
        const basePaths = base ? new Set(base.fieldPaths || []) : null;
        return {
            ...it,
            fieldPaths: it.fieldPaths.sort(),
            isNew: !base,
            // 新接口: 全部字段都算新(否则面板上只看到"有问题"却不知道哪些字段);
            // 老接口: 只报基线之后新增的
            newFields: basePaths
                ? it.fieldPaths.filter(p => !basePaths.has(p))
                : (base ? [] : it.fieldPaths),
        };
    });
    interfaces.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    // 活动结构对比: 新活动组 / 新子活动 / proto 里没定义的 body 字段
    // ⚠ catalog 文件是 worker 写出来的, 版本可能比当前代码旧(镜像更新了但 volume 里留着旧文件),
    //   字段缺失/类型不对都可能出现。这里每一步都要容错, 否则一个坏文件就让整个接口 500。
    let activityChange = null;
    if (activity) {
        const groups = (Array.isArray(activity.groups) ? activity.groups : [])
            .filter(g => g && typeof g === 'object')
            .map(g => ({
                ...g,
                isNew: baseline ? !baseGroups.has(Number(g.id) || 0) : false,
                children: (Array.isArray(g.children) ? g.children : [])
                    .filter(c => c && typeof c === 'object')
                    .map(c => ({
                        ...c,
                        isNew: baseline ? !baseChildren.has(Number(c.id) || 0) : false,
                        bodyFields: Array.isArray(c.bodyFields) ? c.bodyFields.filter(f => f && typeof f === 'object') : [],
                        undefinedBodyFields: (Array.isArray(c.bodyFields) ? c.bodyFields : [])
                            .filter(f => f && typeof f === 'object' && !f.defined)
                            .map(f => f.no),
                    })),
            }));
        activityChange = {
            at: activity.at,
            newGroups: groups.filter(g => g.isNew).map(g => ({ id: g.id, name: g.name })),
            newChildren: groups.flatMap(g => g.children.filter(c => c.isNew).map(c => ({ id: c.id, name: c.name, group: g.name }))),
            undefinedBodyFields: groups.flatMap(g => g.children
                .filter(c => c.undefinedBodyFields.length)
                .map(c => ({ id: c.id, name: c.name, fields: c.undefinedBodyFields }))),
            groups,
        };
    }

    return {
        generatedAt: Date.now(),
        hasBaseline: !!baseline,
        baselineAt: baseline ? baseline.frozenAt : 0,
        baselineInterfaces: baseline && Array.isArray(baseline.interfaces) ? baseline.interfaces.length : 0,
        sources,
        interfaceCount: interfaces.length,
        newInterfaces: interfaces.filter(i => i.isNew).map(i => i.key),
        interfacesWithNewFields: interfaces.filter(i => i.newFields.length).map(i => ({ key: i.key, newFields: i.newFields })),
        interfaces,
        activity: activity ? { at: activity.at, groups: activity.groups } : null,
        activityChange,
    };
}

/** 把当前聚合结果冻结成基线。写的是共享的 baseline.json */
function freezeBaseline() {
    const overview = getOverview();
    const groupIds = [];
    const childIds = [];
    if (overview.activity && Array.isArray(overview.activity.groups)) {
        for (const g of overview.activity.groups) {
            groupIds.push(Number(g.id));
            for (const c of (g.children || [])) childIds.push(Number(c.id));
        }
    }
    const next = {
        frozenAt: Date.now(),
        interfaces: overview.interfaces.map(i => ({
            key: i.key,
            fieldPaths: i.fieldPaths,
            dirs: i.dirs,
        })),
        activity: { groupIds, childIds },
    };
    const dir = protocolDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'baseline.json');
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return next;
}

module.exports = { getOverview, freezeBaseline, protocolDir, listRawCatalogs, wire };
