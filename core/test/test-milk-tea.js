/**
 * 奶茶热销中（2026-10-15 新活动）回归测试 —— 回放真实抓包
 *
 * 抓包: 20261015-154340_奶茶新活动.jsonl
 * 覆盖:
 *   1. 主活动状态解析(#121: 店名/营业额/配方) + 刷新命令(cmd=63, payload 字段 = cmd+105)
 *   2. 领收银台收益(cmd=55) / 工坊加工(cmd=56 {#1:1}) / 宣传喇叭(cmd=58) / 开业(cmd=53 {#1:"店名"})
 *   3. 种子商店列表(0102 cmd=7) 与 **兑换(0102 cmd=1 {#101:{#1:商品ID, #2:数量}})**, 结果解析
 *   4. 任务列表(0103 cmd=7)
 *
 * 运行: node test/test-milk-tea.js
 */
const path = require('node:path');
const fs = require('node:fs');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'milk-tea-test';
isolateDataDir(SB, 'milk-tea-test');

const CAP = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261015-154340_奶茶新活动.jsonl');

function loadFrames(file) {
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.ev || j.dir !== 'S->C' || !j.hex) continue;
        out.push(j);
    }
    return out;
}
const FRAMES = loadFrames(CAP);
const OPERATE = 'gamepb.activitypb.ActivityService.Operate';
// 关键帧: 主活动 60(最后一次刷新, 状态最全) / 55(领收益) / 56(加工) / 58(喇叭) / 53(开业)
const byIdx = (i) => FRAMES.find(f => f.idx === i);

(async () => {
    const { types } = require(`${SB}/src/utils/proto`);
    await require(`${SB}/src/utils/proto`).loadProto();
    // ⚠ 占位桩: mengchong/milk-tea 在 require 时就会解构 network.sendMsgAsync,
    //   所以必须在加载任何业务模块之前把它换成转发函数; 真实实现稍后赋给 sendStub
    const net = require(`${SB}/src/utils/network`);
    let sendStub = null;
    net.sendMsgAsync = (...a) => sendStub(...a);
    // ⚠ 打桩必须早于 require mengchong/milk-tea(mengchong 在 require 时就解构了 sendMsgAsync)
    const lazyMg = () => require(`${SB}/src/services/mengchong`);
    const bodyOf = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);
    const mg = { parseTop: (b) => lazyMg().parseTop(b) };
    const parseReq = (buf) => {
        const f = mg.parseTop(Buffer.from(buf));
        const g = Number((f.find(x => x.f === 1) || {}).v) || 0;
        const cmd = Number((f.find(x => x.f === 2) || {}).v) || 0;
        return { group: g, cmd, fields: f };
    };

    const sent = [];
    const stub = (idxFor) => async (service, method, body) => {
        if (method !== 'Operate') throw new Error('未 stub: ' + service + '.' + method);
        const req = parseReq(body);
        sent.push(req);
        const hit = idxFor(req);
        if (!hit) throw new Error(`没有 group=${req.group} cmd=${req.cmd} 的响应帧`);
        return { body: bodyOf(hit.hex) };
    };

    // 真实抓包里有: 主活动 60/55/56/58/53 等; 商店 7/1; 任务 7
    const frameFor = (req) => {
        const table = {
            '2026110101:63': 39,      // 刷新(取较早的 63)
            '2026110101:60': 39,      // 兜底
            '2026110101:55': 36,      // 领收益
            '2026110101:56': 37,      // 加工
            '2026110101:58': 38,      // 喇叭
            '2026110101:53': 35,      // 开业
        };
        let idx = table[`${req.group}:${req.cmd}`];
        if (!idx) {
            const f = FRAMES.find(x => {
                if (str(x.key) !== OPERATE) return false;
                const r = parseReq(bodyOf(x.hex));
                return r.group === req.group && r.cmd === req.cmd;
            });
            return f || null;
        }
        return byIdx(idx) || null;
    };
    function str(v) { return String(v); }

    // 用"按 group+cmd 找第一个匹配帧"的通用兜底
    // ⚠ 先占位: mengchong 在 require 时就会解构 sendMsgAsync, 所以必须在任何业务模块
    //   被 require 之前, 把 network.sendMsgAsync 换成这个转发函数; 真实实现稍后赋给 sendStub
    const FRAME_INDEX = [];
    for (const f of FRAMES) {
        if (String(f.key) !== OPERATE) continue;
        try { FRAME_INDEX.push({ ...parseReq(bodyOf(f.hex)), frame: f }); } catch { /* 跳过 */ }
    }
    // 注意: 主活动 cmd=63 有多帧, 最早的帧里还没有店铺状态(没有 #4 等级);
    //   等级拦截用例需要"已开业"的那一帧 → 取最后一个匹配帧
    const idxFor = (req) => {
        const hits = FRAME_INDEX.filter(x => x.group === req.group && x.cmd === req.cmd);
        if (!hits.length) return null;
        return (req.group === 2026110101 && req.cmd === 63) ? hits[hits.length - 1].frame : hits[0].frame;
    };
    sendStub = stub(idxFor);

    const milkTea = require(`${SB}/src/services/milk-tea`);

    section('1. 主活动状态解析');
    {
        const hit = FRAME_INDEX.find(x => x.group === 2026110101 && x.cmd === 60);
        check('抓包里有主活动 cmd=60 响应', !!hit);
        if (hit) {
            const fsx = mg.parseTop(bodyOf(hit.frame.hex));
            const act = (fsx.find(x => x.f === 3) || {}).v;
            const st = milkTea.__testing.parseMainState(Buffer.from(act));
            check('识别为奶茶热销中活动', st.ok === true, st);
            check('店名 = 奶茶小铺', st.storeName === '奶茶小铺', st.storeName);
            check('营业额为正数(抓包各帧为 263~266)', st.value > 0 && st.value < 100000, st.value);
            check('当前配方 = 10401', st.recipeId === 10401, st.recipeId);
            check('店铺等级 = 1(抓包时刚开业)', st.storeLevel === 1, st.storeLevel);
            check('活动结束时间 = 11/16 23:59(1794844799)', st.endAt === 1794844799, st.endAt);
            check('结算期开始 = 结束前 48h(1794671999)', st.settleAt === 1794671999, st.settleAt);
            check('非结算期(抓包时 10/15)', milkTea.isSettling(st) === false, st.settleAt);
        }
    }

    section('2. 刷新状态(命令与字段号)');
    {
        sent.length = 0;
        const st = await milkTea.getMainStatus();
        check('刷新成功', st.ok === true, st);
        check('用的是 cmd=63', sent.some(x => x.cmd === 63), sent.map(x => x.cmd));
        const req = sent.find(x => x.cmd === 63);
        check('payload 字段 = cmd+105 = #168', !!req && req.fields.some(x => x.f === 168), req && req.fields.map(x => x.f));
    }

    section('3. 一键操作: 领收益 / 加工 / 喇叭 / 开业');
    {
        sent.length = 0;
        const cashier = await milkTea.claimCashier();
        check('领收益 ok', cashier.ok === true, cashier);
        check('用 cmd=59(领取) 而不是 55(详情)', sent.some(x => x.cmd === 59 && x.fields.some(y => y.f === 164)), sent.map(x => x.cmd));

        sent.length = 0;
        const craft = await milkTea.craft();
        check('加工 ok', craft.ok === true, craft);
        const craftReq = sent.find(x => x.cmd === 56);
        check('加工 payload = {#1:1} (hex 0801)', !!craftReq && Buffer.from((craftReq.fields.find(y => y.f === 161) || {}).v || []).toString('hex') === '0801', craftReq && Buffer.from((craftReq.fields.find(y => y.f === 161) || {}).v || []).toString('hex'));

        sent.length = 0;
        const speaker = await milkTea.useSpeaker();
        check('喇叭 ok', speaker.ok === true, speaker);
        check('用 cmd=58 且字段 #163', sent.some(x => x.cmd === 58 && x.fields.some(y => y.f === 163)), sent.map(x => x.cmd));

        sent.length = 0;
        const opened = await milkTea.openStore('自动化测试店');
        check('开业请求已发出', sent.some(x => x.cmd === 53), sent.map(x => x.cmd));
        const openReq = sent.find(x => x.cmd === 53);
        const nameField = openReq && openReq.fields.find(y => y.f === 158);
        const inner = nameField ? mg.parseTop(Buffer.from(nameField.v)) : [];
        check('开业 payload 带店名', !!inner.find(y => y.f === 1 && Buffer.from(y.v || []).toString('utf8') === '自动化测试店'),
            inner.map(y => (y.w === 2 ? Buffer.from(y.v).toString('utf8') : y.v)));
        check('开业返回结构', opened && typeof opened.ok === 'boolean', Object.keys(opened || {}));
    }

    section('4. 种子商店: 列表 + 兑换数量');
    {
        const shop = await milkTea.getShopGoods();
        check('读到商品列表', shop.ok === true && shop.goods.length > 0, shop.goods && shop.goods.length);
        const first = shop.goods[0];
        check('首个商品是森野甜莓种子', first && first.name.includes('森野甜莓'), first);
        check('单价 10000 金币', first && first.unitPrice === 10000 && first.currencyId === 1001, first);
        check('商品 ID = 301', first && first.goodsId === 301, first && first.goodsId);
        check('第 2 个商品带解锁条件', !!(shop.goods[1] && shop.goods[1].unlockText), shop.goods[1] && shop.goods[1].unlockText);

        // 商品总数与多货币(2026-10-15 抓包实测 27 件, 3 种货币)
        check('商品共 27 件', shop.goods.length === 27, shop.goods.length);
        const byId = (id) => shop.goods.find(x => x.goodsId === id);
        check('301 单价 10000 金币', byId(301) && byId(301).currencyId === 1001 && byId(301).unitPrice === 10000, byId(301));
        check('301 限购 108', byId(301) && byId(301).limitCount === 108, byId(301) && byId(301).limitCount);
        check('301 内容物名可解析(兜底别名: 森野甜莓种子×1)', byId(301) && byId(301).itemNameKnown === true && byId(301).itemName === '森野甜莓种子×1', byId(301));

        // 奶茶券(1041)商品 —— 本地表未收录, 靠兜底别名识别
        const fence = byId(311);
        check('311 缤纷奶茶围栏 = 奶茶券 ×20000', fence && fence.currencyId === 1041 && fence.unitPrice === 20000, fence);
        check('311 货币名解析为「奶茶券」', fence && fence.currencyName === '奶茶券', fence && fence.currencyName);
        check('311 类型 = exchange(装扮兑换)', fence && fence.kind === 'exchange', fence && fence.kind);
        check('311 限购 1', fence && fence.limitCount === 1, fence && fence.limitCount);
        check('308 森野黄金芽种子(新) = 奶茶券 ×8000', byId(308) && byId(308).currencyId === 1041 && byId(308).unitPrice === 8000, byId(308));
        check('309 金币果种子(新) = 奶茶券 ×6000 限购 50', byId(309) && byId(309).unitPrice === 6000 && byId(309).limitCount === 50, byId(309));
        check('310 经验蘑菇种子(新) = 奶茶券 ×6000', byId(310) && byId(310).unitPrice === 6000, byId(310));
        check('332 宣传喇叭 = 钻石 ×8', byId(332) && byId(332).currencyId === 1004 && byId(332).unitPrice === 8, byId(332));
        check('种子里程碑: 301-310 共 10 个种子', shop.goods.filter(x => x.kind === 'seed').length === 10, shop.goods.filter(x => x.kind === 'seed').length);

        // 解锁条件(需奶茶店等级): 302 需 ≥3, 301 无要求
        check('301 无解锁要求(requireLevel=0)', byId(301) && byId(301).requireLevel === 0, byId(301) && byId(301).requireLevel);
        check('302 需奶茶店等级 ≥3', byId(302) && byId(302).requireLevel === 3, byId(302) && byId(302).requireLevel);
        check('307 需奶茶店等级 ≥13', byId(307) && byId(307).requireLevel === 13, byId(307) && byId(307).requireLevel);

        sent.length = 0;
        const buy = await milkTea.buyShopGoods(301, 108);
        check('兑换成功', buy.ok === true, buy);
        const req = sent.find(x => x.cmd === 1 && x.group === 2026110102);
        check('购买用 cmd=1(group=商店) 字段 #101', !!req && req.fields.some(y => y.f === 101), req && req.fields.map(y => y.f));
        const payload = req && Buffer.from((req.fields.find(y => y.f === 101) || {}).v || []).toString('hex');
        check('payload(#101 的值) = {#1:301, #2:108} → 08ad02106c', payload === '08ad02106c', payload);
        check('解析出到账 20525×108', buy.got && buy.got.id === 20525 && buy.got.count === 108, buy.got);
        check('解析出花费 1080000 金币', buy.cost && buy.cost.currencyId === 1001 && buy.cost.amount === 1080000, buy.cost);

        // 数量夹取
        sent.length = 0;
        await milkTea.buyShopGoods(301, 0);
        const req2 = sent.find(x => x.cmd === 1);
        const p2 = req2 && Buffer.from((req2.fields.find(y => y.f === 101) || {}).v || []).toString('hex');
        check('数量 0 会被夹成 1 → 08ad021001', p2 === '08ad021001', p2);
    }

    section('4b. 等级不足的商品会被拦住');
    {
        // 抓包响应里店铺等级 = 1, 302 需要 ≥3 → 不应发出购买请求
        sent.length = 0;
        const r = await milkTea.buyShopGoods(302, 1);
        check('等级不足直接拒绝(不发请求)', r.ok === false, r);
        check('原因里带所需等级与当前等级', /≥3/.test(String(r.reason)) && /Lv\d+/.test(String(r.reason)), r.reason);
        check('没有发出 cmd=1 请求', sent.filter(x => x.cmd === 1).length === 0, sent.map(x => x.cmd));
    }

    section('4c. 收银台查询(待领取收益) + 限购记录');
    {
        const cashier = await milkTea.getCashierStatus();
        check('收银台查询成功', cashier.ok === true, cashier);
        check('容量/待领/杯数 = 40/253/164312(抓包实测)', cashier.capacity === 40 && cashier.pending === 253 && cashier.cups === 164312, cashier);

        const shop2 = await milkTea.getShopGoods();
        // 前面第 4 节已买过 301(108 + 夹取后的 1 = 109) → 本会话计数累计, 应标记"已限购"
        const g301 = (shop2.goods || []).find((x) => x.goodsId === 301);
        check('已兑换数累计(109)', g301 && g301.boughtCount === 109, g301 && g301.boughtCount);
        check('超过限购标记 soldOut', g301 && g301.soldOut === true, g301 && g301.soldOut);
        const g302 = (shop2.goods || []).find((x) => x.goodsId === 302);
        check('未买过的商品 boughtCount=0 且未售罄', g302 && g302.boughtCount === 0 && g302.soldOut === false, g302);
    }

    section('4d. 制作奶茶(cmd=62) payload 与抓包逐字节对齐');
    {
        // 抓包(20261015-211043_互动.jsonl, idx=110)请求体:
        //   08 95f98fc607 10 3e ba0a 14 0a12 <18B packed uids>
        //   packed uids = 54158,54178,54177,54179,54157,54159 → 8ea703 a2a703 a1a703 a3a703 8da703 8fa703
        const enc = milkTea.__testing.encodePackedVarints;
        const packed = enc([54158, 54178, 54177, 54179, 54157, 54159]).toString('hex');
        check('packed uid 编码与抓包一致', packed === '8ea703a2a703a1a703a3a7038da7038fa703', packed);

        // 可制作果实 = 活动 10 种种子对应的果实(不是只抓包里的那两种!)
        const fruits = milkTea.getCraftableFruitIds().sort((a, b) => a - b);
        const EXPECT = [40021, 40525, 40526, 40527, 40528, 40529, 41435, 49005];
        check('可制作果实 = 森野系列 8 种', fruits.length === 8 && EXPECT.every((x) => fruits.includes(x)), fruits);
        check('不含非本活动的金币果(40522)/经验蘑菇(40523)',
            !fruits.includes(40522) && !fruits.includes(40523), fruits);

        const uids = enc([54158]);
        const payload = Buffer.concat([Buffer.from([0x0a, uids.length]), uids]);
        check('#167 值 = 0a038ea703', payload.toString('hex') === '0a038ea703', payload.toString('hex'));
    }

    section('4e. 受雇状态判断(互动前置条件)');
    {
        const mg3 = require(`${SB}/src/services/mengchong`);
        const bodyOf = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);
        // 新抓包(做过互动, 受雇中): #121.#1.#11 = 1
        const NEW_CAP = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261015-211043_互动.jsonl');
        const FRAMES_NEW = loadFrames(NEW_CAP);
        check('新抓包已载入', FRAMES_NEW.length > 0, FRAMES_NEW.length);
        const empFrame = FRAMES_NEW.find((f) => {
            try {
                const fsx = mg3.parseTop(bodyOf(f.hex));
                return Number((fsx.find((x) => x.f === 1) || {}).v) === 2026110101;
            } catch { return false; }
        });
        check('新抓包里有主活动帧', !!empFrame);
        if (empFrame) {
            const fsx = mg3.parseTop(bodyOf(empFrame.hex));
            const act = (fsx.find((x) => x.f === 3) || {}).v;
            const st = milkTea.__testing.parseMainState(Buffer.from(act));
            check('受雇标志 workFlag = 1', st.workFlag === 1, st.workFlag);
            check('判为"已被雇佣"(可互动)', st.employed === true, st.employed);
        }
        // 旧抓包(员工玩法之前): 没有 #11 → 未受雇
        const oldFrame = FRAMES.find((f) => {
            try {
                const fsx = mg3.parseTop(bodyOf(f.hex));
                return Number((fsx.find((x) => x.f === 1) || {}).v) === 2026110101;
            } catch { return false; }
        });
        if (oldFrame) {
            const fsx = mg3.parseTop(bodyOf(oldFrame.hex));
            const act = (fsx.find((x) => x.f === 3) || {}).v;
            const st0 = milkTea.__testing.parseMainState(Buffer.from(act));
            check('旧抓包 workFlag = 0(未受雇)', st0.workFlag === 0 && st0.employed === false, st0.workFlag);
        }
    }

    section('4f. 我的工作信息(雇主/工资/特长) —— 从刷新(63)结果解析');
    {
        const mg4 = require(`${SB}/src/services/mengchong`);
        const bodyOf2 = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);
        const frames = loadFrames(path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261016-080455_互动新.jsonl'));
        let resHex = '';
        for (const f of frames) {
            const fsx = mg4.parseTop(bodyOf2(f.hex));
            if (Number((fsx.find((x) => x.f === 1) || {}).v) !== 2026110101) continue;
            if (Number((fsx.find((x) => x.f === 2) || {}).v) !== 63) continue;
            const res = fsx.find((x) => x.f === 168);
            // 注意: parseTop 里 wire=2 字段的字节放在 .v(不是 .raw)
            if (res && res.w === 2 && res.v) { resHex = Buffer.from(res.v).toString('hex'); break; }
        }
        check('抓到 cmd=63 的结果帧', !!resHex);
        const work = milkTea.parseWorkFromRefresh(resHex);
        check('当前雇主 = 1244632861 南桉', work.employer && work.employer.gid === 1244632861 && work.employer.name === '南桉', work.employer);
        check('我的特长 = 9001 金牌销售', work.titleId === 9001 && work.titleName === '金牌销售', [work.titleId, work.titleName]);
        check('本班工资 = 40', work.wage === 40, work.wage);
        check('含兼职历史记录(哈哈)', work.records.some((r) => r.name === '哈哈'), work.records.slice(0, 3));
        check('互动目标 gid 与 cmd=65 传参一致(1244632861)', work.employer.gid === 1244632861, work.employer.gid);
        check('班次起止时间已解析(#6 开始 < #7 结束)', work.startAt > 0 && work.endAt > work.startAt, [work.startAt, work.endAt]);
        // 这份抓包是 08:04 的班次(剩余 31 分钟) → 现在早已结束 → active 必须为 false
        // (这正是"本班工作已结束"误报的防线: 无进行中班次时不得回退历史记录去互动)
        check('班次已过期 → active = false(不再拿旧老板去互动)', work.active === false, { endAt: work.endAt, active: work.active });
        check('互动前没有 #12(次数未用) → interactTotal = 0', work.interactTotal === 0, work.interactTotal);
    }

    section('4g. 日志文案要短(雇佣报错不再刷一长串)');
    {
        const se = milkTea.__testing.shortErr;
        const raw = 'gamepb.activitypb.ActivityService.Operate 错误: code=1034140 该雇佣位已有员工在工作';
        const short = se(raw);
        check('去掉 gamepb 前缀, 保留 code 与原因', short === 'code=1034140 该雇佣位已有员工在工作', short);
        check('长度受控(<=40)', short.length <= 40, short.length);
        check('超长会截断加省略号', se('x'.repeat(80)).endsWith('…'), se('x'.repeat(80)).slice(-6));
    }

    section('4h. 最新互动验证包(09:04): 当前老板=哈哈, 班次进行中, 类型1=宣传推广');
    {
        const mg5 = require(`${SB}/src/services/mengchong`);
        const bodyOf3 = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);
        const frames = loadFrames(path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261016-090422_互动验证.jsonl'));
        // 该包里有多次 63(互动前后各一次) → 取**最后**一帧(互动后, 应带 #12 次数)
        let resHex = '';
        for (const f of frames) {
            const fsx = mg5.parseTop(bodyOf3(f.hex));
            if (Number((fsx.find((x) => x.f === 1) || {}).v) !== 2026110101) continue;
            if (Number((fsx.find((x) => x.f === 2) || {}).v) !== 63) continue;
            const res = fsx.find((x) => x.f === 168);
            if (res && res.w === 2 && res.v) resHex = Buffer.from(res.v).toString('hex');
        }
        check('取到最后一次刷新(互动后)', !!resHex);
        const work = milkTea.parseWorkFromRefresh(resHex);
        check('当前老板 = 1253397809 哈哈(会随班次变化)', work.employer && work.employer.gid === 1253397809 && work.employer.name === '哈哈', work.employer);
        check('该班次进行中(未到结束时间)', work.active === true, { endAt: work.endAt, active: work.active });
        check('互动后 #12={已用1,总数1} → 本班不可再互动', work.interactUsed === 1 && work.interactTotal === 1 && work.canInteract === false, { used: work.interactUsed, total: work.interactTotal, can: work.canInteract });
        const opts = milkTea.WORK_INTERACT_OPTIONS;
        check('互动事项 5 项, 1=宣传推广', opts.length === 5 && opts[0].id === 1 && opts[0].name === '宣传推广', opts.map((x) => x.name));
    }

    section('4i. 无当前兼职的号(#168 只有特长, 无 #1) → 必须判为不可互动');
    {
        // 手工构造 #168 = {#3: 9001(varint), #4: '金牌销售'(string)} —— 即"没有本次兼职/老板"
        const enc = milkTea.__testing.encodeVarint;
        const title = Buffer.from('金牌销售', 'utf8');
        const payload = Buffer.concat([
            Buffer.from([0x18]), enc(9001),
            Buffer.from([0x22, title.length]), title,
        ]).toString('hex');
        const work = milkTea.parseWorkFromRefresh(payload);
        check('没有老板', !work.employer, work.employer);
        check('不是进行中的班次', work.active === false, work.active);
        check('不可互动', work.canInteract === false, work.canInteract);
        check('仍能读出我的特长', work.titleId === 9001 && work.titleName === '金牌销售', [work.titleId, work.titleName]);
    }

    section('4k. 营业记录(cmd=55 + 菜单名 cmd=58) 回放解析');
    {
        const CAP = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20261016-093736_互动验证1.jsonl');
        const all = loadFrames(CAP);
        const mg7 = require(`${SB}/src/services/mengchong`);
        const bodyOf5 = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);
        // 找同一批里的第一条 55 与第一条 58(该 jsonl 是多次采集拼接, 按文件顺序取即可)
        let f55 = '';
        let f58 = '';
        let f63 = '';
        for (const f of all) {
            const fsx = mg7.parseTop(bodyOf5(f.hex));
            if (Number((fsx.find((x) => x.f === 1) || {}).v) !== 2026110101) continue;
            const c = Number((fsx.find((x) => x.f === 2) || {}).v);
            if (c === 55 && !f55) f55 = f.hex;
            if (c === 58 && !f58) f58 = f.hex;
            // 63 要挑"带雇员记录(#168.#2)"的那一帧
            if (c === 63 && !f63) {
                const res = fsx.find((x) => x.f === 168);
                if (res && res.w === 2 && res.v) {
                    const inner = mg7.parseTop(Buffer.from(res.v));
                    const box = inner.find((x) => x.f === 1);
                    if (box && box.w === 2) f63 = f.hex;
                }
            }
            if (f55 && f58 && f63) break;
        }
        check('抓到 55 / 58 / 63 帧', !!f55 && !!f58 && !!f63);
        const saved = sendStub;
        sendStub = async (service, method, body) => {
            const fsx = mg7.parseTop(Buffer.from(body));
            const cmd = Number((fsx.find((x) => x.f === 2) || {}).v) || 0;
            // 63=刷新(雇员记录来源) / 58=菜单名 / 55=收银台详情
            return { body: bodyOf5(cmd === 63 ? f63 : (cmd === 58 ? f58 : f55)) };
        };
        const sales = await milkTea.getSalesRecords();
        sendStub = saved;
        check('营业记录解析成功', sales.ok === true, sales.reason || sales.ok);
        check('累计营业额 > 0', sales.value > 0, sales.value);
        check('累计杯数 > 0', sales.cups > 0, sales.cups);
        check('有分品类记录且带名字', sales.items.length > 0 && sales.items.every((x) => x.name && !/^品类\d+$/.test(x.name) || x.name), sales.items.slice(0, 3));
        check('余额含奶茶券/金币(=游戏"营业收益")', sales.balances.length > 0, sales.balances);
        check('各品类杯数(#20)带菜单名', Array.isArray(sales.cupsByItem) && sales.cupsByItem.every((x) => x.name && x.cups >= 0), sales.cupsByItem.slice(0, 3));
        check('雇员记录(来自刷新 #168.#2)存在且含时长/工资字段',
            Array.isArray(sales.records) && sales.records.length > 0 && 'hours' in sales.records[0] && 'wage' in sales.records[0],
            sales.records.slice(0, 2));
    }

    section('5. 任务列表');
    {
        const t = await milkTea.getTasks();
        check('读到任务', t.ok === true && Array.isArray(t.tasks), t.tasks && t.tasks.length);
        check('任务数 ≥ 2', (t.tasks || []).length >= 2, (t.tasks || []).length);
        const first = (t.tasks || [])[0];
        check('首个任务有奖励', first && first.rewards.length > 0, first);
        check('任务状态字段存在', first && typeof first.status === 'number', first && first.status);
    }

    finish();
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
