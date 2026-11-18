/**
 * 协议观察器 回归测试
 *
 * 为什么要有它:
 *   这套东西的产出直接决定"要不要补 .proto"。判错了会有两种后果:
 *     · 漏报 —— 新玩法上线但没告警, 又回到手动抓包的老路;
 *     · 误报 —— 每次都喊"有新接口", 人就不看了。
 *   所以这里锁三类行为:
 *     1) 裸 wire 解析: 字段号/wire type/嵌套都拆对, 坏数据不炸;
 *     2) 活动结构: **proto 里没定义的 body 字段号必须被发现**(2026-11-18「故友重逢」#109 就是这么漏的);
 *     3) 基线对比: 冻结前全算新, 冻结后只有真变化才报。
 *
 * 数据来源: 真实抓包 wx-code-grabber/captures/20261117-162604_牧场1.decoded.jsonl
 * 这份抓包里同时有 农场(0801) 与 牧场(0802) 两个场景的 ActivityService.List。
 */
const fs = require('node:fs');
const path = require('node:path');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'proto-observer-test';
const DATA_DIR = isolateDataDir(SB, 'proto-observer-test');

const CAPTURE = path.join(
    __dirname, '..', '..', 'wx-code-grabber', 'captures', '20261117-162604_牧场1.decoded.jsonl',
);

const wire = require(`${SB}/src/utils/wire`);
const proto = require(`${SB}/src/utils/proto`);
const observer = require(`${SB}/src/utils/protocol-observer`);
const catalog = require(`${SB}/src/runtime/protocol-catalog`);

/** 读出抓包里的全部帧(只取有 bodyHex 的) */
function loadFrames() {
    if (!fs.existsSync(CAPTURE)) return [];
    const frames = [];
    for (const line of fs.readFileSync(CAPTURE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (!j.key || !j.bodyHex) continue;
        frames.push({
            dir: j.dir,
            key: j.key,
            body: Buffer.from(j.bodyHex, 'hex'),
            errorCode: (j.meta && j.meta.error_code) || 0,
        });
    }
    return frames;
}

proto.loadProto().then(async () => {
    section('1. 裸 wire 解析');
    {
        // 手工构造: #1 varint=150, #2 string="hi", #3 内嵌 {#1 varint=7}
        const inner = Buffer.from([0x08, 0x07]);
        const buf = Buffer.concat([
            Buffer.from([0x08, 0x96, 0x01]),                 // #1 = 150
            Buffer.from([0x12, 0x02]), Buffer.from('hi'),   // #2 = "hi"
            Buffer.from([0x1A, inner.length]), inner,       // #3 = {#1=7}
        ]);
        const r = wire.parseFields(buf);
        check('无解析错误', !r.error, r.error);
        check('#1 varint = 150', r.fields[0].no === 1 && r.fields[0].value === 150, r.fields[0]);
        check('#2 string = "hi"', r.fields[1].no === 2 && wire.asText(r.fields[1].bytes) === 'hi');
        check('#3 是内嵌 message', wire.looksLikeMessage(r.fields[2].bytes));

        // 截断数据不能抛异常, 只能返回 error
        let threw = false;
        try { wire.parseFields(Buffer.from([0x0A, 0x10, 0x01])); } catch { threw = true; }
        check('长度溢出不抛异常', !threw);

        const fp = wire.footprint(buf);
        check('footprint 含 1:0 / 2:2 / 3.1:0',
            fp.paths.includes('1:0') && fp.paths.includes('2:2') && fp.paths.includes('3.1:0'), fp.paths);
    }

    const frames = loadFrames();
    check('抓到真实抓包', frames.length > 0, `${CAPTURE} (${frames.length} 帧)`);
    if (!frames.length) return finish();

    section('2. 指纹: 相同结构 → 相同指纹, 值不同也不影响');
    {
        const a = Buffer.from([0x08, 0x01]);
        const b = Buffer.from([0x08, 0x63]);
        check('同结构不同值指纹一致',
            JSON.stringify(wire.footprint(a).paths) === JSON.stringify(wire.footprint(b).paths));
        const c = Buffer.from([0x08, 0x01, 0x10, 0x02]);
        check('多一个字段 → 指纹不同',
            JSON.stringify(wire.footprint(a).paths) !== JSON.stringify(wire.footprint(c).paths));
    }

    section('3. 活动结构: 必须发现 proto 未定义的 body 字段');
    {
        observer.reset();
        observer.setEnabled(true);
        observer.start();
        for (const f of frames) observer.observe(f.dir, f.key, f.body, { errorCode: f.errorCode });
        const snap = observer.snapshot();

        check('采到接口', snap.interfaceCount > 20, snap.interfaceCount);
        check('采到活动快照', !!snap.activity, snap.activity ? 'ok' : 'missing');

        const groups = (snap.activity && snap.activity.groups) || [];
        const byId = new Map(groups.map(g => [g.id, g]));

        // ⚠ 核心断言: ListRequest#1 是场景号(1=农场 2=牧场), 两次响应各有自己的组,
        //   必须合并而不是后一次覆盖前一次。
        check('农场场景组 2026111700 存在', byId.has(2026111700), [...byId.keys()]);
        check('牧场场景组 2026111800 存在', byId.has(2026111800), [...byId.keys()]);

        const muge = byId.get(2026111700);
        check('牧歌初启 有 4 个子活动', muge && muge.children.length === 4, muge && muge.children.length);
        const mugeBodyNos = muge ? muge.children.flatMap(c => c.bodyFields.map(f => f.no)).sort() : [];
        check('牧歌子活动 body = 124/125/126/127',
            JSON.stringify(mugeBodyNos) === JSON.stringify([124, 125, 126, 127]), mugeBodyNos);
        check('牧歌 body 字段都在 proto 里定义',
            muge && muge.children.every(c => c.bodyFields.every(f => f.defined)),
            muge && muge.children.map(c => c.bodyFields));

        const friend = byId.get(2026111800);
        const friendChild = friend && friend.children[0];
        check('故友重逢 子活动 body 字段 = #109', friendChild && friendChild.bodyFields[0].no === 109,
            friendChild && friendChild.bodyFields);
        // 这条是本次 git 提交里真实踩到的坑: proto 没写 ActivityData#109, protobufjs 会静默丢掉,
        // 只靠反射是发现不了的 —— 必须以裸 wire 为准。
        check('故友重逢 #109 标记为「proto 未定义」',
            friendChild && friendChild.bodyFields[0].defined === false,
            friendChild && friendChild.bodyFields[0]);
        check('故友重逢 #109 出现在 undefinedBodyFields',
            JSON.stringify((friendChild && friendChild.undefinedBodyFields) || []) === JSON.stringify([109]),
            friendChild && friendChild.undefinedBodyFields);
    }

    section('4. 基线对比: 冻结后不误报, 新增才报');
    {
        // getOverview 读的是落盘文件(面板/命令行看到的是"稳定后"的视图),
        // 所以测试里观察完必须显式 flush 才能被聚合器读到。
        observer.flush();
        // 冻结前: 全部算新
        catalog.freezeBaseline();       // 用当前采集结果定基线
        const after = catalog.getOverview();
        check('冻结后没有新接口', after.newInterfaces.length === 0, after.newInterfaces.slice(0, 5));
        check('冻结后没有新字段',
            after.interfacesWithNewFields.length === 0, after.interfacesWithNewFields.slice(0, 3));

        // 模拟"服务端给某接口加了一个字段": 再造一帧, 字段号是没见过的
        observer.observe('S->C', 'gamepb.fakepb.FakeService.Ping', Buffer.from([0x08, 0x01]));
        observer.flush();
        const overview2 = catalog.getOverview();
        check('新接口能被识别',
            overview2.newInterfaces.includes('gamepb.fakepb.FakeService.Ping'), overview2.newInterfaces.slice(0, 5));

        // 老接口加字段
        observer.observe('S->C', 'gamepb.fakepb.FakeService.Ping', Buffer.from([0x08, 0x01, 0x18, 0x02]));
        observer.flush();
        const overview3 = catalog.getOverview();
        const grew = overview3.interfacesWithNewFields.find(i => i.key === 'gamepb.fakepb.FakeService.Ping');
        check('新字段能被识别', !!grew && grew.newFields.includes('3:0'), grew);
    }

    section('5. 落盘: 文件存在且 JSON 可读');
    {
        observer.flush();
        const file = path.join(DATA_DIR || '', 'protocol', 'catalog-proto-observer-test.json');
        check('catalog 文件已写出', fs.existsSync(file), file);
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            check('落盘含 accountId', data.accountId === 'proto-observer-test', data.accountId);
            check('落盘含活动快照', !!(data.activity && data.activity.groups.length), data.activity && data.activity.groups.length);
        }
        const base = path.join(DATA_DIR || '', 'protocol', 'baseline.json');
        check('baseline 文件已写出', fs.existsSync(base), base);
    }

    observer.stop();
    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
