/**
 * 奶茶热销中协议回归测试
 *
 * 用例使用合成 Operate 帧，不依赖 wx-code-grabber/captures，
 * 防止测试因为旧抓包或已废弃字段而误通过。
 *
 * 运行: node core/test/test-milk-tea.js
 */
const Long = require('long');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'milk-tea-test';
isolateDataDir(SB, 'milk-tea-test');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';
const GROUP_MAIN = 2026110101;

/**
 * mengchong 在 require 时会解构 network.sendMsgAsync，因此必须先安装转发桩，
 * 再加载 mengchong/milk-tea。
 */
const network = require(`${SB}/src/utils/network`);
let sendImpl = async () => {
    throw new Error('测试未设置网络应答');
};
network.sendMsgAsync = (...args) => sendImpl(...args);

const mg = require(`${SB}/src/services/mengchong`);
const milkTea = require(`${SB}/src/services/milk-tea`);
const warehouse = require(`${SB}/src/services/warehouse`);
const { toInt } = require(`${SB}/src/utils/utils`);

function encodeVarint(value) {
    let n = BigInt(value);
    if (n < 0n) throw new Error('测试编码器不支持负数');
    const out = [];
    do {
        let byte = Number(n & 0x7fn);
        n >>= 7n;
        if (n > 0n) byte |= 0x80;
        out.push(byte);
    } while (n > 0n);
    return Buffer.from(out);
}

function varintField(field, value) {
    return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

function bytesField(field, value) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
    return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(data.length), data]);
}

/** 合成主活动体: #1 活动头 / #121.#1 店铺状态。 */
function mainActivity(state = null) {
    const fields = [bytesField(1, varintField(1, GROUP_MAIN))];
    if (state) fields.push(bytesField(121, bytesField(1, state)));
    return Buffer.concat(fields);
}

/** 合成 ActivityService.List 根组: 根 #1 → repeated #2 活动体。 */
function activityListReply(activities = [mainActivity()]) {
    return bytesField(1, Buffer.concat(activities.map((activity) => bytesField(2, activity))));
}

/** 合成 ActivityService.Operate 响应体。 */
function operateReply(cmd, {
    group = GROUP_MAIN,
    errorCode = 0,
    activity = null,
    result = null,
    resultField = cmd + 105,
} = {}) {
    const fields = [
        varintField(1, group),
        varintField(2, cmd),
    ];
    if (activity) fields.push(bytesField(3, activity));
    if (errorCode) fields.push(varintField(6, errorCode));
    if (result !== null && resultField > 100) fields.push(bytesField(resultField, result));
    return Buffer.concat(fields);
}

function parseOperateRequest(body) {
    const fields = mg.parseTop(Buffer.from(body));
    const group = toInt((fields.find((x) => x.f === 1) || {}).v);
    const cmd = toInt((fields.find((x) => x.f === 2) || {}).v);
    const payload = fields.find((x) => x.f > 100 && x.w === 2) || null;
    return { group, cmd, payloadField: payload && payload.f, payload: payload && Buffer.from(payload.v), fields };
}

function parsePackedVarints(buf) {
    const out = [];
    let value = 0n;
    let shift = 0n;
    for (const byte of Buffer.from(buf || [])) {
        value |= BigInt(byte & 0x7f) << shift;
        if (byte & 0x80) {
            shift += 7n;
        } else {
            out.push(Number(value));
            value = 0n;
            shift = 0n;
        }
    }
    if (shift !== 0n) throw new Error('packed varint 被截断');
    return out;
}

function readVarint(buf, offset = 0) {
    let value = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buf.length) {
        const byte = buf[pos++];
        value |= BigInt(byte & 0x7f) << shift;
        if (!(byte & 0x80)) return { value, offset: pos };
        shift += 7n;
    }
    throw new Error('varint 被截断');
}

function craftResult(uids) {
    return Buffer.concat((uids || []).map((uid, i) => bytesField(3, Buffer.concat([
        varintField(1, 50001 + i),
        varintField(2, 1),
    ]))));
}

function menuResult(recipes) {
    return Buffer.concat((recipes || []).map((recipe) => {
        const fields = [
            varintField(1, recipe.id),
            bytesField(2, recipe.name || `品类${recipe.id}`),
        ];
        if (recipe.unlocked) fields.push(varintField(3, 1));
        fields.push(
            varintField(4, recipe.field4 || 0),
            varintField(5, recipe.productId || 0),
            varintField(6, recipe.price || 0),
        );
        if (recipe.field7 !== undefined) fields.push(varintField(7, recipe.field7));
        return bytesField(1, Buffer.concat(fields));
    }));
}

function itemEntries(fieldNo, entries) {
    return Buffer.concat((entries || []).map((entry) => bytesField(fieldNo, Buffer.concat([
        varintField(1, entry.id),
        varintField(2, entry.count),
    ]))));
}

function cashierEmployee({
    friend = false,
    shiftUid,
    gid,
    name,
    level = 1,
    startAt,
    endAt,
    wage,
    titleId,
    titleName,
} = {}) {
    const fields = [];
    if (friend) fields.push(varintField(1, 1));
    fields.push(
        varintField(3, shiftUid),
        varintField(4, startAt),
        varintField(5, endAt),
        varintField(6, wage),
        varintField(7, titleId),
        bytesField(8, titleName),
        bytesField(11, Buffer.concat([
            varintField(1, gid),
            bytesField(2, name),
            varintField(4, level),
        ])),
    );
    return bytesField(9, Buffer.concat(fields));
}

function cashierDetailResult({
    level = 3,
    revenue = 33706,
    nextLevelRevenue = 53000,
    capacity = 172800,
    todayCups = 50,
    pending = [],
    total = [],
    todaySales = [],
    totalSales = [],
    employees = [],
} = {}) {
    const fields = [
        varintField(1, level),
        varintField(2, revenue),
        varintField(3, nextLevelRevenue),
        varintField(4, capacity),
        varintField(22, todayCups),
        varintField(24, todayCups),
    ];
    if (pending.length) fields.push(itemEntries(19, pending));
    if (total.length) fields.push(itemEntries(23, total));
    for (const sale of todaySales) {
        fields.push(bytesField(10, Buffer.concat([
            varintField(1, sale.id),
            varintField(2, sale.cups),
        ])));
    }
    for (const sale of totalSales) {
        fields.push(bytesField(25, Buffer.concat([
            varintField(1, sale.id),
            varintField(2, sale.cups),
        ])));
    }
    fields.push(...employees);
    return bytesField(1, Buffer.concat(fields));
}

function rankingResult({
    myRank = 0,
    serverTime = 1792288328,
    currentPage = 1,
    hasNext = false,
    entries = [],
} = {}) {
    const fields = [];
    for (const entry of entries) {
        const profile = [
            varintField(1, entry.gid),
            bytesField(2, entry.nickname || ''),
            varintField(4, entry.playerLevel || 0),
        ];
        const item = [
            bytesField(1, Buffer.concat(profile)),
            bytesField(2, entry.storeName || ''),
            varintField(3, entry.storeLevel || 0),
            varintField(4, entry.revenue || 0),
            varintField(5, entry.rank),
        ];
        if (entry.isFriend) item.push(varintField(6, 1));
        fields.push(bytesField(1, Buffer.concat(item)));
    }
    fields.push(
        varintField(2, myRank),
        varintField(3, serverTime),
        varintField(4, currentPage),
        varintField(5, hasNext ? 1 : 0),
    );
    return Buffer.concat(fields);
}

function workRefreshResult({
    employerGid = 0,
    employerName = '',
    startAt = 1792200000,
    wage = 40,
    interactionStatus = 0,
    lastInteraction = null,
    historyRecord = null,
    titleId = 9001,
    titleName = '金牌销售',
} = {}) {
    const current = [];
    if (employerGid) {
        current.push(bytesField(1, Buffer.concat([
            varintField(1, employerGid),
            bytesField(2, employerName),
        ])));
    }
    if (startAt) current.push(varintField(6, startAt), varintField(7, startAt + 3600), varintField(11, wage));
    if (interactionStatus) current.push(varintField(9, interactionStatus));
    if (lastInteraction) {
        current.push(bytesField(12, Buffer.concat([
            varintField(1, lastInteraction.type),
            varintField(2, lastInteraction.count),
            varintField(3, lastInteraction.titleId || 0),
            varintField(4, lastInteraction.at || 0),
        ])));
    }
    const top = [];
    if (current.length) top.push(bytesField(1, Buffer.concat(current)));
    if (historyRecord) {
        const record = [
            bytesField(1, Buffer.concat([
                varintField(1, historyRecord.gid || 0),
                bytesField(2, historyRecord.name || ''),
            ])),
            varintField(4, historyRecord.startAt || 0),
            varintField(5, historyRecord.endAt || 0),
            varintField(6, historyRecord.duration || 0),
        ];
        if (historyRecord.field7) record.push(bytesField(7, historyRecord.field7));
        if (historyRecord.field10) record.push(bytesField(10, historyRecord.field10));
        top.push(bytesField(2, Buffer.concat(record)));
    }
    top.push(varintField(3, titleId), bytesField(4, titleName));
    return Buffer.concat(top);
}

const sent = [];
let router = async () => {
    throw new Error('测试未设置网络应答');
};
sendImpl = async (service, method, body) => {
    if (service !== ACTIVITY_SERVICE) {
        throw new Error(`未预期的网络调用: ${service}.${method}`);
    }
    if (method === 'List') {
        const req = { service, method, body: Buffer.from(body || []) };
        sent.push(req);
        return { body: await router(req) };
    }
    if (method !== 'Operate') throw new Error(`未预期的网络调用: ${service}.${method}`);
    const req = parseOperateRequest(body);
    sent.push(req);
    return { body: await router(req) };
};

(async () => {
    section('1. 协议命令映射');
    {
        check('cmd55 = 收银台详情', milkTea.CMD_CASHIER_DETAIL === 55);
        check('cmd56 = 员工面板', milkTea.CMD_EMPLOYEES === 56);
        check('cmd58 = 配方菜单', milkTea.CMD_MENU === 58);
        check('cmd59 = 领取收银台收益', milkTea.CMD_CLAIM_CASHIER === 59);
        check('cmd62 = 制作奶茶', milkTea.__testing.mainOperateCraft instanceof Function);
        check('cmd63 = 刷新/查询', milkTea.CMD_REFRESH === 63);
        check('cmd64 = 领取工资', milkTea.CMD_CLAIM_WAGE === 64);
        check('cmd65 = 互动', milkTea.CMD_WORK_INTERACT === 65);
        check('cmd66 = 好友店铺排行', milkTea.CMD_RANKING === 66);
        check('cmd67 = 营业记录/班次', milkTea.CMD_SALES_RECORD === 67 && milkTea.CMD_SHIFT === 67);
    }

    section('2. 员工面板使用 selector 请求并保留未闭环字段');
    {
        const result = Buffer.concat([
            varintField(1, 3),
            varintField(2, 270),
            varintField(3, 43201),
        ]);
        router = async (req) => {
            if (req.cmd === 56) return operateReply(56, { result, resultField: 161 });
            throw new Error(`员工面板用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const r = await milkTea.__testing.getEmployees();
        const req = sent.find((x) => x.cmd === 56);
        const payload = req && mg.parseTop(req.payload);
        const selector = payload && payload.find((x) => x.f === 1);
        check('员工面板发送 cmd56/#161', req && req.payloadField === 161, req && req.payloadField);
        check('普通员工列表请求 #161.#1=1', payload && payload.length === 1
            && selector && selector.w === 0 && toInt(selector.v) === 1, payload);
        check('响应 selector 与 field2/field3 按原始字段返回',
            r.ok === true && r.selector === 3 && r.field2 === 270 && r.field3 === 43201, r);
        check('不再把 selector 命名为员工数或工资',
            !Object.prototype.hasOwnProperty.call(r, 'count')
            && !Object.prototype.hasOwnProperty.call(r, 'wage'), r);
    }

    section('3. uint64 与刷新工作信息');
    {
        const unsigned = '18446744073709551596'; // 2^64 - 20
        check('toInt(uint64 字符串) 归一化为 int64', toInt(unsigned) === -20, toInt(unsigned));
        check('toInt(Long) 归一化为 int64', toInt(Long.fromString(unsigned, true)) === -20);
        check('toInt(bigint) 归一化为 int64', toInt(18446744073709551596n) === -20);

        const work = milkTea.__testing.parseWorkFromRefresh(workRefreshResult({
            employerGid: 1253397809,
            employerName: '哈哈',
            interactionStatus: 1,
            lastInteraction: { type: 2, count: 1, titleId: 90002, at: 1792223221 },
        }).toString('hex'));
        check('刷新 #168.#1 解析当前雇主', work.employer && work.employer.gid === 1253397809 && work.employer.name === '哈哈', work.employer);
        check('刷新 #168.#12 解析为最近互动记录',
            work.lastInteraction && work.lastInteraction.type === 2 && work.lastInteraction.count === 1
            && work.lastInteraction.titleId === 90002 && work.lastInteraction.at === 1792223221,
            work.lastInteraction);
        check('#12 不再产生互动配额字段',
            !Object.prototype.hasOwnProperty.call(work, 'interactTotal')
            && !Object.prototype.hasOwnProperty.call(work, 'interactUsed')
            && !Object.prototype.hasOwnProperty.call(work, 'canInteract'));
        check('刷新 #168.#1.#12 识别本班互动已完成',
            work.interactionStatus === 1 && work.interactionCompleted === true, work);

        const statusOnly1 = milkTea.__testing.parseWorkFromRefresh(workRefreshResult({
            employerGid: 1253397809,
            interactionStatus: 1,
        }).toString('hex'));
        check('#9=1 但没有 #12 不能单独判定本班已互动',
            statusOnly1.interactionStatus === 1 && statusOnly1.interactionCompleted === false, statusOnly1);

        const statusOnly2 = milkTea.__testing.parseWorkFromRefresh(workRefreshResult({
            employerGid: 1253397809,
            interactionStatus: 2,
        }).toString('hex'));
        check('当前班次 #9=2 但没有 #12 仍不能判定已互动',
            statusOnly2.interactionStatus === 2 && statusOnly2.interactionCompleted === false, statusOnly2);

        const recordOnly = milkTea.__testing.parseWorkFromRefresh(workRefreshResult({
            employerGid: 1253397809,
            interactionStatus: 0,
            lastInteraction: { type: 2, count: 1, titleId: 90002, at: 1792223221 },
        }).toString('hex'));
        check('#12 是当前已确认的互动完成标志',
            recordOnly.interactionStatus === 0 && recordOnly.interactionCompleted === true, recordOnly);

        const notInteracted = milkTea.__testing.parseWorkFromRefresh(workRefreshResult({
            employerGid: 1253397809,
        }).toString('hex'));
        check('本班互动前 #9=0 且无 #12 时仍可互动',
            notInteracted.interactionStatus === 0 && notInteracted.interactionCompleted === false, notInteracted);

        const noEmployer = milkTea.__testing.parseWorkFromRefresh(workRefreshResult({ employerGid: 0 }).toString('hex'));
        check('没有当前雇主时 employer=null', noEmployer.employer === null);
        check('没有当前雇主时 active=false', noEmployer.active === false);
        check('仍可解析我的特长', noEmployer.titleId === 9001 && noEmployer.titleName === '金牌销售', [noEmployer.titleId, noEmployer.titleName]);

        const nestedField7 = Buffer.concat([varintField(1, 80), varintField(2, 120)]);
        const historical = milkTea.__testing.parseWorkFromRefresh(workRefreshResult({
            historyRecord: {
                gid: 1668981077,
                name: '南桉',
                startAt: 1792190000,
                endAt: 1792193600,
                duration: 3600,
                field7: Buffer.concat([varintField(1, 40), varintField(2, 40)]),
                field10: Buffer.concat([varintField(1, 2), bytesField(7, nestedField7)]),
            },
        }).toString('hex'));
        const history = historical.records[0];
        check('刷新历史 #7 保留原始字段',
            history && history.historyField7.field1 === 40 && history.historyField7.field2 === 40, history);
        check('刷新历史 #10 保留原始字段',
            history && history.historyField10.field1 === 2
            && history.historyField10.field7 === nestedField7.toString('hex'), history);
        check('刷新历史工作时长保留真实秒数',
            history && history.workSeconds === 3600
            && !Object.prototype.hasOwnProperty.call(history, 'hours'), history);
        check('刷新历史不再产生未证实工资/互动字段',
            history && !Object.prototype.hasOwnProperty.call(history, 'wage')
            && !Object.prototype.hasOwnProperty.call(history, 'interactType')
            && !Object.prototype.hasOwnProperty.call(history, 'interactBonus'), history);
    }

    section('4. 营业记录使用 cmd67/#172');
    {
        const day = 1792166400;
        const sales = Buffer.concat([
            varintField(1, day),
            varintField(2, 123),
            varintField(3, 456),
            varintField(4, 577),
            bytesField(5, Buffer.concat([varintField(1, 10), varintField(2, 577)])),
            bytesField(6, Buffer.concat([varintField(1, 2), varintField(2, 290)])),
            bytesField(6, Buffer.concat([varintField(1, 0), varintField(2, 287)])),
            bytesField(7, Buffer.concat([
                bytesField(1, Buffer.concat([
                    varintField(1, 1253397809),
                    bytesField(2, '哈哈'),
                ])),
                varintField(2, day + 3600),
                varintField(3, 5400),
                varintField(8, 9001),
                bytesField(9, '金牌销售'),
                bytesField(10, Buffer.concat([varintField(1, 40), varintField(2, 40)])),
            ])),
            bytesField(8, Buffer.concat([varintField(1, 1001), varintField(2, 456)])),
            bytesField(8, Buffer.concat([varintField(1, 1041), varintField(2, 123)])),
            bytesField(8, Buffer.concat([varintField(1, 1042), varintField(2, 2)])),
            bytesField(8, Buffer.concat([varintField(1, 80011), varintField(2, 10)])),
        ]);
        const menu = menuResult([{
            id: 10,
            name: '普通奶茶',
            unlocked: true,
            field4: 12,
            productId: 50010,
            price: 18,
            field7: 7,
        }]);
        router = async (req) => {
            if (req.method === 'List') return activityListReply();
            if (req.cmd === 67) return operateReply(67, { result: sales, resultField: 172 });
            if (req.cmd === 58) return operateReply(58, { result: menu, resultField: 163 });
            throw new Error(`营业记录用例收到 ${req.method || `cmd=${req.cmd}`}`);
        };

        sent.length = 0;
        const r = await milkTea.__testing.getSalesRecords(day);
        const req = sent.find((x) => x.cmd === 67);
        const payload = req && mg.parseTop(req.payload);
        check('营业记录发送 cmd67', !!req);
        check('营业记录 payload 字段为 #172', req && req.payloadField === 172, req && req.payloadField);
        check('北京时间当日 00:00 正确写入 #172.#1', toInt((payload && payload.find((x) => x.f === 1) || {}).v) === day);
        check('营业记录解析成功', r.ok === true, r);
        check('收益/杯数解析正确', r.coupon === 123 && r.gold === 456 && r.cups === 577, r);
        check('#6 分时销量按相对小时升序解析',
            r.hourly.length === 2
            && r.hourly[0].hoursAgo === 0 && r.hourly[0].cups === 287
            && r.hourly[1].hoursAgo === 2 && r.hourly[1].cups === 290, r.hourly);
        check('#6 不虚构未返回的零销量小时', r.hourly.length === 2, r.hourly);
        check('本小时杯数取 #6 中 hoursAgo=0', r.currentHourCups === 287, r.currentHourCups);
        check('品类名称由 cmd58 菜单补齐', r.items.length === 1 && r.items[0].name === '普通奶茶', r.items);
        check('金币和奶茶券不从 #8 重复计入附加奖励',
            r.rewards.length === 2 && r.rewards.every((x) => x.id !== 1001 && x.id !== 1041), r.rewards);
        check('雇员工作时长保留真实秒数',
            r.records.length === 1 && r.records[0].workSeconds === 5400
            && !Object.prototype.hasOwnProperty.call(r.records[0], 'hours'), r.records[0]);
        check('雇员记录 #10 保留原始字段',
            r.records.length === 1 && r.records[0].historyField10.field1 === 40
            && r.records[0].historyField10.field2 === 40, r.records);
        check('雇员记录不再输出未证实工资/销量',
            r.records.length === 1 && !Object.prototype.hasOwnProperty.call(r.records[0], 'wage')
            && !Object.prototype.hasOwnProperty.call(r.records[0], 'soldCups'), r.records[0]);
        const recipes = await milkTea.__testing.getMenuRecipes();
        check('cmd58 结构化解析配方字段与解锁状态',
            recipes.length === 1 && recipes[0].id === 10 && recipes[0].name === '普通奶茶'
            && recipes[0].unlocked === true && recipes[0].field4 === 12
            && recipes[0].productId === 50010 && recipes[0].price === 18 && recipes[0].field7 === 7,
            recipes);
        milkTea.__testing.clearMenuCache();
    }

    section('5. 制作奶茶 cmd62/#167');
    {
        const uids = [
            54428, 54535, 54536, 54537, 54501,
            54492, 54500, 54483, 54490, 54491,
            54493, 54494, 54495, 54496, 54497,
        ];
        router = async (req) => {
            if (req.cmd !== 62) throw new Error(`制作用例收到 cmd=${req.cmd}`);
            const payload = mg.parseTop(req.payload);
            const packed = (payload.find((x) => x.f === 1) || {}).v;
            return operateReply(62, { result: craftResult(parsePackedVarints(packed)), resultField: 167 });
        };

        sent.length = 0;
        const r = await milkTea.__testing.mainOperateCraft(uids);
        const req = sent.find((x) => x.cmd === 62);
        const payload = req && mg.parseTop(req.payload);
        const packed = payload && (payload.find((x) => x.f === 1) || {}).v;
        check('制作请求只发一次 cmd62', sent.filter((x) => x.cmd === 62).length === 1, sent.map((x) => x.cmd));
        check('制作 payload 字段为 #167', req && req.payloadField === 167, req && req.payloadField);
        check('十五个果实 UID 完整打包', packed && parsePackedVarints(packed).join(',') === uids.join(','), packed && Array.from(packed));
        check('制作结果解析十五条产出', r.ok === true && r.made.length === 15, r.made && r.made.length);
    }

    section('6. 制作参数防跑飞');
    {
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        warehouse.getBag = async () => ({});
        warehouse.getBagItems = () => [{ id: 40525, uid: 60001, count: 2 }];
        milkTea.__testing.clearMenuCache();
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd !== 62) throw new Error(`防跑飞用例收到 cmd=${req.cmd}`);
            const payload = mg.parseTop(req.payload);
            const packed = (payload.find((x) => x.f === 1) || {}).v;
            return operateReply(62, { result: craftResult(parsePackedVarints(packed)), resultField: 167 });
        };

        const zero = await milkTea.__testing.craftAllFruits(0, 1);
        const negative = await milkTea.__testing.craftAllFruits(-5, -1);
        check('perBatch=0 时仍只处理有效批次', zero.ok === true && zero.batches === 1 && zero.used === 1, zero);
        check('perBatch/maxBatches 为负数时仍能在有限批次结束',
            negative.ok === true && negative.batches === 1 && negative.used === 1, negative);
        check('配方菜单只查询一次并复用缓存', sent.filter((x) => x.cmd === 58).length === 1, sent.map((x) => x.cmd));
        warehouse.getBag = originalGetBag;
        warehouse.getBagItems = originalGetBagItems;
        milkTea.__testing.clearMenuCache();
    }

    section('7. 主店状态与互动协议');
    {
        milkTea.__testing.clearMainStatusCache();
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '测试奶茶铺'),
            varintField(4, 3),
            varintField(5, 45678),
            varintField(16, 1792203600),
        ]);
        router = async (req) => {
            if (req.method === 'List') return activityListReply([mainActivity(state)]);
            throw new Error(`主店状态用例不应发送 ${req.method || `cmd=${req.cmd}`}`);
        };

        sent.length = 0;
        const main = await milkTea.getMainStatus(true);
        check('主店状态只调用 ActivityService.List', sent.length === 1 && sent[0].method === 'List', sent.map((x) => x.method || x.cmd));
        check('主店状态不再调用 cmd63', !sent.some((x) => x.cmd === 63), sent.map((x) => x.method || x.cmd));
        check('活动列表正确解析店名/等级/累计营业额',
            main.ok === true && main.storeName === '测试奶茶铺'
            && main.storeLevel === 3 && main.value === 45678, main);
    }

    {
        router = async (req) => {
            if (req.cmd === 63) throw new Error('网络连接已断开');
            throw new Error(`cmd63 网络异常用例不应发送 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const failedQuery = await milkTea.getWorkStatus();
        check('cmd63 抛网络异常时返回查询失败而不是未受雇',
            failedQuery.ok === false && failedQuery.hasEmployer === false
            && failedQuery.reason.includes('查询兼职状态失败')
            && failedQuery.reason.includes('网络连接已断开'), failedQuery);
    }

    {
        const noEmployer = workRefreshResult({ employerGid: 0 });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { activity: mainActivity(), result: noEmployer, resultField: 168 });
            throw new Error(`无雇主用例不应发送 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const skipped = await milkTea.__testing.interactWithFriend(2);
        check('没有当前雇主时跳过互动', skipped.ok === false && skipped.skipped === true, skipped);
        check('没有当前雇主时只发送 cmd63', sent.length === 1 && sent[0].cmd === 63, sent.map((x) => x.cmd));
        check('没有当前雇主时绝不发送 cmd65', !sent.some((x) => x.cmd === 65), sent.map((x) => x.cmd));

        const liveGid = 1253397809;
        const firstShift = 1792410000;
        const nextShift = firstShift + 14400;
        let activeShift = firstShift;
        let completed = false;
        router = async (req) => {
            if (req.cmd === 63) {
                const current = workRefreshResult({
                    employerGid: liveGid,
                    employerName: '哈哈',
                    startAt: activeShift,
                    interactionStatus: completed ? 1 : 0,
                    lastInteraction: completed
                        ? { type: 2, count: 1, titleId: 90002, at: activeShift + 60 }
                        : null,
                });
                return operateReply(63, { activity: mainActivity(), result: current, resultField: 168 });
            }
            if (req.cmd === 65) {
                completed = true;
                const effect7 = Buffer.concat([varintField(1, 1000), varintField(2, 148)]);
                const effect8 = Buffer.concat([varintField(1, 3000), varintField(3, 12)]);
                const result = Buffer.concat([
                    varintField(1, 2),
                    varintField(4, 90002),
                    bytesField(7, effect7),
                    bytesField(8, effect8),
                ]);
                return operateReply(65, { result, resultField: 170 });
            }
            throw new Error(`互动用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const interacted = await milkTea.__testing.interactWithFriend(2);
        const interactReq = sent.find((x) => x.cmd === 65);
        const payload = interactReq && mg.parseTop(interactReq.payload);
        const gidField = payload && payload.find((x) => x.f === 1);
        const typeField = payload && payload.find((x) => x.f === 2);
        check('互动目标来自实时 #168.#1', interacted.ok === true && interacted.friendGid === liveGid, interacted);
        check('互动接口不再接受或返回客户端 GID 修正',
            !Object.prototype.hasOwnProperty.call(interacted, 'correctedGid'), interacted);
        check('cmd65 payload 字段为 #170', interactReq && interactReq.payloadField === 170, interactReq && interactReq.payloadField);
        check('#170 直接包含 #1 当前雇主 GID', gidField && gidField.w === 0 && toInt(gidField.v) === liveGid, gidField);
        check('#170 直接包含 #2 互动类型', typeField && typeField.w === 0 && toInt(typeField.v) === 2, typeField);
        check('#170 没有多余嵌套 #1', payload.length === 2 && payload.filter((x) => x.f === 1).length === 1, payload);
        check('互动结果按刷新工资与 #8.#3 返回工资变化', interacted.interact && interacted.interact.wage
            && interacted.interact.wage.before === 40 && interacted.interact.wage.after === 52
            && interacted.interact.wage.change === 12, interacted.interact);
        check('未确认字段保留原始结构且不命名底薪/加成', interacted.interact
            && interacted.interact.effects.field7[1] === 1000 && interacted.interact.effects.field7[2] === 148
            && interacted.interact.effects.field8[1] === 3000 && interacted.interact.effects.field8[3] === 12
            && !Object.prototype.hasOwnProperty.call(interacted.interact.wage, 'base')
            && !Object.prototype.hasOwnProperty.call(interacted.interact.wage, 'extra'), interacted.interact);
        check('互动成功返回本班已完成状态',
            interacted.interactionCompleted === true && interacted.shiftKey === firstShift, interacted);

        const workAfter = await milkTea.getWorkStatus();
        check('同班次实时状态返回 interactionCompleted=true',
            workAfter.ok === true && workAfter.interactionCompleted === true
            && workAfter.interactionStatus === 1, workAfter);

        const repeated = await milkTea.__testing.interactWithFriend(2);
        check('同班次第二次互动不再发送 cmd65',
            repeated.skipped === true && repeated.interactionCompleted === true
            && sent.filter((x) => x.cmd === 65).length === 1, repeated);

        activeShift = nextShift;
        completed = false;
        const next = await milkTea.__testing.interactWithFriend(2);
        check('班次变化后允许新的本班互动',
            next.ok === true && next.shiftKey === nextShift
            && sent.filter((x) => x.cmd === 65).length === 2, next);
    }

    {
        const interactFailureShift = 1792320000;
        const current = workRefreshResult({
            employerGid: 1253397809,
            startAt: interactFailureShift,
        });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { result: current, resultField: 168 });
            if (req.cmd === 65) throw new Error('网络连接已断开');
            throw new Error(`互动网络异常用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const failed = await milkTea.__testing.interactWithFriend(2);
        check('cmd65 抛网络异常时不能返回互动成功',
            failed.ok === false && failed.interactionCompleted !== true
            && failed.reason.includes('互动失败') && failed.reason.includes('网络连接已断开'), failed);
        const afterFailure = await milkTea.getWorkStatus();
        check('cmd65 抛网络异常时不能写入本班完成兜底',
            afterFailure.interactionCompleted === false, afterFailure);
        check('互动网络异常只发送一次 cmd65',
            sent.filter((x) => x.cmd === 65).length === 1, sent.map((x) => x.cmd));
    }

    {
        const concurrentShift = 1792350000;
        const current = workRefreshResult({
            employerGid: 1253397809,
            startAt: concurrentShift,
            interactionStatus: 0,
            lastInteraction: null,
        });
        let releaseInteract;
        let markInteractStarted;
        const interactGate = new Promise((resolve) => { releaseInteract = resolve; });
        const interactStarted = new Promise((resolve) => { markInteractStarted = resolve; });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { result: current, resultField: 168 });
            if (req.cmd === 65) {
                markInteractStarted();
                await interactGate;
                return operateReply(65, { result: Buffer.alloc(0), resultField: 170 });
            }
            throw new Error(`并发互动用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const first = milkTea.__testing.interactWithFriend(2);
        const duplicate = milkTea.__testing.interactWithFriend(2);
        await interactStarted;
        releaseInteract();
        const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
        check('并发互动只发送一次 cmd65',
            sent.filter((x) => x.cmd === 65).length === 1, sent.map((x) => x.cmd));
        check('并发互动共享同一成功结果',
            firstResult.ok === true && duplicateResult.ok === true
            && firstResult.shiftKey === concurrentShift, [firstResult, duplicateResult]);

        const fallback = await milkTea.getWorkStatus();
        check('互动成功后即使服务端 #168 暂未刷新也立即标记本班已完成',
            fallback.interactionStatus === 0 && fallback.interactionCompleted === true, fallback);
        const repeated = await milkTea.__testing.interactWithFriend(2);
        check('进程内完成兜底可阻止同班再次发送 cmd65',
            repeated.skipped === true && repeated.interactionCompleted === true
            && sent.filter((x) => x.cmd === 65).length === 1, repeated);
    }

    {
        const differentTypeShift = 1792360000;
        const current = workRefreshResult({
            employerGid: 1253397809,
            startAt: differentTypeShift,
        });
        let releaseInteract;
        let markInteractStarted;
        const interactGate = new Promise((resolve) => { releaseInteract = resolve; });
        const interactStarted = new Promise((resolve) => { markInteractStarted = resolve; });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { result: current, resultField: 168 });
            if (req.cmd === 65) {
                markInteractStarted();
                await interactGate;
                return operateReply(65, {
                    result: Buffer.concat([varintField(1, 2), varintField(4, 90002)]),
                    resultField: 170,
                });
            }
            throw new Error(`不同互动类型并发用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const first = milkTea.__testing.interactWithFriend(2);
        const different = milkTea.__testing.interactWithFriend(5);
        await interactStarted;
        releaseInteract();
        const [firstResult, differentResult] = await Promise.all([first, different]);
        check('不同互动类型并发时只提交先到的类型',
            firstResult.ok === true && firstResult.interact && firstResult.interact.type === 2
            && sent.filter((x) => x.cmd === 65).length === 1, [firstResult, sent.map((x) => x.cmd)]);
        check('不同互动类型并发时不会串用前一个请求结果',
            differentResult.ok === false && differentResult.skipped === true
            && differentResult.inFlight === true, differentResult);
    }

    {
        const cooldownShift = 1792300000;
        const current = workRefreshResult({ employerGid: 1253397809, startAt: cooldownShift });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { result: current, resultField: 168 });
            if (req.cmd === 65) return operateReply(65, { errorCode: 1034147 });
            throw new Error(`冷却用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const first = await milkTea.__testing.interactWithFriend(2);
        const second = await milkTea.__testing.interactWithFriend(2);
        check('只有服务端 1034147 才进入本班冷却',
            first.ok === false && first.skipped === true && first.shiftKey === cooldownShift, first);
        check('冷却中仍会实时查询 cmd63 确认当前老板',
            sent.filter((x) => x.cmd === 63).length === 2, sent.map((x) => x.cmd));
        check('冷却中不再发送第二次 cmd65',
            sent.filter((x) => x.cmd === 65).length === 1 && second.skipped === true, sent.map((x) => x.cmd));
    }

    {
        const noEmployer = workRefreshResult({ employerGid: 0 });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { result: noEmployer, resultField: 168 });
            throw new Error(`无老板领工资用例不应发送 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const skipped = await milkTea.claimWage();
        check('无老板时领工资返回 skipped', skipped.ok === false && skipped.skipped === true, skipped);
        check('无老板时只查询 cmd63, 不发送 cmd64',
            sent.length === 1 && sent[0].cmd === 63 && !sent.some((x) => x.cmd === 64), sent.map((x) => x.cmd));

        const current = workRefreshResult({ employerGid: 1253397809, startAt: 1792400000 });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { result: current, resultField: 168 });
            if (req.cmd === 64) {
                const result = bytesField(1, Buffer.concat([varintField(1, 1041), varintField(2, 120)]));
                return operateReply(64, { result, resultField: 169 });
            }
            throw new Error(`领工资用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const wage = await milkTea.claimWage();
        check('领工资前先实时查询 cmd63',
            sent.length === 2 && sent[0].cmd === 63 && sent[1].cmd === 64, sent.map((x) => x.cmd));
        check('领工资成功返回奶茶券数量',
            wage.ok === true && wage.gained && wage.gained.id === 1041 && wage.gained.count === 120, wage);
    }

    {
        const claimFailureShift = 1792330000;
        const current = workRefreshResult({ employerGid: 1253397809, startAt: claimFailureShift });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { result: current, resultField: 168 });
            if (req.cmd === 64) throw new Error('网络连接已断开');
            throw new Error(`领工资网络异常用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const failed = await milkTea.claimWage();
        check('cmd64 抛网络异常时不能返回领工资成功',
            failed.ok === false && !failed.gained
            && failed.reason.includes('领工资失败') && failed.reason.includes('网络连接已断开'), failed);
    }

    {
        const concurrentClaimShift = 1792340000;
        const current = workRefreshResult({ employerGid: 1253397809, startAt: concurrentClaimShift });
        let releaseClaim;
        let markClaimStarted;
        const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
        const claimStarted = new Promise((resolve) => { markClaimStarted = resolve; });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { result: current, resultField: 168 });
            if (req.cmd === 64) {
                markClaimStarted();
                await claimGate;
                const result = bytesField(1, Buffer.concat([varintField(1, 1041), varintField(2, 120)]));
                return operateReply(64, { result, resultField: 169 });
            }
            throw new Error(`并发领工资用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const first = milkTea.claimWage();
        const duplicate = milkTea.claimWage();
        await claimStarted;
        releaseClaim();
        const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
        check('并发领工资只发送一次 cmd63 和 cmd64',
            sent.filter((x) => x.cmd === 63).length === 1
            && sent.filter((x) => x.cmd === 64).length === 1, sent.map((x) => x.cmd));
        check('并发领工资共享同一成功结果',
            firstResult.ok === true && duplicateResult.ok === true
            && firstResult.gained && firstResult.gained.count === 120
            && duplicateResult.gained && duplicateResult.gained.count === 120, [firstResult, duplicateResult]);
    }

    section('8. 宣传喇叭在协议未确认前不发请求');
    {
        sent.length = 0;
        const r = await milkTea.__testing.useSpeaker();
        check('返回 skipped', r.ok === false && r.skipped === true, r);
        check('没有发送任何猜测请求', sent.length === 0, sent.map((x) => x.cmd));
    }

    section('9. 只制作已解锁配方，未解锁配方直接跳过');
    {
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        warehouse.getBag = async () => ({});
        warehouse.getBagItems = () => [
            { id: 40525, uid: 70001, count: 3 },
            { id: 40526, uid: 70002, count: 5 },
        ];
        milkTea.__testing.clearMenuCache();
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([
                        { id: 2, name: '甜莓奶茶', unlocked: true },
                        { id: 3, name: '白桃乌龙', unlocked: false },
                    ]),
                    resultField: 163,
                });
            }
            if (req.cmd !== 62) throw new Error(`部分失败用例收到 cmd=${req.cmd}`);
            const payload = mg.parseTop(req.payload);
            const packed = (payload.find((x) => x.f === 1) || {}).v;
            const uids = parsePackedVarints(packed);
            if (uids.join(',') !== '70001') throw new Error(`未解锁 UID 不应提交: ${uids.join(',')}`);
            return operateReply(62, { result: craftResult(uids), resultField: 167 });
        };

        sent.length = 0;
        const r = await milkTea.__testing.craftAllFruits(2, 1);
        const craftRequests = sent.filter((x) => x.cmd === 62);
        const craftUids = craftRequests.flatMap((request) => {
            const payload = mg.parseTop(request.payload);
            const packed = (payload.find((x) => x.f === 1) || {}).v;
            return parsePackedVarints(packed);
        });
        check('只提交已解锁配方的 UID', craftRequests.length === 1 && craftUids.join(',') === '70001', craftUids);
        check('未解锁 UID 不会进入制作请求', !craftUids.includes(70002), craftUids);
        check('部分可制作时返回成功且不标记失败', r.ok === true && r.partial === false, r);
        check('成功计数按实际 UID 返回', r.used === 1, r.used);
        check('实际投入数量使用背包 count 汇总', r.usedUnits === 3, r.usedUnits);
        check('未解锁配方按果实数量汇总记录', r.skipped === false && r.skippedItems.length === 1
            && r.skippedItems[0].recipeId === 3 && r.skippedItems[0].reason === 'locked'
            && r.skippedItems[0].itemName === '森野白桃' && r.skippedItems[0].count === 5,
        r.skippedItems);
        check('保留成功产出的物品', r.made.length === 1 && r.made[0].count === 1, r.made);
        warehouse.getBag = originalGetBag;
        warehouse.getBagItems = originalGetBagItems;
    }

    section('10. 全部配方未解锁时不发送制作请求');
    {
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        warehouse.getBag = async () => ({});
        warehouse.getBagItems = () => [{ id: 40526, uid: 70003, count: 6 }];
        milkTea.__testing.clearMenuCache();
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([
                        { id: 2, name: '甜莓奶茶', unlocked: true },
                        { id: 3, name: '白桃乌龙', unlocked: false },
                    ]),
                    resultField: 163,
                });
            }
            throw new Error(`全部未解锁时不应发送 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const r = await milkTea.__testing.craftAllFruits(2, 1);
        check('返回跳过而不是制作失败', r.ok === false && r.skipped === true && r.used === 0, r);
        check('没有发送 cmd62', !sent.some((x) => x.cmd === 62), sent.map((x) => x.cmd));
        warehouse.getBag = originalGetBag;
        warehouse.getBagItems = originalGetBagItems;
        milkTea.__testing.clearMenuCache();
    }

    section('11. 收银台详情 cmd55/#160 字段分离与员工身份');
    {
        const nowSec = Math.floor(Date.now() / 1000);
        const friendShiftUid = '30069608145587714';
        const npcShiftUid = '30069573064429059';
        const detailResult = cashierDetailResult({
            pending: [
                { id: 1041, count: 585 },
                { id: 1001, count: 837609 },
            ],
            total: [
                { id: 1041, count: 2250 },
                { id: 1001, count: 2908400 },
            ],
            todaySales: [
                { id: 2, cups: 6794 },
                { id: 9, cups: 46 },
            ],
            totalSales: [
                { id: 2, cups: 8721 },
                { id: 9, cups: 58168 },
            ],
            employees: [
                cashierEmployee({
                    friend: true,
                    shiftUid: friendShiftUid,
                    gid: 1253397809,
                    name: '哈哈🍵',
                    level: 108,
                    startAt: nowSec - 3600,
                    endAt: nowSec + 3600,
                    wage: 40,
                    titleId: 9001,
                    titleName: '金牌销售',
                }),
                cashierEmployee({
                    friend: false,
                    shiftUid: npcShiftUid,
                    gid: 1216569456,
                    name: '不想内卷.',
                    level: 82,
                    startAt: nowSec - 7200,
                    endAt: nowSec - 3600,
                    wage: 40,
                    titleId: 9003,
                    titleName: '金牌服务',
                }),
            ],
        });
        router = async (req) => {
            if (req.cmd === 55) return operateReply(55, { result: detailResult, resultField: 160 });
            throw new Error(`收银台详情用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const detail = await milkTea.__testing.getCashierDetail();
        const req = sent.find((x) => x.cmd === 55);
        check('收银台详情发送 cmd55/#160 空 payload',
            sent.filter((x) => x.cmd === 55).length === 1
            && req.payloadField === 160 && req.payload.length === 0, req);
        check('#4=172800 映射为 referenceValue/field4',
            detail.ok === true && detail.referenceValue === 172800 && detail.field4 === 172800, detail);
        check('#4 不再使用误导性的 capacity 字段',
            !Object.prototype.hasOwnProperty.call(detail, 'capacity'), detail);
        check('#19 只映射待领取 pending',
            Array.isArray(detail.pending) && detail.pending.length === 2
            && detail.pending[0].id === 1041 && detail.pending[0].count === 585
            && detail.pending[1].id === 1001 && detail.pending[1].count === 837609, detail.pending);
        check('#23 只映射长期累计 total',
            Array.isArray(detail.total) && detail.total.length === 2
            && detail.total[0].id === 1041 && detail.total[0].count === 2250
            && detail.total[1].id === 1001 && detail.total[1].count === 2908400, detail.total);
        check('pendingCount 是 #19 条目数而不是收益数量求和', detail.pendingCount === 2, detail.pendingCount);
        check('#22/#24 映射 todayCups', detail.todayCups === 50, detail.todayCups);
        check('#10/#25 分别映射今日与累计品类销量',
            Array.isArray(detail.todaySales) && detail.todaySales.length === 2
            && detail.todaySales[0].cups === 6794
            && Array.isArray(detail.totalSales) && detail.totalSales.length === 2
            && detail.totalSales[1].cups === 58168,
            { todaySales: detail.todaySales, totalSales: detail.totalSales });

        const employees = Array.isArray(detail.employees) ? detail.employees : [];
        const friend = employees.find((x) => x.shiftUid === friendShiftUid);
        const npc = employees.find((x) => x.shiftUid === npcShiftUid);
        check('17 位班次 UID 精确保留为字符串',
            friend && typeof friend.shiftUid === 'string' && friend.shiftUid === friendShiftUid
            && npc && typeof npc.shiftUid === 'string' && npc.shiftUid === npcShiftUid,
            detail.employees);
        check('好友员工由 #9.#1=1 标记为 isFriend',
            friend && friend.isFriend === true && friend.isNpc === false, friend);
        check('缺少 #9.#1 的员工标记为 unknown，不再武断判成 NPC',
            npc && npc.isFriend === false && npc.isNpc === false
            && npc.employeeType === 'unknown', npc);
        check('员工中文与 emoji 昵称按 UTF-8 精确保留',
            friend && friend.name === '哈哈🍵' && npc && npc.name === '不想内卷.',
            employees.map((x) => x.name));
        check('员工 gid/等级/起止时间/工资/特长完整映射',
            friend && friend.gid === 1253397809 && friend.level === 108
            && friend.startAt === nowSec - 3600 && friend.endAt === nowSec + 3600
            && friend.wage === 40 && friend.titleId === 9001 && friend.titleName === '金牌销售',
            friend);
        check('Lv3 收银台返回两名员工容量、全量员工数和在岗数',
            detail.employeeCapacity === 2 && detail.employeeCount === 2
            && detail.currentEmployees.length === 2 && detail.onDutyEmployeeCount === 1,
            {
                employeeCapacity: detail.employeeCapacity,
                employeeCount: detail.employeeCount,
                onDutyEmployeeCount: detail.onDutyEmployeeCount,
            });

        router = async (req) => {
            if (req.cmd === 55) return operateReply(55, { resultField: 160 });
            throw new Error(`无结果体用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const noBody = await milkTea.__testing.getCashierDetail();
        check('cmd55 无结果体时 ok:false', noBody.ok === false, noBody);

        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: bytesField(1, Buffer.from([0x0a, 0x05, 0x08])),
                    resultField: 160,
                });
            }
            throw new Error(`解析异常用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const malformed = await milkTea.__testing.getCashierDetail();
        check('cmd55/#160 解析异常时 ok:false', malformed.ok === false, malformed);
    }

    section('12. 领取收银台收益必须先确认 #19 且网络异常不成功');
    {
        const listOnly = (req) => {
            if (req.method === 'List') return activityListReply();
            return null;
        };
        const pendingDetail = cashierDetailResult({
            pending: [
                { id: 1041, count: 585 },
                { id: 1001, count: 837609 },
            ],
        });
        const claimReply = operateReply(59, {
            result: Buffer.concat([
                bytesField(1, Buffer.concat([varintField(1, 1041), varintField(2, 585)])),
                bytesField(1, Buffer.concat([varintField(1, 1001), varintField(2, 837609)])),
            ]),
            resultField: 164,
        });

        milkTea.__testing.clearMainStatusCache();
        router = async (req) => {
            const list = listOnly(req);
            if (list) return list;
            if (req.cmd === 55) return operateReply(55, { errorCode: 1034149 });
            throw new Error(`查询失败保护用例不应发送 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const queryFailed = await milkTea.claimCashier();
        check('cmd55 业务失败时返回 ok:false/skipped',
            queryFailed.ok === false && queryFailed.skipped === true, queryFailed);
        check('cmd55 业务失败时不发送 cmd59',
            !sent.some((x) => x.cmd === 59), sent.map((x) => x.method || x.cmd));

        milkTea.__testing.clearMainStatusCache();
        router = async (req) => {
            const list = listOnly(req);
            if (list) return list;
            if (req.cmd === 55) throw new Error('网络连接已断开');
            throw new Error(`查询异常保护用例不应发送 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const queryThrown = await milkTea.claimCashier();
        check('cmd55 网络异常时返回 ok:false/skipped',
            queryThrown.ok === false && queryThrown.skipped === true, queryThrown);
        check('cmd55 网络异常时不发送 cmd59',
            !sent.some((x) => x.cmd === 59), sent.map((x) => x.method || x.cmd));

        milkTea.__testing.clearMainStatusCache();
        router = async (req) => {
            const list = listOnly(req);
            if (list) return list;
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ pending: [] }),
                    resultField: 160,
                });
            }
            throw new Error(`无待领取用例不应发送 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const empty = await milkTea.claimCashier();
        check('无 #19 时返回 skipped 而不是成功领取',
            empty.ok === true && empty.skipped === true, empty);
        check('无 #19 时绝不发送 cmd59',
            !sent.some((x) => x.cmd === 59), sent.map((x) => x.method || x.cmd));

        milkTea.__testing.clearMainStatusCache();
        router = async (req) => {
            const list = listOnly(req);
            if (list) return list;
            if (req.cmd === 55) return operateReply(55, { result: pendingDetail, resultField: 160 });
            if (req.cmd === 59) return claimReply;
            throw new Error(`有 #19 用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const claimed = await milkTea.claimCashier();
        check('有 #19 时只发送一次 cmd59',
            sent.filter((x) => x.cmd === 59).length === 1, sent.map((x) => x.method || x.cmd));
        check('有 #19 时成功返回到账明细',
            claimed.ok === true && Array.isArray(claimed.gainedList) && claimed.gainedList.length === 2
            && claimed.gainedList[1].count === 837609, claimed);

        milkTea.__testing.clearMainStatusCache();
        router = async (req) => {
            const list = listOnly(req);
            if (list) return list;
            if (req.cmd === 55) return operateReply(55, { result: pendingDetail, resultField: 160 });
            if (req.cmd === 59) throw new Error('网络连接已断开');
            throw new Error(`领取网络异常用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const claimThrown = await milkTea.claimCashier();
        check('cmd59 网络异常时必须 ok:false',
            claimThrown.ok === false && claimThrown.skipped !== true, claimThrown);
        check('cmd59 网络异常时保留已发送的领取请求',
            sent.filter((x) => x.cmd === 59).length === 1, sent.map((x) => x.method || x.cmd));
    }

    section('13. getOnDutyEmployees(detail) 不重复查询 cmd55');
    {
        const nowSec = Math.floor(Date.now() / 1000);
        const detail = {
            ok: true,
            at: nowSec,
            employees: [
                {
                    shiftUid: '30069608145587714',
                    gid: 1253397809,
                    name: '哈哈🍵',
                    startAt: nowSec - 3600,
                    endAt: nowSec + 3600,
                    isFriend: true,
                    isNpc: false,
                },
                {
                    shiftUid: '30069573064429059',
                    gid: 1216569456,
                    name: '不想内卷.',
                    startAt: nowSec - 7200,
                    endAt: nowSec - 3600,
                    isFriend: false,
                    isNpc: true,
                },
            ],
        };
        router = async (req) => {
            throw new Error(`显式 detail 不应查询 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const explicit = await milkTea.__testing.getOnDutyEmployees(detail);
        check('显式传入 detail 时不发送 cmd55', sent.length === 0, sent.map((x) => x.cmd));
        check('显式 detail 计算在岗剩余秒数和过期状态',
            explicit.ok === true && Array.isArray(explicit.employees) && explicit.employees.length === 2
            && explicit.employees[0].onDuty === true
            && explicit.employees[0].remainSeconds > 0
            && explicit.employees[1].onDuty === false
            && explicit.employees[1].remainSeconds === 0
            && explicit.employeeCount === 2 && explicit.onDutyEmployeeCount === 1, explicit);

        sent.length = 0;
        const nullDetail = await milkTea.__testing.getOnDutyEmployees(null);
        check('显式传 null 时不发送 cmd55', sent.length === 0, sent.map((x) => x.cmd));
        check('显式传 null 时返回空员工列表', Array.isArray(nullDetail.employees)
            && nullDetail.employees.length === 0, nullDetail);

        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({
                        employees: [
                            cashierEmployee({
                                friend: true,
                                shiftUid: '30069608145587714',
                                gid: 1253397809,
                                name: '哈哈🍵',
                                level: 108,
                                startAt: nowSec - 3600,
                                endAt: nowSec + 3600,
                                wage: 40,
                                titleId: 9001,
                                titleName: '金牌销售',
                            }),
                        ],
                    }),
                    resultField: 160,
                });
            }
            throw new Error(`未传 detail 用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const queried = await milkTea.__testing.getOnDutyEmployees();
        check('未传 detail 时只查询一次 cmd55',
            sent.filter((x) => x.cmd === 55).length === 1, sent.map((x) => x.cmd));
        check('未传 detail 时正常返回在岗员工',
            queried.ok === true && Array.isArray(queried.employees) && queried.employees.length === 1
            && queried.employees[0].name === '哈哈🍵'
            && queried.employees[0].onDuty === true, queried);
    }

    section('14. 收银台查询 cmd60/#165 请求与长期累计映射');
    {
        router = async (req) => {
            if (req.cmd === 60) {
                return operateReply(60, {
                    result: Buffer.concat([
                        varintField(1, 50),
                        varintField(2, 2250),
                        varintField(3, 2908400),
                    ]),
                    resultField: 165,
                });
            }
            throw new Error(`cmd60 用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const status = await milkTea.getCashierStatus();
        const req = sent.find((x) => x.cmd === 60);
        const payload = req && mg.parseTop(req.payload);
        check('cmd60/#165 请求 payload 精确为 #1=1',
            req && req.payloadField === 165 && req.payload.toString('hex') === '0801'
            && payload && payload.length === 1 && toInt(payload[0].v) === 1,
            req && { field: req.payloadField, payload: req.payload.toString('hex') });
        check('#165.#1/#2/#3 映射 todayCups/couponTotal/goldTotal',
            status.ok === true && status.todayCups === 50
            && status.couponTotal === 2250 && status.goldTotal === 2908400, status);
        check('cmd60 不再把长期累计误命名为容量/待领取/杯数',
            !Object.prototype.hasOwnProperty.call(status, 'capacity')
            && !Object.prototype.hasOwnProperty.call(status, 'pending')
            && !Object.prototype.hasOwnProperty.call(status, 'cups'), status);
    }

    section('15. 雇佣好友 cmd57/#162 精确字段与非法档位回落');
    {
        const gid = 1253397809;
        router = async (req) => {
            if (req.cmd === 57) return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            throw new Error(`雇佣用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const hired = await milkTea.hireFriend(gid, 1, { skipCapacityCheck: true });
        const req = sent.find((x) => x.cmd === 57);
        const outer = req && mg.parseTop(req.payload);
        const innerBox = outer && outer.find((x) => x.f === 1 && x.w === 2);
        const inner = innerBox && mg.parseTop(innerBox.v);
        check('cmd57 外层只有 #162.#1 嵌套体',
            req && req.payloadField === 162 && outer && outer.length === 1 && inner, outer);
        check('cmd57/#162.#1 精确包含 #1=1/#2=1/#3=gid',
            hired.ok === true && inner.length === 3
            && toInt((inner.find((x) => x.f === 1) || {}).v) === 1
            && toInt((inner.find((x) => x.f === 2) || {}).v) === 1
            && toInt((inner.find((x) => x.f === 3) || {}).v) === gid, inner);

        sent.length = 0;
        const invalid = await milkTea.hireFriend(gid, 99, { skipCapacityCheck: true });
        const invalidReq = sent.find((x) => x.cmd === 57);
        const invalidOuter = invalidReq && mg.parseTop(invalidReq.payload);
        const invalidBox = invalidOuter && invalidOuter.find((x) => x.f === 1 && x.w === 2);
        const invalidInner = invalidBox && mg.parseTop(invalidBox.v);
        check('非法 hireDuration 回落到 #2=1',
            invalid.ok === true
            && toInt((invalidInner.find((x) => x.f === 2) || {}).v) === 1, invalidInner);
    }

    section('16. 三级店铺两个员工位、满员跳过与已下班员工占位');
    {
        const nowSec = Math.floor(Date.now() / 1000);
        const employee = (gid, friend, startAt, endAt) => cashierEmployee({
            friend,
            shiftUid: String(`3006960814558${String(gid).slice(-4)}`),
            gid,
            name: friend ? '好友员工' : '普通员工',
            level: 100,
            startAt,
            endAt,
            wage: 40,
            titleId: 9001,
            titleName: '金牌销售',
        });

        check('三级店铺员工上限为 2，低等级为 1',
            milkTea.__testing.employeeCapacityForLevel(3) === 2
            && milkTea.__testing.employeeCapacityForLevel(2) === 1, {
                level2: milkTea.__testing.employeeCapacityForLevel(2),
                level3: milkTea.__testing.employeeCapacityForLevel(3),
            });

        const fullEmployees = [
            employee(1253397809, true, nowSec - 3600, nowSec + 3600),
            // 已下班员工仍是当前员工，不能因此再开一个雇佣位。
            employee(1216569456, false, nowSec - 7200, nowSec - 3600),
        ];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: fullEmployees }),
                    resultField: 160,
                });
            }
            throw new Error(`满员用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const full = await milkTea.hireAll([1300000001, 1300000002]);
        check('三级店铺已有两名员工时不再发送 cmd57',
            full.ok === true && full.skipped === true && full.employeeCapacity === 2
            && full.employeeCount === 2 && !sent.some((x) => x.cmd === 57), {
                result: full,
                sent: sent.map((x) => x.cmd),
            });

        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            throw new Error(`双空位用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const twoVacancies = await milkTea.autoHire([1300000001, 1300000002], { duration: 1 });
        check('三级店铺有两个空位时自动雇佣连续补满两人',
            twoVacancies.ok === true && twoVacancies.hired === 2
            && Array.isArray(twoVacancies.friendGids) && twoVacancies.friendGids.length === 2
            && sent.filter((x) => x.cmd === 57).length === 2, {
                result: twoVacancies,
                sent: sent.map((x) => x.cmd),
            });

        const oneEmployee = [
            // 普通店员同样占一个员工位，剩下一个空位只能补一名好友。
            employee(1216569456, false, nowSec - 3600, nowSec + 3600),
        ];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: oneEmployee }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            throw new Error(`补位用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const partial = await milkTea.hireAll([1300000001, 1300000002]);
        check('三级店铺只补一个空位且最多发送一次 cmd57',
            partial.ok === true && partial.hired === 1
            && sent.filter((x) => x.cmd === 57).length === 1, {
                result: partial,
                sent: sent.map((x) => x.cmd),
            });

        sent.length = 0;
        const auto = await milkTea.autoHire([1300000003, 1300000004], { duration: 1 });
        check('已有普通店员时自动雇佣只补一名并返回完整员工占位',
            auto.ok === true && auto.hired === 1
            && Array.isArray(auto.friendGids) && auto.friendGids.length === 1
            && auto.initialEmployeeCount === 1 && auto.finalEmployeeCount === 2
            && auto.employeeCount === 2 && auto.employeeCapacity === 2
            && sent.filter((x) => x.cmd === 57).length === 1, {
                result: auto,
                sent: sent.map((x) => x.cmd),
            });
    }

    section('17. cmd62 十五 UID 上限、16 条拆分与多字节 packed 长度');
    {
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        const bagUids = Array.from({ length: 16 }, (_, i) => 71001 + i);
        warehouse.getBag = async () => ({});
        warehouse.getBagItems = () => bagUids.map((uid) => ({ id: 40525, uid, count: 1 }));
        milkTea.__testing.clearMenuCache();
        const batches = [];
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const packed = (payload.find((x) => x.f === 1) || {}).v;
                const uids = parsePackedVarints(packed);
                batches.push(uids);
                return operateReply(62, { result: craftResult(uids), resultField: 167 });
            }
            throw new Error(`批量边界用例收到 cmd=${req.cmd}`);
        };

        const all = await milkTea.__testing.craftAllFruits(16, 10);
        check('perBatch=16 时仍按 15+1 拆分两批',
            batches.length === 2 && batches[0].length === 15 && batches[1].length === 1, batches);
        check('16 个果实全部制作并返回两批',
            all.ok === true && all.used === 16 && all.batches === 2, all);

        sent.length = 0;
        batches.length = 0;
        const single = await milkTea.craftMilkTea(16);
        check('craftMilkTea(16) 单次最多提交 15 个 UID',
            batches.length === 1 && batches[0].length === 15
            && single.ok === true && single.used === 15, { batches, single });

        const longUids = Array.from(
            { length: 15 },
            (_, i) => String(80000000000000000n + BigInt(i)),
        );
        sent.length = 0;
        await milkTea.__testing.mainOperateCraft(longUids);
        const packedReq = sent.find((x) => x.cmd === 62);
        const packedPayload = packedReq && packedReq.payload ? mg.parseTop(packedReq.payload) : [];
        const packed = (packedPayload.find((x) => x.f === 1) || {}).v;
        let tag = null;
        let length = null;
        try {
            tag = packedReq && readVarint(packedReq.payload, 0);
            length = tag && readVarint(packedReq.payload, tag.offset);
        } catch (e) { /* 由下方断言报告 */ }
        check('packed length >=128 时使用标准多字节 varint 长度',
            packed && tag && Number(tag.value) === 0x0a
            && length && Number(length.value) >= 128
            && Number(length.value) === packed.length,
            packed && { hex: packed.toString('hex'), tag, length });

        warehouse.getBag = originalGetBag;
        warehouse.getBagItems = originalGetBagItems;
        milkTea.__testing.clearMenuCache();
    }

    section('18. 店铺排行榜 cmd66/#171 页码、本人排名与好友标记');
    {
        const makeEntries = (startRank, count) => Array.from({ length: count }, (_, i) => {
            const rank = startRank + i;
            return {
                gid: 1200000000 + rank,
                nickname: rank === 29 ? '北栎🍵' : `玩家${rank}`,
                playerLevel: rank === 29 ? 72 : 60,
                storeName: rank === 29 ? '奶茶小铺' : `测试店铺${rank}`,
                storeLevel: rank === 29 ? 3 : 2,
                revenue: rank === 29 ? 33706 : 100000 - rank,
                rank,
                isFriend: rank >= 30,
            };
        });

        router = async (req) => {
            if (req.cmd !== 66) throw new Error(`排行榜用例收到 cmd=${req.cmd}`);
            const payload = mg.parseTop(req.payload || Buffer.alloc(0));
            const page = toInt((payload.find((x) => x.f === 1) || {}).v);
            if (page === 1) {
                return operateReply(66, {
                    result: rankingResult({
                        myRank: 29,
                        currentPage: 1,
                        hasNext: true,
                        entries: makeEntries(1, 20),
                    }),
                    resultField: 171,
                });
            }
            if (page === 2) {
                return operateReply(66, {
                    result: rankingResult({
                        myRank: 29,
                        currentPage: 2,
                        hasNext: true,
                        entries: makeEntries(21, 20),
                    }),
                    resultField: 171,
                });
            }
            if (page === 3) {
                return operateReply(66, {
                    result: rankingResult({
                        myRank: 29,
                        currentPage: 3,
                        hasNext: false,
                        entries: makeEntries(41, 12),
                    }),
                    resultField: 171,
                });
            }
            return operateReply(66, {
                result: rankingResult({ myRank: 29, currentPage: page, hasNext: false }),
                resultField: 171,
            });
        };

        sent.length = 0;
        const page1 = await milkTea.getStoreRankings(1);
        const req1 = sent.find((x) => x.cmd === 66);
        const payload1 = req1 && mg.parseTop(req1.payload || Buffer.alloc(0));
        check('cmd66 使用 #171，请求体只有 #1=页码',
            req1 && req1.payloadField === 171 && payload1 && payload1.length === 1
            && toInt(payload1[0].v) === 1, req1 && {
                field: req1.payloadField,
                payload: req1.payload && req1.payload.toString('hex'),
            });
        check('第一页 20 条且外层 #5=1 表示还有下一页',
            page1.ok === true && page1.entries.length === 20
            && page1.currentPage === 1 && page1.hasNext === true && page1.myRank === 29, page1);
        check('排行榜昵称、店名、玩家/店铺等级和营业额按抓包字段解析',
            page1.entries[0].gid === 1200000001
            && page1.entries[0].nickname === '玩家1'
            && page1.entries[0].storeName === '测试店铺1'
            && page1.entries[0].playerLevel === 60
            && page1.entries[0].storeLevel === 2
            && page1.entries[0].revenue === 99999, page1.entries[0]);

        const page2 = await milkTea.getStoreRankings(2);
        const self = page2.entries.find((entry) => entry.rank === 29);
        check('第二页按 rank===myRank 识别本人，并正确解析中文/emoji',
            self && self.isSelf === true && page2.containsSelf === true
            && self.nickname === '北栎🍵' && self.gid === 1200000029, self);
        check('好友标记 #6=1 映射为 isFriend',
            page2.entries.find((entry) => entry.rank === 30).isFriend === true
            && page2.entries.find((entry) => entry.rank === 29).isFriend === false, page2.entries.slice(8, 11));
        check('第二页 20 条时 #5=1，hasNext 仍为 true',
            page2.entries.length === 20 && page2.hasNext === true, page2);

        const page3 = await milkTea.getStoreRankings(3);
        check('最后一页 12 条且外层 #5=0 时 hasNext=false',
            page3.ok === true && page3.entries.length === 12
            && page3.currentPage === 3 && page3.hasNext === false, page3);

        const empty = await milkTea.getStoreRankings(4);
        check('空页安全返回空数组和非本人状态',
            empty.ok === true && empty.entries.length === 0
            && empty.containsSelf === false && empty.hasNext === false, empty);

        router = async (req) => {
            if (req.cmd === 66) {
                return operateReply(66, {
                    errorCode: 1034149,
                    result: null,
                    resultField: 171,
                });
            }
            throw new Error(`排行榜错误用例收到 cmd=${req.cmd}`);
        };
        const failed = await milkTea.getStoreRankings(1);
        check('排行榜业务错误安全返回完整空状态',
            failed.ok === false && failed.entries.length === 0
            && failed.myRank === 0 && failed.currentPage === 1
            && failed.hasNext === false && failed.containsSelf === false
            && /1034149|排行榜读取失败/.test(failed.reason), failed);
    }

    finish();
})().catch((e) => {
    console.log('测试异常:', e && e.stack ? e.stack : e);
    process.exit(1);
});
