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
    section('0. 观察器绝不能打断 WS 收发(热路径上的安全底线)');
    {
        // observe() 直接被 network.encodeMsg / handleMessage 调用。它一旦抛异常,
        // 登录、心跳、所有业务请求都会一起断 —— 这是比"漏采一帧"严重得多的事故。
        observer.setEnabled(true);
        observer.start();
        let threw = false;
        try {
            // 各种畸形输入都不能逃逸出异常
            observer.observe('C->S', 'gamepb.testpb.TestService.Bad', Buffer.from([0xFF, 0xFF, 0xFF]));
            observer.observe('S->C', 'gamepb.testpb.TestService.Bad', Buffer.alloc(0));
            observer.observe('S->C', '', Buffer.from('x'));
            observer.observe('S->C', 'gamepb.testpb.TestService.Null', null);
            observer.observe('S->C', 'gamepb.testpb.TestService.Undef', undefined);
            observer.observe('C->S', '[Notify] x', Buffer.from([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]));
        } catch (e) {
            threw = true;
            console.log('  observe 抛出了异常:', e.message);
        }
        check('畸形帧不抛异常', !threw);
        // 采坏数据之后仍然正常工作
        observer.observe('S->C', 'gamepb.testpb.TestService.Ok', Buffer.from([0x08, 0x01]));
        const snap = observer.snapshot();
        check('坏帧之后仍能正常采集', snap.interfaces.some(i => i.key === 'gamepb.testpb.TestService.Ok'),
            snap.interfaces.map(i => i.key).slice(0, 3));
    }

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

    section('4.5 指纹抽样: 结构稳定后降频解析, 新字段 ≤40 帧内仍被发现');
    {
        // 性能优化(2026-11-22): footprint 全量 wire 解析是 WS 热路径大头。
        // 锁定: ① 稳定后不再每帧解析(用调用计数验证); ② 抽样窗口内新字段必被发现;
        //       ③ 无结构变化的 flush 直接跳过(不再每 5s 全量重写 catalog)。
        observer.reset();
        observer.setEnabled(true);
        observer.start();
        const wireMod = require(`${SB}/src/utils/wire`);
        const origFootprint = wireMod.footprint;
        let fpCalls = 0;
        wireMod.footprint = (buf, opts) => { fpCalls += 1; return origFootprint(buf, opts); };
        try {
            const body = Buffer.from([0x08, 0x01]);
            const K = 'gamepb.samplingpb.SampleService.Steady';
            for (let i = 0; i < 100; i++) observer.observe('S->C', K, body);
            // 100 帧: warmup 30 逐帧 + 40/80 两次探测 ≈ 32 次, 远小于 100
            check('稳定接口不再逐帧解析', fpCalls <= 40, `footprint 调用 ${fpCalls}/100`);

            // 新字段出现在抽样窗口内: 40 帧内必被发现
            const grown = Buffer.from([0x08, 0x01, 0x10, 0x02]);
            let detected = false;
            for (let i = 0; i < 40; i++) {
                observer.observe('S->C', K, grown);
                const snap = observer.snapshot();
                const it = snap.interfaces.find(x => x.key === K);
                if (it && it.fieldPaths.includes('2:0')) { detected = true; break; }
            }
            check('新字段 ≤40 帧内被发现', detected);

            // 无结构变化: flush 跳过落盘(返回 false), force 才写
            observer.flush(true);
            const skipped = observer.flush();
            check('无结构变化 flush 跳过', skipped === false);
            check('force flush 落盘', observer.flush(true) === true);
        } finally {
            wireMod.footprint = origFootprint;
        }
        // 还原活动快照(4.5 的 reset 清掉了), 让 section 5 的落盘断言仍成立
        for (const f of frames) observer.observe(f.dir, f.key, f.body, { errorCode: f.errorCode });
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

    section('6. 脱敏: 登录/支付类请求不落盘样本(明文凭据不能留在磁盘)');
    {
        // 观察器记的是解密后明文; 登录请求 body 里有 openID/device_id, 不能存。
        observer.observe('C->S', 'gamepb.userpb.UserService.Login', Buffer.from([0x08, 0x01, 0x12, 0x02, 0x41, 0x42]));
        observer.observe('C->S', 'gamepb.userpb.UserService.PlayerLogin', Buffer.from([0x08, 0x02]));
        observer.observe('C->S', 'gamepb.paypb.PayService.GetRechargeInfo', Buffer.from([0x08, 0x03]));
        // 普通业务接口要保留样本(否则排查新玩法就没数据了)
        observer.observe('S->C', 'gamepb.activitypb.ActivityService.GetGroup', Buffer.from([0x08, 0x04]));
        observer.flush();

        const file = path.join(DATA_DIR || '', 'protocol', 'catalog-proto-observer-test.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const byKey = new Map((data.interfaces || []).map(i => [i.key, i]));

        const login = byKey.get('gamepb.userpb.UserService.Login');
        check('Login 仍被统计(指纹照采)', !!login && login.count >= 1, login && login.count);
        check('Login 不保留样本', !!login && (!login.samples || login.samples.length === 0),
            login && login.samples && login.samples.length);

        const pay = byKey.get('gamepb.paypb.PayService.GetRechargeInfo');
        check('支付类不保留样本', !!pay && (!pay.samples || pay.samples.length === 0),
            pay && pay.samples && pay.samples.length);

        const group = byKey.get('gamepb.activitypb.ActivityService.GetGroup');
        check('普通业务接口保留样本', !!group && group.samples && group.samples.length > 0,
            group && group.samples && group.samples.length);
    }

    section('7. 损坏的 catalog 文件不能让 /api/protocol/overview 崩(线上真实故障)');
    {
        // 线上报错的根因: docker volume 里可能留着旧版本 worker 写出的 catalog。
        // 旧结构里 bodyFields 可能含 null、children 可能缺失, 而 getOverview 原先直接
        // c.bodyFields.filter(f => !f.defined) —— f 为 null 时抛
        //   TypeError: Cannot read properties of null (reading 'defined')
        // → 接口 500 → 页面整个报错。下面这些畸形形态都必须被容错。
        const dir = path.join(DATA_DIR, 'protocol');
        fs.mkdirSync(dir, { recursive: true });
        const broken = path.join(dir, 'catalog-broken.json');
        fs.writeFileSync(broken, JSON.stringify({
            accountId: 'broken',
            generatedAt: 1,
            interfaces: [
                { key: 'gamepb.testpb.TestService.Ok', count: 3, fieldPaths: ['1:0'], dirs: { 'S->C': 3 }, samples: [] },
                null,                          // 整个接口项是 null
                { count: 1 },                  // 缺 key
            ],
            activity: {
                // ⚠ at 必须比前面几节写入的真实抓包快照更新, 否则聚合时按 at 取最新会跳过这份
                at: Date.now() + 1000,
                groups: [
                    { id: 1, name: '坏组', children: null },                       // children 为 null
                    { id: 2, name: '空子', children: [{ id: 20, bodyFields: null }] },  // bodyFields 为 null
                    { id: 3, name: '怪字段', children: [{ id: 30, bodyFields: [null, { no: 9, defined: false }] }] },
                    null,                                                          // 整个组是 null
                ],
            },
        }));

        let overview = null;
        let threw = null;
        try {
            overview = catalog.getOverview();
        } catch (e) {
            threw = e;
        }
        check('损坏文件不抛异常', threw === null, threw && threw.message);
        check('仍然返回可用视图', !!overview && overview.interfaceCount >= 1, overview && overview.interfaceCount);
        check('正常接口被保留',
            !!overview && overview.interfaces.some(i => i.key === 'gamepb.testpb.TestService.Ok'));
        // null 项被过滤, 有值的照常识别。
        // ⚠ 这里不能断言"只有 1 条": 前面第 3 节已经写过一份含「故友重逢 #109」的 catalog,
        //   聚合时会一起出现。只针对 broken 这份里的 #30 做断言。
        const undef = (overview && overview.activityChange && overview.activityChange.undefinedBodyFields) || [];
        const brokenEntry = undef.find(x => x.id === 30);
        check('bodyFields 里的 null 被跳过, 有效的 #9 仍被识别',
            !!brokenEntry && JSON.stringify(brokenEntry.fields) === JSON.stringify([9]),
            brokenEntry || undef);

        // 完全非法的 JSON 也不能崩
        fs.writeFileSync(broken, 'this is not json {{{');
        let threw2 = null;
        let overview2 = null;
        try { overview2 = catalog.getOverview(); } catch (e) { threw2 = e; }
        check('非法 JSON 不抛异常', threw2 === null, threw2 && threw2.message);
        // 坏文件被忽略; 其他合法 catalog(前几节写的)仍然被读出来
        check('非法 JSON 被跳过, 不影响其他账号的数据',
            !!overview2 && !overview2.interfaces.some(i => i.key === 'gamepb.testpb.TestService.Ok'),
            overview2 && overview2.interfaceCount);
    }

    observer.stop();
    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
