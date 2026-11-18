#!/usr/bin/env node
/**
 * 协议观察报告 —— 不改任何代码, 直接看「机器人自己采到了什么」
 *
 * 前置: 机器人有账号在跑(观察器默认开启), 数据落在 data/protocol/catalog-<账号>.json
 *
 * 用法:
 *   node scripts/proto-report.js                 # 汇总: 新接口 / 新字段 / 活动结构变化
 *   node scripts/proto-report.js --freeze        # 把当前结果定成基线(之后的变化才算"更新")
 *   node scripts/proto-report.js --key ActivityService.List
 *                                                # 看某接口的字段树(从采样 hex 现场解, 不依赖 .proto)
 *   node scripts/proto-report.js --key List --strings
 *                                                # 只抽可读字符串(活动规则文案常在这里)
 *   node scripts/proto-report.js --activity 牧歌   # 按活动名/ID 搜活动组与子活动
 *   node scripts/proto-report.js --json          # 输出 JSON(给别的脚本吃)
 *
 * 退出码: 0 正常; 1 没采到数据; 2 参数错误
 */
'use strict';

const path = require('node:path');
const process = require('node:process');

const catalog = require('../src/runtime/protocol-catalog');

function parseArgs(argv) {
    const args = { key: '', activity: '', strings: false, json: false, freeze: false, depth: 5, limit: 3 };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') args.json = true;
        else if (a === '--strings') args.strings = true;
        else if (a === '--freeze') args.freeze = true;
        else if (a === '--key') args.key = argv[++i] || '';
        else if (a === '--activity') args.activity = argv[++i] || '';
        else if (a === '--depth') args.depth = Number(argv[++i]) || 5;
        else if (a === '--limit') args.limit = Number(argv[++i]) || 3;
        else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
        else { console.error(`未知参数: ${a}`); printHelp(); process.exit(2); }
    }
    return args;
}

function printHelp() {
    console.log(`用法: node scripts/proto-report.js [选项]

  --freeze            把当前采到的接口/活动结构冻结成基线
  --key <关键词>      只看匹配的接口(如 ActivityService.List)
  --activity <关键词> 按活动名或 ID 搜活动组/子活动(如 牧歌 / 2026111700)
  --strings           配合 --key: 只抽可读字符串
  --depth <n>         配合 --key: 字段树深度, 默认 5
  --limit <n>         配合 --key: 看几条样本, 默认 3
  --json              输出 JSON`);
}

function fmtTime(ms) {
    if (!ms) return '-';
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function printOverview(overview) {
    console.log('===== 协议观察报告 =====');
    console.log(`生成时间   : ${fmtTime(overview.generatedAt)}`);
    console.log(`数据来源   : ${overview.sources.length} 个账号`);
    for (const s of overview.sources) {
        console.log(`  - ${s.accountId}: ${s.interfaceCount} 个接口, 最后采集 ${fmtTime(s.at)}`);
    }
    console.log(`基线       : ${overview.hasBaseline ? fmtTime(overview.baselineAt) : '未设置(先跑 --freeze)'}`);
    console.log(`接口总数   : ${overview.interfaceCount}`);

    console.log('\n===== 活动结构 =====');
    const change = overview.activityChange;
    if (!change) {
        console.log('  还没采到 ActivityService.List(账号需要跑过活动列表)');
    } else {
        console.log(`  活动组 ${change.groups.length} 个, 快照时间 ${fmtTime(change.at)}`);
        for (const g of change.groups) {
            const flag = g.isNew ? '  ★新活动组' : '';
            console.log(`  [${g.id}] ${g.name}${flag}`);
            for (const c of (g.children || [])) {
                const cf = c.isNew ? ' ★新子活动' : '';
                const undef = c.undefinedBodyFields && c.undefinedBodyFields.length
                    ? `  ⚠ 未定义 body 字段 #${c.undefinedBodyFields.join(', #')}`
                    : '';
                console.log(`     └ [${c.id}] ${c.name}${cf}${undef}`);
            }
        }
        if (change.newGroups.length) {
            console.log(`\n  ★ 新活动组: ${change.newGroups.map(g => `${g.id}/${g.name}`).join(', ')}`);
        }
        if (change.newChildren.length) {
            console.log(`  ★ 新子活动: ${change.newChildren.map(c => `${c.id}/${c.name}`).join(', ')}`);
        }
        if (change.undefinedBodyFields.length) {
            console.log('  ⚠ 以下子活动的 body 字段在 proto 里没有定义(需要补 .proto):');
            for (const item of change.undefinedBodyFields) {
                console.log(`     [${item.id}] ${item.name}: #${item.fields.join(', #')}`);
            }
        }
    }

    console.log('\n===== ★ 基线之后新出现的接口 =====');
    if (!overview.hasBaseline) {
        console.log('  未设置基线 —— 全部接口都算"新"。想只看真正新增的, 先跑 --freeze');
    } else if (!overview.newInterfaces.length) {
        console.log('  没有新接口。');
    } else {
        for (const key of overview.newInterfaces) console.log(`  ${key}`);
    }

    console.log('\n===== 老接口出现新字段 =====');
    if (!overview.interfacesWithNewFields.length) {
        console.log('  无。');
    } else {
        for (const it of overview.interfacesWithNewFields) {
            console.log(`  ${it.key}: +${it.newFields.join(', +')}`);
        }
    }

    console.log('\n===== 全部接口(按最近活跃) =====');
    const rows = overview.interfaces.slice(0, 40);
    for (const it of rows) {
        const flags = [it.isNew ? '★new' : '', it.errors ? `err=${it.errors}` : ''].filter(Boolean).join(' ');
        console.log(`  ${String(it.count).padStart(6)}  ${it.key}${flags ? `  ${flags}` : ''}`);
    }
    if (overview.interfaces.length > rows.length) {
        console.log(`  … 还有 ${overview.interfaces.length - rows.length} 个, 用 --json 看全部`);
    }
}

function printInspect(overview, args) {
    const matched = overview.interfaces.filter(i => i.key.includes(args.key));
    if (!matched.length) {
        console.error(`没采到接口: ${args.key}`);
        process.exit(1);
    }
    const raw = catalog.listRawCatalogs();
    for (const target of matched.slice(0, 3)) {
        console.log(`\n===== ${target.key} (x${target.count}) =====`);
        // 响应/推送才是带数据的; 请求体往往只有几个参数。先 S->C 再 C->S。
        const ordered = [];
        for (const data of raw) {
            for (const it of (data.interfaces || [])) {
                if (it.key !== target.key) continue;
                for (const s of (it.samples || [])) {
                    ordered.push({ accountId: data.accountId, ...s });
                }
            }
        }
        ordered.sort((a, b) => {
            if (a.dir === b.dir) return 0;
            return a.dir === 'S->C' ? -1 : 1;
        });
        const picked = ordered.slice(0, args.limit);
        if (!picked.length) {
            console.log('  (没有采集到 body 样本 —— 该接口请求体为空且没收到响应)');
            continue;
        }
        picked.forEach((s, idx) => {
            const buf = Buffer.from(s.hex || '', 'hex');
            console.log(`\n--- 样本 ${idx + 1}: ${s.accountId} ${s.dir} ${s.bytes}B${s.truncated ? ' (截断)' : ''}`);
            const lines = args.strings
                ? catalog.wire.collectStrings(buf).map(t => `  ${JSON.stringify(t)}`)
                : catalog.wire.describe(buf, { depth: args.depth });
            console.log(lines.length ? lines.join('\n') : '  (空)');
        });
    }
}

function printActivity(overview, keyword) {
    const change = overview.activityChange;
    if (!change) {
        console.error('还没采到活动列表。');
        process.exit(1);
    }
    const kw = keyword.toLowerCase();
    const hit = (id, name) => String(id).includes(kw) || String(name || '').toLowerCase().includes(kw);
    let found = 0;
    for (const g of change.groups) {
        const groupHit = hit(g.id, g.name);
        const kids = (g.children || []).filter(c => hit(c.id, c.name));
        if (!groupHit && !kids.length) continue;
        found += 1;
        console.log(`\n[${g.id}] ${g.name}  开始 ${fmtTime(g.startTime * 1000)}  结束 ${fmtTime(g.endTime * 1000)}${g.isNew ? '  ★新' : ''}`);
        for (const c of (groupHit ? (g.children || []) : kids)) {
            const undef = (c.undefinedBodyFields || []).length
                ? `  ⚠ proto 未定义 body 字段 #${c.undefinedBodyFields.join(', #')}`
                : '';
            console.log(`   └ [${c.id}] ${c.name}  type=${c.type} status=${c.status}${c.isNew ? ' ★新' : ''}${undef}`);
            console.log(`      body: ${(c.bodyFields || []).map(f => `#${f.no}=${f.name}`).join(', ') || '(空)'}`);
            console.log(`      时间: ${fmtTime(c.startTime * 1000)} → ${fmtTime(c.endTime * 1000)}`);
        }
    }
    if (!found) {
        console.error(`没有匹配 "${keyword}" 的活动组/子活动。`);
        process.exit(1);
    }
}

function main() {
    const args = parseArgs(process.argv);

    if (args.freeze) {
        const baseline = catalog.freezeBaseline();
        console.log(`已冻结基线: ${baseline.interfaces.length} 个接口, ${baseline.activity.groupIds.length} 个活动组, 时间 ${fmtTime(baseline.frozenAt)}`);
        return;
    }

    const overview = catalog.getOverview();
    if (!overview.interfaceCount) {
        console.error('还没采到任何接口。确认有账号在跑, 且 FARM_PROTOCOL_OBSERVER 没被设成 0。');
        console.error(`数据目录: ${path.join(catalog.protocolDir())}`);
        process.exit(1);
    }

    if (args.json) {
        console.log(JSON.stringify(overview, null, 2));
        return;
    }

    if (args.activity) {
        printActivity(overview, args.activity);
        return;
    }

    if (args.key) {
        printInspect(overview, args);
        return;
    }

    printOverview(overview);
}

main();
