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
const GROUP_SHOP = 2026110102;
const GROUP_TASK = 2026110103;

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
const store = require(`${SB}/src/models/store`);
const { toInt } = require(`${SB}/src/utils/utils`);
const activityLogs = [];
require(`${SB}/src/utils/utils`).setLogHook((tag, msg, isWarn, meta) => {
    if (meta && meta.module === 'activity') activityLogs.push({ tag, msg, isWarn, meta });
});

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

function activityBody(groupId, fields = []) {
    return Buffer.concat([
        bytesField(1, varintField(1, groupId)),
        ...fields,
    ]);
}

/** 合成主活动体: #1 活动头 / #121.#1 店铺状态。 */
function mainActivity(state = null) {
    const fields = [];
    if (state) fields.push(bytesField(121, bytesField(1, state)));
    return activityBody(GROUP_MAIN, fields);
}

function shopGoods({
    goodsId,
    itemId,
    itemCount = 1,
    currencyId = 1041,
    unitPrice = 1,
    limitCount = 0,
    purchasedCount = 0,
    name = `商品${goodsId}`,
    restrictionType = 0,
    kind = 'seed',
    unlocked = true,
    requireLevel = 0,
    conditionText = '',
} = {}) {
    const fields = [
        varintField(1, goodsId),
        bytesField(2, Buffer.concat([
            varintField(1, itemId),
            varintField(2, itemCount),
        ])),
        bytesField(3, Buffer.concat([
            varintField(1, currencyId),
            varintField(2, unitPrice),
        ])),
        varintField(4, limitCount),
        varintField(5, purchasedCount),
        bytesField(7, name),
        varintField(11, restrictionType),
        bytesField(12, kind),
    ];
    if (unlocked === false || requireLevel > 0 || conditionText) {
        const unlockFields = [
            bytesField(2, conditionText),
            varintField(5, requireLevel),
        ];
        if (unlocked === false) unlockFields.splice(1, 0, varintField(3, 0));
        fields.push(bytesField(13, Buffer.concat(unlockFields)));
    }
    return bytesField(2, Buffer.concat(fields));
}

function shopActivity(goods = []) {
    return activityBody(GROUP_SHOP, [bytesField(102, Buffer.concat(goods))]);
}

function taskEntry({
    id,
    status = 1,
    conditionText = '',
    conditionType = 0,
    taskIndex = 0,
    conditionValue = 0,
    rewards = [],
} = {}) {
    const fields = [
        varintField(1, id),
        bytesField(2, Buffer.concat([
            bytesField(1, conditionText),
            varintField(2, conditionType),
            varintField(3, taskIndex),
            varintField(4, conditionValue),
        ])),
    ];
    for (const reward of rewards) {
        fields.push(bytesField(3, Buffer.concat([
            varintField(1, reward.id),
            varintField(2, reward.count),
        ])));
    }
    fields.push(varintField(4, status));
    return bytesField(3, Buffer.concat(fields));
}

function taskActivity({ summary = Buffer.alloc(0), tasks = [] } = {}) {
    const fields = [];
    if (summary.length) fields.push(bytesField(2, summary));
    fields.push(...tasks);
    return activityBody(GROUP_TASK, [bytesField(122, Buffer.concat(fields))]);
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

function hireRequestInner(req) {
    const outer = req && req.payload && mg.parseTop(req.payload);
    const innerBox = outer && outer.find((x) => x.f === 1 && x.w === 2);
    return innerBox ? mg.parseTop(innerBox.v) : null;
}

function hireRequestSlot(req) {
    const inner = hireRequestInner(req);
    return toInt((inner && inner.find((x) => x.f === 1) || {}).v);
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
    slot,
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
    if (slot !== undefined && slot !== null) fields.push(varintField(1, slot));
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

function hireCandidateFriend({
    gid,
    name = `好友${gid}`,
    level = 100,
    titleId = 9001,
    titleName = '金牌销售',
    state = 0,
    offAt = 0,
    field7,
} = {}) {
    const fields = [
        bytesField(1, Buffer.concat([
            varintField(1, gid),
            bytesField(2, name),
            varintField(4, level),
        ])),
        varintField(3, titleId),
        bytesField(4, titleName),
        varintField(5, state),
        varintField(6, offAt),
    ];
    if (field7 !== undefined) fields.push(varintField(7, field7));
    return bytesField(4, Buffer.concat(fields));
}

function hireCandidateStaff({
    gid,
    name = '实习员工',
    state = 1,
    titleId = 9004,
    titleName = '默默搬砖',
} = {}) {
    return bytesField(5, Buffer.concat([
        bytesField(1, Buffer.concat([
            varintField(1, gid),
            bytesField(2, name),
        ])),
        varintField(2, state),
        varintField(3, titleId),
        bytesField(4, titleName),
    ]));
}

function employeePanelResult({ friends = [], staff = [] } = {}) {
    return Buffer.concat([
        varintField(1, 1),
        varintField(2, 40),
        varintField(3, 600),
        ...friends,
        ...staff,
        varintField(6, 1),
    ]);
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
        const parsedMenu = await milkTea.__testing.getMenuRecipes();
        check('cmd58 结构化解析配方字段与解锁状态',
            parsedMenu.ok === true && parsedMenu.recipes.length === 1 && parsedMenu.recipes[0].id === 10
            && parsedMenu.recipes[0].name === '普通奶茶' && parsedMenu.recipes[0].unlocked === true
            && parsedMenu.recipes[0].field4 === 12 && parsedMenu.recipes[0].productId === 50010
            && parsedMenu.recipes[0].price === 18 && parsedMenu.recipes[0].field7 === 7,
            parsedMenu);
        const featured = await milkTea.__testing.getFeaturedRecipe(10);
        check('当前主推配方 ID 使用 cmd58 菜单补全名称',
            featured.ok === true && featured.id === 10 && featured.name === '普通奶茶'
            && featured.unlocked === true, featured);

        milkTea.__testing.clearMenuCache();
        router = async (req) => {
            if (req.cmd === 67) return operateReply(67, { result: sales, resultField: 172 });
            if (req.cmd === 58) {
                return operateReply(58, {
                    errorCode: 1034149,
                    result: Buffer.alloc(0),
                    resultField: 163,
                });
            }
            throw new Error(`菜单降级用例收到 ${req.method || `cmd=${req.cmd}`}`);
        };
        const degradedSales = await milkTea.__testing.getSalesRecords(day);
        check('cmd58 失败时营业记录仍成功并降级显示品类编号',
            degradedSales.ok === true && degradedSales.items[0].name === '品类10',
            degradedSales);
        const featuredFallback = await milkTea.__testing.getFeaturedRecipe(10);
        check('菜单读取失败时主推配方保留编号并标记降级',
            featuredFallback.ok === false && featuredFallback.id === 10
            && featuredFallback.name === '配方#10' && /读取配方菜单失败/.test(featuredFallback.reason),
            featuredFallback);
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
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        milkTea.__testing.clearMenuCache();
        milkTea.__testing.clearMainStatusCache();
        warehouse.getBag = async () => ({});
        warehouse.getBagItems = () => [{ id: 40525, uid: 62001, count: 1 }];
        let listCalls = 0;
        let craftCalls = 0;
        router = async (req) => {
            if (req.method === 'List') {
                listCalls += 1;
                return activityListReply([mainActivity()]);
            }
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                craftCalls += 1;
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                return operateReply(62, { result: craftResult(requestUids), resultField: 167 });
            }
            throw new Error(`手动制作缓存失效用例收到 ${req.method || `cmd=${req.cmd}`}`);
        };

        const cachedBefore = await milkTea.getMainStatus(true);
        const manual = await milkTea.craftMilkTea(1);
        const refreshed = await milkTea.getMainStatus();
        check('手动制作成功后清理主活动状态缓存并重新读取 List',
            cachedBefore.ok === true && manual.ok === true && refreshed.ok === true
            && craftCalls === 1 && listCalls === 2,
            { cachedBefore, manual, refreshed, craftCalls, listCalls });

        warehouse.getBag = originalGetBag;
        warehouse.getBagItems = originalGetBagItems;
        milkTea.__testing.clearMenuCache();
        milkTea.__testing.clearMainStatusCache();
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

    section('11. cmd58 读取或解析失败时禁止制作');
    {
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        warehouse.getBag = async () => ({});
        warehouse.getBagItems = () => [{ id: 40525, uid: 71001, count: 1 }];
        const failures = [
            {
                label: '接口失败',
                reply: () => operateReply(58, {
                    errorCode: 1034149,
                    result: Buffer.alloc(0),
                    resultField: 163,
                }),
            },
            {
                label: '空响应',
                reply: () => operateReply(58, { result: Buffer.alloc(0), resultField: 163 }),
            },
            {
                label: '解析失败',
                reply: () => operateReply(58, {
                    result: Buffer.from([0x0a, 0x05, 0x01]),
                    resultField: 163,
                }),
            },
        ];
        for (const failure of failures) {
            for (const [method, call] of [
                ['craftAllFruits', () => milkTea.__testing.craftAllFruits(2, 1)],
                ['craftMilkTea', () => milkTea.craftMilkTea(1)],
            ]) {
                milkTea.__testing.clearMenuCache();
                router = async (req) => {
                    if (req.cmd === 58) return failure.reply();
                    throw new Error(`${failure.label}/${method} 不应发送 cmd=${req.cmd}`);
                };
                sent.length = 0;
                const logStart = activityLogs.length;
                const r = await call();
                const logs = activityLogs.slice(logStart).map((x) => x.msg).join('\n');
                check(`${failure.label}时 ${method} 禁止发送 cmd62`,
                    r.ok === false && /读取配方菜单失败|解析配方菜单失败/.test(r.reason)
                    && !sent.some((x) => x.cmd === 62), { result: r, sent: sent.map((x) => x.cmd) });
                check(`${failure.label}时 ${method} 记录配方菜单错误`,
                    /读取配方菜单失败|解析配方菜单失败/.test(logs), logs);
            }
        }
        warehouse.getBag = originalGetBag;
        warehouse.getBagItems = originalGetBagItems;
        milkTea.__testing.clearMenuCache();
    }

    section('12. 收银台详情 cmd55/#160 字段分离与员工位');
    {
        const nowSec = Math.floor(Date.now() / 1000);
        const slotOneShiftUid = '30069608145587714';
        const slotZeroShiftUid = '30069573064429059';
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
                    slot: 1,
                    shiftUid: slotOneShiftUid,
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
                    // 旧抓包里 0 号位省略 #1；解析时按 protobuf 默认值记为 slot=0。
                    shiftUid: slotZeroShiftUid,
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
        const slotOne = employees.find((x) => x.shiftUid === slotOneShiftUid);
        const slotZero = employees.find((x) => x.shiftUid === slotZeroShiftUid);
        check('17 位班次 UID 精确保留为字符串',
            slotOne && typeof slotOne.shiftUid === 'string' && slotOne.shiftUid === slotOneShiftUid
            && slotZero && typeof slotZero.shiftUid === 'string' && slotZero.shiftUid === slotZeroShiftUid,
            detail.employees);
        check('#9.#1 映射为员工位，缺省记录按 0 号位处理',
            slotOne && slotOne.slot === 1 && slotZero && slotZero.slot === 0
            && slotOne.employeeType === 'unknown' && slotZero.employeeType === 'unknown',
            { slotOne, slotZero });
        check('员工中文与 emoji 昵称按 UTF-8 精确保留',
            slotOne && slotOne.name === '哈哈🍵' && slotZero && slotZero.name === '不想内卷.',
            employees.map((x) => x.name));
        check('员工 gid/等级/起止时间/工资/特长完整映射',
            slotOne && slotOne.gid === 1253397809 && slotOne.level === 108
            && slotOne.startAt === nowSec - 3600 && slotOne.endAt === nowSec + 3600
            && slotOne.wage === 40 && slotOne.titleId === 9001 && slotOne.titleName === '金牌销售',
            slotOne);
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

    section('13. 领取收银台收益必须先确认 #19 且网络异常不成功');
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

    section('14. getOnDutyEmployees(detail) 不重复查询 cmd55');
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
                                slot: 1,
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

    section('14.1 收银台员工按候选 GID 关联好友/NPC 来源');
    {
        const employees = [
            { gid: 10001, name: '好友员工', employeeType: 'unknown', isFriend: false, isNpc: false },
            { gid: 20001, name: '系统员工', employeeType: 'unknown', isFriend: false, isNpc: false },
            { gid: 30001, name: '未知员工', employeeType: 'unknown', isFriend: false, isNpc: false },
        ];
        const sourced = milkTea.__testing.applyEmployeeSources(employees, {
            friends: [{ gid: 10001, kind: 'friend' }],
            staff: [{ gid: 20001, kind: 'staff' }],
        });
        check('好友 GID 标记为 friend',
            sourced[0].employeeType === 'friend' && sourced[0].isFriend === true && sourced[0].isNpc === false,
            sourced[0]);
        check('系统员工 GID 标记为 npc',
            sourced[1].employeeType === 'npc' && sourced[1].isFriend === false && sourced[1].isNpc === true,
            sourced[1]);
        check('候选面板缺失的 GID 保留 unknown 且不猜测来源',
            sourced[2].employeeType === 'unknown' && sourced[2].isFriend === false && sourced[2].isNpc === false,
            sourced[2]);

        const unavailable = milkTea.__testing.applyEmployeeSources(employees, null);
        check('员工候选读取失败时保持原记录',
            unavailable.every((employee) => employee.employeeType === 'unknown'),
            unavailable);
    }

    section('15. 收银台查询 cmd60/#165 请求与长期累计映射');
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
        check('#165.#1/#2/#3 映射 cupTotal/couponTotal/goldTotal',
            status.ok === true && status.cupTotal === 50
            && status.couponTotal === 2250 && status.goldTotal === 2908400, status);
        check('cmd60 不再把长期累计误命名为容量/待领取/杯数',
            !Object.prototype.hasOwnProperty.call(status, 'todayCups')
            && !Object.prototype.hasOwnProperty.call(status, 'capacity')
            && !Object.prototype.hasOwnProperty.call(status, 'pending')
            && !Object.prototype.hasOwnProperty.call(status, 'cups'), status);
    }

    section('16. 雇佣好友 cmd57/#162 目标员工位与完整班次档位');
    {
        const gid = 1253397809;
        router = async (req) => {
            if (req.cmd === 56) {
                return operateReply(56, {
                    result: employeePanelResult({
                        friends: [hireCandidateFriend({ gid })],
                        staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                    }),
                    resultField: 161,
                });
            }
            if (req.cmd === 57) return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            throw new Error(`雇佣用例收到 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const hired = await milkTea.hireFriend(gid, 1, { skipCapacityCheck: true, slot: 1 });
        const req = sent.find((x) => x.cmd === 57);
        check('雇佣前按成功抓包先发送 cmd56/#161',
            sent.map((x) => x.cmd).join(',') === '56,57'
            && sent[0].payloadField === 161
            && sent[0].payload.toString('hex') === '0801',
            sent.map((x) => ({ cmd: x.cmd, field: x.payloadField, payload: x.payload.toString('hex') })));
        const outer = req && mg.parseTop(req.payload);
        const inner = hireRequestInner(req);
        check('cmd57 外层只有 #162.#1 嵌套体',
            req && req.payloadField === 162 && outer && outer.length === 1 && inner, outer);
        check('cmd57/#162.#1 精确包含目标位 #1=1/#2=1/#3=gid',
            hired.ok === true && inner.length === 3
            && toInt((inner.find((x) => x.f === 1) || {}).v) === 1
            && toInt((inner.find((x) => x.f === 2) || {}).v) === 1
            && toInt((inner.find((x) => x.f === 3) || {}).v) === gid, inner);

        for (const duration of [2, 3]) {
            sent.length = 0;
            const result = await milkTea.hireFriend(gid, duration, { skipCapacityCheck: true, slot: 1 });
            const durationReq = sent.find((x) => x.cmd === 57);
            const durationInner = hireRequestInner(durationReq);
            check(`hireDuration=${duration} 精确写入 cmd57/#162.#1.#2`,
                result.ok === true
                && toInt((durationInner.find((x) => x.f === 2) || {}).v) === duration,
                durationInner);
        }

        sent.length = 0;
        const invalid = await milkTea.hireFriend(gid, 99, { skipCapacityCheck: true, slot: 1 });
        const invalidReq = sent.find((x) => x.cmd === 57);
        const invalidOuter = invalidReq && mg.parseTop(invalidReq.payload);
        const invalidBox = invalidOuter && invalidOuter.find((x) => x.f === 1 && x.w === 2);
        const invalidInner = invalidBox && mg.parseTop(invalidBox.v);
        check('非法 hireDuration 回落到 #2=1',
            invalid.ok === true
            && toInt((invalidInner.find((x) => x.f === 2) || {}).v) === 1, invalidInner);

        check('招聘班次完整覆盖 4/12/24 小时',
            milkTea.HIRE_DURATIONS.map((x) => [x.id, x.seconds]).join(',')
            === '1,14400,2,43200,3,86400', milkTea.HIRE_DURATIONS);

        const savedDurations = [];
        for (const duration of [1, 2, 3]) {
            store.applyConfigSnapshot(
                { milkTeaHireDuration: duration },
                { persist: false, accountId: process.env.FARM_ACCOUNT_ID },
            );
            savedDurations.push(store.getMilkTeaConfig(process.env.FARM_ACCOUNT_ID).hireDuration);
        }
        store.applyConfigSnapshot(
            { milkTeaHireDuration: 99 },
            { persist: false, accountId: process.env.FARM_ACCOUNT_ID },
        );
        const invalidSavedDuration = store.getMilkTeaConfig(process.env.FARM_ACCOUNT_ID).hireDuration;
        check('班次配置保存后 1/2/3 不被重置，非法值回落 1',
            savedDurations.join(',') === '1,2,3' && invalidSavedDuration === 1,
            { savedDurations, invalidSavedDuration });

        const nowSec = Math.floor(Date.now() / 1000);
        const latestCaptureGid = 1226530474;
        const employees = [cashierEmployee({
            slot: 1,
            shiftUid: '30070362835095071',
            gid: 1244632861,
            name: '南桉',
            level: 109,
            startAt: nowSec - 3600,
            endAt: nowSec + 3600,
            wage: 40,
            titleId: 9003,
            titleName: '金牌服务',
        })];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) {
                return operateReply(56, {
                    result: employeePanelResult({
                        friends: [hireCandidateFriend({ gid: latestCaptureGid })],
                        staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                    }),
                    resultField: 161,
                });
            }
            if (req.cmd === 57) {
                const slot = hireRequestSlot(req);
                employees.push(cashierEmployee({
                    slot,
                    shiftUid: '30070362835095072',
                    gid: latestCaptureGid,
                    name: '最新抓包好友',
                    level: 100,
                    startAt: nowSec,
                    endAt: nowSec + 14400,
                    wage: 40,
                    titleId: 9001,
                    titleName: '金牌销售',
                }));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`最新抓包手动雇佣用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const latestCaptureHire = await milkTea.hireFriend(latestCaptureGid, 1);
        const latestCaptureReq = sent.find((x) => x.cmd === 57);
        check('最新成功抓包: 1 号位已占用时手动雇佣自动选择 0 号位',
            latestCaptureHire.ok === true && latestCaptureHire.employeeSlot === 0
            && hireRequestSlot(latestCaptureReq) === 0
            && sent.map((x) => x.cmd).join(',') === '55,56,57',
            { result: latestCaptureHire, sent: sent.map((x) => ({ cmd: x.cmd, slot: hireRequestSlot(x) })) });
    }

    section('17. 三级店铺两个员工位、满员跳过与已下班员工占位');
    {
        const nowSec = Math.floor(Date.now() / 1000);
        const employee = (gid, slot, startAt, endAt) => cashierEmployee({
            slot,
            shiftUid: String(`3006960814558${String(gid).slice(-4)}`),
            gid,
            name: '雇佣员工',
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

        router = async (req) => {
            if (req.cmd === 56) {
                return operateReply(56, {
                    result: employeePanelResult({
                        friends: [hireCandidateFriend({ gid: 1300000301, titleId: 9003, titleName: '金牌服务' })],
                        staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                    }),
                    resultField: 161,
                });
            }
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            throw new Error(`候选校验用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const invalidTarget = await milkTea.hireFriend(1300000399, 1, { skipCapacityCheck: true, slot: 0 });
        check('目标不在当前 cmd56 候选中时不发送 cmd57',
            invalidTarget.ok === false && invalidTarget.skipped === true
            && /不在当前可雇佣候选/.test(invalidTarget.reason)
            && sent.map((x) => x.cmd).join(',') === '56', {
                result: invalidTarget,
                sent: sent.map((x) => x.cmd),
            });

        const latestCaptureFriends = [
            hireCandidateFriend({ gid: 1004896646, name: '金牌销售好友', titleId: 9001, state: 1, offAt: 1792396184 }),
            hireCandidateFriend({ gid: 1022250540, name: '金牌销售好友', titleId: 9001, state: 1, offAt: 1792398217 }),
            hireCandidateFriend({ gid: 1030663005, name: '金牌服务好友', titleId: 9003, state: 1, offAt: 1792400040 }),
            hireCandidateFriend({ gid: 1018793394, name: '金牌宣传好友', titleId: 9002, state: 1, offAt: 1792423965 }),
        ];
        const latestCapturePanel = milkTea.__testing.parseEmployeePanel(
            employeePanelResult({ friends: latestCaptureFriends }).toString('hex')
        );
        check('解析好友候选的 #5 状态与 #6/#7 原始字段',
            latestCapturePanel.friends.length === 4
            && latestCapturePanel.friends.every((x) => x.state === 1)
            && latestCapturePanel.friends[0].offAt === 1792396184, latestCapturePanel);

        let candidateSequenceEmployees = [];
        let candidateSequenceSettled = true;
        router = async (req) => {
            if (req.cmd === 55) {
                candidateSequenceSettled = true;
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: candidateSequenceEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) {
                return operateReply(56, {
                    result: employeePanelResult({
                        // 20261019-133724_雇佣1: 四位好友均为 #5=1，随后客户端改用系统员工。
                        friends: latestCaptureFriends,
                        staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                    }),
                    resultField: 161,
                });
            }
            if (req.cmd === 57) {
                if (!candidateSequenceSettled) {
                    return operateReply(57, { errorCode: 1034140, result: Buffer.alloc(0), resultField: 162 });
                }
                const gid = toInt((hireRequestInner(req).find((x) => x.f === 3) || {}).v);
                candidateSequenceEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                candidateSequenceSettled = false;
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`双店员候选序列用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const candidateSequence = await milkTea.autoHire([1300000310], { duration: 1 });
        const candidateSequenceCommands = sent.map((x) => x.cmd);
        check('最新抓包好友全不可雇佣时按 101、102 连续单人补满',
            candidateSequence.ok === true && candidateSequence.hired === 2
            && candidateSequenceCommands.join(',') === '55,56,57,55,56,57,55'
            && sent.filter((x) => x.cmd === 57).map((x) => toInt((hireRequestInner(x).find((f) => f.f === 3) || {}).v)).join(',') === '101,102', {
                result: candidateSequence,
                sent: candidateSequenceCommands,
            });

        const unavailablePanel = employeePanelResult({
            friends: [
                hireCandidateFriend({ gid: 1300000320, state: 1, offAt: nowSec + 3600 }),
                hireCandidateFriend({ gid: 1300000321, state: 2, offAt: nowSec + 7200, field7: nowSec + 10800 }),
            ],
            staff: [hireCandidateStaff({ gid: 101 })],
        });
        const unavailableParsed = milkTea.__testing.parseEmployeePanel(unavailablePanel.toString('hex'));
        check('好友候选 #7 未确认字段原样保留',
            unavailableParsed.friends[0].field7 === 0
            && unavailableParsed.friends[1].field7 === nowSec + 10800, unavailableParsed);
        router = async (req) => {
            if (req.cmd === 56) {
                return operateReply(56, { result: unavailablePanel, resultField: 161 });
            }
            throw new Error(`不可雇佣好友直调用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const unavailableFriend = await milkTea.hireFriend(1300000320, 1, { skipCapacityCheck: true, slot: 0 });
        check('显式指定 #5=1 好友时不再发送 cmd57',
            unavailableFriend.ok === false && unavailableFriend.skipped === true
            && /#5=1.*已跳过 cmd57/.test(unavailableFriend.reason || '')
            && sent.map((x) => x.cmd).join(',') === '56', {
                result: unavailableFriend,
                sent: sent.map((x) => x.cmd),
            });

        sent.length = 0;
        const unavailableFriendState2 = await milkTea.hireFriend(1300000321, 1, { skipCapacityCheck: true, slot: 0 });
        check('显式指定 #5=2 好友时同样不发送 cmd57',
            unavailableFriendState2.ok === false && unavailableFriendState2.skipped === true
            && /#5=2.*已跳过 cmd57/.test(unavailableFriendState2.reason || '')
            && sent.map((x) => x.cmd).join(',') === '56', {
                result: unavailableFriendState2,
                sent: sent.map((x) => x.cmd),
            });

        let staleCandidateEmployees = [];
        let staleCandidateFetches = 0;
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: staleCandidateEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) {
                staleCandidateFetches += 1;
                return operateReply(56, {
                    result: employeePanelResult({
                        friends: [
                            hireCandidateFriend({ gid: 1300000322, state: staleCandidateFetches === 1 ? 0 : 1 }),
                            hireCandidateFriend({ gid: 1300000323, state: staleCandidateFetches === 1 ? 0 : 1 }),
                        ],
                        staff: [hireCandidateStaff({ gid: 101 })],
                    }),
                    resultField: 161,
                });
            }
            if (req.cmd === 57) {
                const gid = toInt((hireRequestInner(req).find((x) => x.f === 3) || {}).v);
                staleCandidateEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`候选刷新失效用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const staleCandidate = await milkTea.autoHire([1300000322], { duration: 1 });
        check('第二空位刷新后好友 #5 变为 1 时跳过并继续系统员工',
            staleCandidate.ok === true && staleCandidate.hired === 2
            && sent.filter((x) => x.cmd === 57)
                .map((x) => toInt((hireRequestInner(x).find((f) => f.f === 3) || {}).v)).join(',') === '1300000322,101', {
                result: staleCandidate,
                sent: sent.map((x) => x.cmd),
            });

        const fullEmployees = [
            employee(1253397809, 0, nowSec - 3600, nowSec + 3600),
            // 已下班员工仍是当前员工，不能因此再开一个雇佣位。
            employee(1216569456, 1, nowSec - 7200, nowSec - 3600),
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

        let twoVacanciesEmployees = [];
        let hireSettled = true;
        router = async (req) => {
            if (req.cmd === 55) {
                hireSettled = true;
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: twoVacanciesEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) {
                if (!hireSettled) {
                    // 模拟真实服务端：前一单未通过 cmd55 确认结算时，下一单会被拒绝。
                    return operateReply(57, { errorCode: 1034140, result: Buffer.alloc(0), resultField: 162 });
                }
                const outer = mg.parseTop(req.payload);
                const innerBox = outer.find((x) => x.f === 1 && x.w === 2);
                const inner = innerBox && mg.parseTop(innerBox.v);
                const gid = toInt((inner && inner.find((x) => x.f === 3) || {}).v);
                twoVacanciesEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                hireSettled = false;
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            throw new Error(`双空位用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const twoVacancies = await milkTea.autoHire([1300000001, 1300000002], { duration: 1 });
        const twoVacancyCommands = sent.map((x) => x.cmd);
        check('三级店铺有两个空位时自动雇佣连续补满两人',
            twoVacancies.ok === true && twoVacancies.hired === 2
            && Array.isArray(twoVacancies.friendGids) && twoVacancies.friendGids.length === 2
            && twoVacancies.finalEmployeeCount === 2 && twoVacancies.currentEmployees.length === 2
            && twoVacancyCommands.filter((cmd) => cmd === 57).length === 2, {
                result: twoVacancies,
                sent: twoVacancyCommands,
            });
        check('两个空位按 0、1 号位依次提交 cmd57',
            sent.filter((x) => x.cmd === 57).map(hireRequestSlot).join(',') === '0,1',
            sent.filter((x) => x.cmd === 57).map((x) => ({ slot: hireRequestSlot(x), gid: toInt((hireRequestInner(x).find((f) => f.f === 3) || {}).v) })));
        check('首次雇佣成功后先刷新 cmd55，再提交第二个 cmd57',
            twoVacancyCommands.join(',') === '55,56,57,55,56,57,55', twoVacancyCommands);

        let partialEmployees = [];
        const partialFriendGid = 1300000501;
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: partialEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: partialFriendGid })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                const gid = toInt((hireRequestInner(req).find((x) => x.f === 3) || {}).v);
                if (gid === partialFriendGid && !partialEmployees.length) {
                    partialEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                    return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
                }
                return operateReply(57, { errorCode: 1034140, result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`部分雇佣用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        activityLogs.length = 0;
        const partialAuto = await milkTea.autoHire([partialFriendGid], { duration: 1 });
        check('双空位只成功一人时返回 partial、剩余空位和第二候选失败原因',
            partialAuto.ok === true && partialAuto.partial === true
            && partialAuto.hired === 1 && partialAuto.remainingVacancies === 1
            && /1034140/.test(partialAuto.reason || ''), {
                result: partialAuto,
                sent: sent.map((x) => x.cmd),
            });
        check('部分雇佣汇总日志按警告记录',
            activityLogs.some((x) => x.isWarn && /已自动补位|仍有 1 个员工位空缺/.test(x.msg)),
            activityLogs);

        let laggingEmployees = [];
        let lastHireNeedsStalePoll = false;
        let stalePolls = 0;
        router = async (req) => {
            if (req.cmd === 55) {
                let visible = laggingEmployees;
                if (lastHireNeedsStalePoll && stalePolls === 0) {
                    stalePolls += 1;
                    visible = laggingEmployees.slice(0, -1);
                } else {
                    lastHireNeedsStalePoll = false;
                    stalePolls = 0;
                }
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: visible }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) {
                const outer = mg.parseTop(req.payload);
                const innerBox = outer.find((x) => x.f === 1 && x.w === 2);
                const inner = innerBox && mg.parseTop(innerBox.v);
                const gid = toInt((inner && inner.find((x) => x.f === 3) || {}).v);
                laggingEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                lastHireNeedsStalePoll = true;
                stalePolls = 0;
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            throw new Error(`状态滞后用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const lagging = await milkTea.autoHire([1300000005, 1300000006], { duration: 1 });
        const laggingCommands = sent.map((x) => x.cmd);
        check('cmd55 首帧滞后时轮询确认后仍可补满第二人',
            lagging.ok === true && lagging.hired === 2 && lagging.finalEmployeeCount === 2
            && laggingCommands.join(',') === '55,56,57,55,55,56,57,55,55', {
                result: lagging,
                sent: laggingCommands,
            });

        let hiddenEmployees = [];
        router = async (req) => {
            if (req.cmd === 55) {
                // 模拟 cmd57 已成功但 cmd55 持续返回雇佣前旧状态。
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) {
                const outer = mg.parseTop(req.payload);
                const innerBox = outer.find((x) => x.f === 1 && x.w === 2);
                const inner = innerBox && mg.parseTop(innerBox.v);
                const gid = toInt((inner && inner.find((x) => x.f === 3) || {}).v);
                hiddenEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            throw new Error(`持续滞后用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const unsynced = await milkTea.autoHire([1300000007, 1300000008], { duration: 1 });
        check('cmd55 持续滞后时只雇佣一人、停止第二次 cmd57 并标记部分成功',
            unsynced.ok === true && unsynced.hired === 1
            && unsynced.stateSyncPending === true
            && unsynced.partial === true && unsynced.remainingVacancies === 1
            && sent.filter((x) => x.cmd === 57).length === 1, {
                result: unsynced,
                sent: sent.map((x) => x.cmd),
                hidden: hiddenEmployees,
            });

        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) {
                return operateReply(57, {
                    errorCode: 1034140,
                    result: Buffer.alloc(0),
                    resultField: 162,
                });
            }
            if (req.cmd === 56) {
                return operateReply(56, {
                    result: employeePanelResult({
                        friends: [hireCandidateFriend({ gid: 1300000009 })],
                        staff: [],
                    }),
                    resultField: 161,
                });
            }
            throw new Error(`拒绝原因用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const rejected = await milkTea.autoHire([1300000009], { duration: 1 });
        check('cmd55 有空位但 cmd57 返回 1034140 时保留真实请求错误',
            rejected.ok === false && /code=1034140/.test(rejected.reason)
            && rejected.errorCode === 1034140
            && rejected.attempted === 1
            && sent.map((x) => x.cmd).join(',') === '55,56,57'
            && !/员工已满|位置已存在|员工最近/.test(rejected.reason), { rejected, sent: sent.map((x) => x.cmd) });

        let manyHireAttempts = 0;
        let exhaustedAttempts = 0;
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                manyHireAttempts += 1;
                return operateReply(57, { errorCode: 1034140, result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`多好友拒绝用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const manyGids = Array.from({ length: 49 }, (_, i) => 1301000000 + i);
        const manyRejected = await milkTea.autoHire(manyGids, { duration: 1 });
        check('好友候选业务拒绝后继续尝试系统员工',
            manyRejected.ok === false && manyRejected.attempted === 3
            && manyHireAttempts === 3
            && sent.filter((x) => x.cmd === 57).length === 3
            && sent.map((x) => x.cmd).join(',') === '55,56,57,56,57,56,57', {
                result: manyRejected,
                sent: sent.map((x) => x.cmd),
            });

        let fallbackEmployees = [
            employee(1244632861, 1, nowSec - 3600, nowSec + 3600),
        ];
        let fallbackAttempts = [];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: fallbackEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [
                        hireCandidateFriend({ gid: 1300000401 }),
                        hireCandidateFriend({ gid: 1300000402 }),
                    ],
                    staff: [hireCandidateStaff({ gid: 101 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                const gid = toInt((hireRequestInner(req).find((x) => x.f === 3) || {}).v);
                fallbackAttempts.push(gid);
                if (gid === 1300000401) {
                    return operateReply(57, { errorCode: 1034141, result: Buffer.alloc(0), resultField: 162 });
                }
                fallbackEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`好友候选拒绝后继续用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const fallbackToNextFriend = await milkTea.autoHire([1300000401, 1300000402], { duration: 1 });
        check('好友 1034141 后继续下一位好友并成功补位',
            fallbackToNextFriend.ok === true && fallbackToNextFriend.hired === 1
            && fallbackToNextFriend.friendGids.join(',') === '1300000402'
            && fallbackAttempts.join(',') === '1300000401,1300000402'
            && sent.map((x) => x.cmd).join(',') === '55,56,57,56,57,55', {
                result: fallbackToNextFriend,
                sent: sent.map((x) => x.cmd),
                attempts: fallbackAttempts,
            });

        let staffFallbackEmployees = [];
        let staffFallbackAttempts = [];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: staffFallbackEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [
                        hireCandidateFriend({ gid: 1300000411 }),
                        hireCandidateFriend({ gid: 1300000412 }),
                    ],
                    staff: [hireCandidateStaff({ gid: 101 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                const gid = toInt((hireRequestInner(req).find((x) => x.f === 3) || {}).v);
                staffFallbackAttempts.push(gid);
                if (gid === 1300000411) {
                    return operateReply(57, { errorCode: 1034130, result: Buffer.alloc(0), resultField: 162 });
                }
                if (gid === 1300000412) {
                    return operateReply(57, { errorCode: 1034140, result: Buffer.alloc(0), resultField: 162 });
                }
                staffFallbackEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`系统员工兜底用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const fallbackToStaff = await milkTea.autoHire([1300000411, 1300000412], { duration: 1 });
        check('好友 1034130/1034140 全部失败后系统员工成功兜底',
            fallbackToStaff.ok === true && fallbackToStaff.hired === 1
            && fallbackToStaff.friendGids.join(',') === '101'
            && staffFallbackAttempts.join(',') === '1300000411,1300000412,101'
            && sent.filter((x) => x.cmd === 57).length === 3, {
                result: fallbackToStaff,
                sent: sent.map((x) => x.cmd),
                attempts: staffFallbackAttempts,
            });

        let emptyWhitelistEmployees = [
            employee(1244632861, 1, nowSec - 3600, nowSec + 3600),
        ];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: emptyWhitelistEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000421, state: 1 })],
                    staff: [hireCandidateStaff({ gid: 101, state: 1 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                const gid = toInt((hireRequestInner(req).find((x) => x.f === 3) || {}).v);
                emptyWhitelistEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`空白名单系统员工用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const emptyWhitelistHire = await milkTea.autoHire([], { duration: 1 });
        check('未配置优先好友时仍查询 employee 面板并雇佣可用系统员工',
            emptyWhitelistHire.ok === true && emptyWhitelistHire.hired === 1
            && emptyWhitelistHire.friendGids.join(',') === '101'
            && sent.map((x) => x.cmd).join(',') === '55,56,57,55', {
                result: emptyWhitelistHire,
                sent: sent.map((x) => x.cmd),
            });

        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000431, state: 1 })],
                    staff: [
                        hireCandidateStaff({ gid: 101, state: 0 }),
                        hireCandidateStaff({ gid: 102, state: 2 }),
                    ],
                }),
                resultField: 161,
            });
            throw new Error(`无可用系统员工用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const noAvailableStaff = await milkTea.autoHire([], { duration: 1 });
        check('未配置好友且系统员工 state=0/2 时不发送 cmd57',
            noAvailableStaff.ok === true && noAvailableStaff.skipped === true
            && sent.map((x) => x.cmd).join(',') === '55,56', {
                result: noAvailableStaff,
                sent: sent.map((x) => x.cmd),
            });

        const oneEmployee = [
            // 普通店员同样占一个员工位，剩下一个空位只能补一名好友。
            employee(1216569456, 0, nowSec - 3600, nowSec + 3600),
        ];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: oneEmployee }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            throw new Error(`补位用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const partial = await milkTea.hireAll([1300000001, 1300000002]);
        check('三级店铺只补一个空位且最多发送一次 cmd57',
            partial.ok === true && partial.hired === 1
            && sent.filter((x) => x.cmd === 57).length === 1
            && hireRequestSlot(sent.find((x) => x.cmd === 57)) === 1, {
                result: partial,
                sent: sent.map((x) => ({ cmd: x.cmd, slot: hireRequestSlot(x) })),
            });

        let partialHireEmployees = [];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: partialHireEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) {
                const outer = mg.parseTop(req.payload);
                const innerBox = outer.find((x) => x.f === 1 && x.w === 2);
                const inner = innerBox && mg.parseTop(innerBox.v);
                const gid = toInt((inner && inner.find((x) => x.f === 3) || {}).v);
                partialHireEmployees = [
                    employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600),
                ];
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000021 })],
                    staff: [],
                }),
                resultField: 161,
            });
            throw new Error(`批量部分成功用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const partialTwoSlots = await milkTea.hireAll([1300000021]);
        check('双空位只雇到一人时返回 partial、剩余空位和原因',
            partialTwoSlots.ok === true && partialTwoSlots.hired === 1
            && partialTwoSlots.partial === true
            && partialTwoSlots.remainingVacancies === 1
            && /仍有 1 个员工位空缺/.test(partialTwoSlots.reason || '')
            && sent.filter((x) => x.cmd === 57).length === 1, {
                result: partialTwoSlots,
                sent: sent.map((x) => x.cmd),
            });

        let hireAllHiddenEmployees = [...oneEmployee];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: oneEmployee }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) {
                const outer = mg.parseTop(req.payload);
                const innerBox = outer.find((x) => x.f === 1 && x.w === 2);
                const inner = innerBox && mg.parseTop(innerBox.v);
                const gid = toInt((inner && inner.find((x) => x.f === 3) || {}).v);
                hireAllHiddenEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            throw new Error(`批量状态滞后用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const partialUnsynced = await milkTea.hireAll([1300000010, 1300000011]);
        check('批量雇佣也会等待状态确认，未同步时不补第二人',
            partialUnsynced.ok === true && partialUnsynced.hired === 1
            && partialUnsynced.stateSyncPending === true
            && sent.filter((x) => x.cmd === 57).length === 1, {
                result: partialUnsynced,
                sent: sent.map((x) => x.cmd),
                hidden: hireAllHiddenEmployees,
            });

        const autoEmployees = [
            // 最新成功抓包场景: 1 号位已有人，自动补位应选择 0 号位。
            employee(1244632861, 1, nowSec - 3600, nowSec + 3600),
        ];
        let autoHireSettled = true;
        router = async (req) => {
            if (req.cmd === 55) {
                autoHireSettled = true;
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: autoEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 57) {
                if (!autoHireSettled) {
                    return operateReply(57, { errorCode: 1034140, result: Buffer.alloc(0), resultField: 162 });
                }
                const outer = mg.parseTop(req.payload);
                const innerBox = outer.find((x) => x.f === 1 && x.w === 2);
                const inner = innerBox && mg.parseTop(innerBox.v);
                const gid = toInt((inner && inner.find((x) => x.f === 3) || {}).v);
                autoEmployees.push(employee(gid, hireRequestSlot(req), nowSec, nowSec + 3600));
                autoHireSettled = false;
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            throw new Error(`自动补位用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        activityLogs.length = 0;
        const auto = await milkTea.autoHire([1300000003, 1300000004], { duration: 1 });
        check('1 号位已有员工时自动雇佣只补一名到 0 号位并返回完整员工占位',
            auto.ok === true && auto.hired === 1
            && Array.isArray(auto.friendGids) && auto.friendGids.length === 1
            && auto.initialEmployeeCount === 1 && auto.finalEmployeeCount === 2
            && auto.employeeCount === 2 && auto.employeeCapacity === 2
            && sent.filter((x) => x.cmd === 57).length === 1
            && hireRequestSlot(sent.find((x) => x.cmd === 57)) === 0, {
                result: auto,
                sent: sent.map((x) => ({ cmd: x.cmd, slot: hireRequestSlot(x) })),
            });
        check('自动雇佣成功只产生一条概览汇总日志',
            activityLogs.filter((x) => /已自动补位|已雇佣/.test(x.msg)).length === 1,
            activityLogs);

        const replacementEmployees = [employee(1300000300, 0, nowSec - 3600, nowSec + 3600)];
        const replacementGid = 1300000305;
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: replacementEmployees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) {
                return operateReply(56, {
                    result: employeePanelResult({
                        friends: [hireCandidateFriend({ gid: replacementGid })],
                        staff: [hireCandidateStaff({ gid: 101 })],
                    }),
                    resultField: 161,
                });
            }
            if (req.cmd === 57) {
                // 班次交界：旧员工离开、新员工补入目标位，员工总数保持不变。
                replacementEmployees.splice(0, 1, employee(
                    replacementGid,
                    hireRequestSlot(req),
                    nowSec,
                    nowSec + 3600,
                ));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`员工换班确认用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const replacement = await milkTea.autoHire([replacementGid], { duration: 1 });
        check('员工总数不变但目标员工位换人时按已入店确认',
            replacement.ok === true && replacement.hired === 1
            && replacement.stateSyncPending === false
            && replacement.finalEmployeeCount === 1
            && replacement.currentEmployees[0].slot === 1
            && replacement.currentEmployees[0].gid === replacementGid, {
                result: replacement,
                sent: sent.map((x) => ({ cmd: x.cmd, slot: hireRequestSlot(x) })),
            });

        let rejectedOnceAttempts = 0;
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                rejectedOnceAttempts += 1;
                return operateReply(57, { errorCode: 1034130, result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`1034130 停止用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const rejectedOnce = await milkTea.autoHire([1300000311], { duration: 1 });
        check('1034130 自动雇佣继续候选并保留最终业务错误',
            rejectedOnce.ok === false && rejectedOnce.attempted === 3
            && rejectedOnce.errorCode === 1034130 && rejectedOnceAttempts === 3
            && sent.map((x) => x.cmd).join(',') === '55,56,57,56,57,56,57', {
                result: rejectedOnce,
                sent: sent.map((x) => x.cmd),
            });

        let mixedFailureAttempts = 0;
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                mixedFailureAttempts += 1;
                return operateReply(57, {
                    errorCode: mixedFailureAttempts === 1 ? 1034140 : 1034141,
                    result: Buffer.alloc(0),
                    resultField: 162,
                });
            }
            throw new Error(`混合失败用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const mixedFailure = await milkTea.autoHire([1300000311], { duration: 1 });
        check('好友与系统员工均失败时返回最后一个真实服务端错误',
            mixedFailure.ok === false && mixedFailure.attempted === 2
            && mixedFailure.errorCode === 1034141 && mixedFailureAttempts === 2
            && mixedFailure.results.filter((x) => !x.skipped).map((x) => x.errorCode).join(',') === '1034140,1034141',
            { result: mixedFailure, sent: sent.map((x) => x.cmd) });

        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                rejectedOnceAttempts += 1;
                return operateReply(57, { errorCode: 1034130, result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`批量 1034130 用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        rejectedOnceAttempts = 0;
        const batchRejectedOnce = await milkTea.hireAll([1300000311]);
        check('1034130 批量雇佣继续候选并保留最终业务错误',
            batchRejectedOnce.ok === false && batchRejectedOnce.attempted === 3
            && batchRejectedOnce.errorCode === 1034130 && rejectedOnceAttempts === 3
            && sent.filter((x) => x.cmd === 57).length === 3, {
                result: batchRejectedOnce,
                sent: sent.map((x) => x.cmd),
            });

        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                exhaustedAttempts += 1;
                return operateReply(57, { errorCode: 1034130, result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`候选重试上限用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const exhausted = await milkTea.hireAll([1300000020, 1300000021, 1300000022, 1300000023, 1300000024]);
        check('批量雇佣遍历 1034130 候选并保留错误码',
            exhausted.ok === false && exhausted.hired === 0
            && exhausted.attempted === 3 && exhaustedAttempts === 3
            && exhausted.errorCode === 1034130
            && /code=1034130/.test(exhausted.reason || ''), {
                result: exhausted,
                sent: sent.map((x) => x.cmd),
            });

        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees: [] }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) return operateReply(56, {
                result: employeePanelResult({
                    friends: [hireCandidateFriend({ gid: 1300000311 })],
                    staff: [hireCandidateStaff({ gid: 101 }), hireCandidateStaff({ gid: 102 })],
                }),
                resultField: 161,
            });
            if (req.cmd === 57) {
                return operateReply(57, { errorCode: 1034140, result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`批量首错用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const batchRejected = await milkTea.hireAll([1300000012, 1300000013]);
        check('批量雇佣遇到 1034140 后继续候选并保留错误码',
            batchRejected.ok === false && batchRejected.hired === 0
            && batchRejected.attempted === 3 && batchRejected.errorCode === 1034140
            && sent.filter((x) => x.cmd === 57).length === 3
            && /code=1034140/.test(batchRejected.reason || ''), {
                result: batchRejected,
                sent: sent.map((x) => x.cmd),
            });
    }

    section('18. cmd62 请求上限、15 UID 拆分、失败隔离与多字节 packed 长度');
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

        sent.length = 0;
        batches.length = 0;
        const cappedLogStart = activityLogs.length;
        const capped = await milkTea.__testing.craftAllFruits(3, 1);
        const cappedLogs = activityLogs.slice(cappedLogStart).map((x) => x.msg).join('\n');
        check('maxBatches=1 时实际只发送一个 cmd62，单 UID 回退也不能越界',
            batches.length === 1 && capped.batches === 1
            && capped.used === 3 && capped.partial === true,
            { result: capped, batches });
        check('达到请求上限时日志准确报告成功、失败和未处理 UID',
            /成功 3 个 UID，失败 0 个，未处理 13 个（达到本次请求上限）/.test(cappedLogs), cappedLogs);

        const originalItems = warehouse.getBagItems;
        warehouse.getBagItems = () => bagUids.slice(0, 6)
            .map((uid) => ({ id: 40525, uid, count: 1 }));
        sent.length = 0;
        batches.length = 0;
        let networkFailureSingles = 0;
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                batches.push(requestUids);
                return operateReply(62, {
                    errorCode: 1034130,
                    result: Buffer.alloc(0),
                    resultField: 167,
                });
            }
            throw new Error(`非未解锁业务错误用例收到 cmd=${req.cmd}`);
        };
        const nonLockedLogStart = activityLogs.length;
        const nonLockedFailure = await milkTea.__testing.craftAllFruits(3, 10);
        const nonLockedLogs = activityLogs.slice(nonLockedLogStart).map((x) => x.msg).join('\n');
        check('非 1034149 业务错误只发送首个 cmd62，不重试也不继续后续批次',
            nonLockedFailure.ok === false && nonLockedFailure.errorCode === 1034130
            && nonLockedFailure.batches === 1 && nonLockedFailure.failedUids.length === 3
            && batches.length === 1 && batches[0].length === 3,
            { result: nonLockedFailure, batches });
        check('整批失败后日志补报因停止而未处理的 UID',
            /成功 0 个 UID，失败 3 个，未处理 3 个（请求异常后停止）/.test(nonLockedLogs), nonLockedLogs);

        batches.length = 0;
        const manualBatchLogStart = activityLogs.length;
        const manualBatchFailure = await milkTea.craftMilkTea(3);
        const manualBatchLogs = activityLogs.slice(manualBatchLogStart).map((x) => x.msg).join('\n');
        check('手动制作整批失败时日志报告全部已尝试 UID',
            manualBatchFailure.ok === false && manualBatchFailure.failedUids.length === 3
            && /成功 0 个 UID，失败 3 个，未处理 0 个/.test(manualBatchLogs),
            { result: manualBatchFailure, logs: manualBatchLogs });

        warehouse.getBagItems = () => bagUids.slice(0, 3)
            .map((uid) => ({ id: 40525, uid, count: 1 }));
        sent.length = 0;
        batches.length = 0;
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                batches.push(requestUids);
                if (requestUids.length > 1) {
                    return operateReply(62, {
                        errorCode: 1034149,
                        result: Buffer.alloc(0),
                        resultField: 167,
                    });
                }
                networkFailureSingles += 1;
                if (networkFailureSingles === 2) {
                    throw new Error('socket closed while crafting');
                }
                return operateReply(62, { result: craftResult(requestUids), resultField: 167 });
            }
            throw new Error(`单 UID 网络异常用例收到 cmd=${req.cmd}`);
        };
        const networkLogStart = activityLogs.length;
        const networkFailure = await milkTea.__testing.craftAllFruits(3, 10);
        const networkLogs = activityLogs.slice(networkLogStart).map((x) => x.msg).join('\n');
        check('单 UID 网络异常后立即停止，不再提交剩余 UID',
            batches.length === 3
            && batches[0].length === 3
            && batches[1].join(',') === String(bagUids[0])
            && batches[2].join(',') === String(bagUids[1]),
            batches);
        check('网络异常覆盖旧批量业务错误并显示真实原因',
            networkFailure.ok === true && networkFailure.partial === true
            && networkFailure.used === 1 && /socket closed/.test(networkFailure.failureReason || '')
            && !/1034149/.test(networkFailure.failureReason || ''),
            networkFailure);
        check('逐 UID 重试中断时日志报告失败和未处理数量',
            /成功 1 个 UID，失败 1 个，未处理 1 个（请求异常后停止）/.test(networkLogs), networkLogs);

        warehouse.getBagItems = () => bagUids.slice(0, 3)
            .map((uid) => ({ id: 40525, uid, count: 1 }));
        batches.length = 0;
        let laterBatchRequests = 0;
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                batches.push(requestUids);
                laterBatchRequests += 1;
                if (laterBatchRequests === 1) {
                    return operateReply(62, {
                        errorCode: 1034149,
                        result: Buffer.alloc(0),
                        resultField: 167,
                    });
                }
                if (laterBatchRequests === 2) {
                    return operateReply(62, { result: craftResult(requestUids), resultField: 167 });
                }
                throw new Error('socket closed in later craft batch');
            }
            throw new Error(`后续批次网络异常用例收到 ${req.cmd}`);
        };
        const laterNetworkFailure = await milkTea.__testing.craftAllFruits(1, 10);
        check('后续批次网络异常时终止错误码覆盖先前未解锁错误',
            laterNetworkFailure.ok === true && laterNetworkFailure.partial === true
            && laterNetworkFailure.used === 1
            && /socket closed in later craft batch/.test(laterNetworkFailure.failureReason || '')
            && !/1034149/.test(laterNetworkFailure.failureReason || ''), laterNetworkFailure);
        warehouse.getBagItems = originalItems;

        sent.length = 0;
        batches.length = 0;
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                batches.push(requestUids);
                if (requestUids.length > 1) {
                    return operateReply(62, {
                        errorCode: 1034149,
                        result: Buffer.alloc(0),
                        resultField: 167,
                    });
                }
                if (requestUids[0] === bagUids[0]) {
                    return operateReply(62, {
                        errorCode: 1034149,
                        result: Buffer.alloc(0),
                        resultField: 167,
                    });
                }
                return operateReply(62, { result: craftResult(requestUids), resultField: 167 });
            }
            throw new Error(`整批失败回退用例收到 cmd=${req.cmd}`);
        };
        const isolated = await milkTea.__testing.craftAllFruits(3, 4);
        check('整批业务失败后逐 UID 重试并保留成功项',
            isolated.ok === true && isolated.partial === true
            && isolated.used === 2 && isolated.batches === 4
            && isolated.made.length === 2
            && isolated.failedUids.length === 1 && isolated.failedUids[0] === bagUids[0]
            && batches.map((uids) => uids.join(',')).join('|') === [
                bagUids.slice(0, 3).join(','),
                String(bagUids[0]),
                String(bagUids[1]),
                String(bagUids[2]),
            ].join('|'), { result: isolated, batches });
        check('整批失败回退保留服务端业务错误码',
            isolated.errorCode === 1034149 && /1034149/.test(isolated.failureReason || ''),
            isolated);

        warehouse.getBagItems = () => bagUids.slice(0, 3)
            .map((uid) => ({ id: 40525, uid, count: 1 }));
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                batches.push(requestUids);
                if (requestUids.length > 1) {
                    throw new Error('gamepb.activitypb.ActivityService.Operate 错误: code=1034149 该配方尚未解锁');
                }
                return operateReply(62, { result: craftResult(requestUids), resultField: 167 });
            }
            throw new Error(`抛异常业务码回退用例收到 cmd=${req.cmd}`);
        };
        batches.length = 0;
        const thrownBusiness = await milkTea.__testing.craftAllFruits(3, 10);
        check('网络层抛出的 code=1034149 仍按业务错误逐 UID 回退',
            thrownBusiness.ok === true && thrownBusiness.used === 3
            && thrownBusiness.batches === 4 && batches.length === 4
            && thrownBusiness.failedUids.length === 0, {
                result: thrownBusiness,
                batches,
            });

        warehouse.getBagItems = () => bagUids.slice(0, 3)
            .map((uid) => ({ id: 40525, uid, count: 1 }));
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                batches.push(requestUids);
                if (requestUids[0] === bagUids[0]) {
                    return operateReply(62, {
                        errorCode: 1034149,
                        result: Buffer.alloc(0),
                        resultField: 167,
                    });
                }
                return operateReply(62, { result: craftResult(requestUids), resultField: 167 });
            }
            throw new Error(`单 UID 未解锁继续用例收到 cmd=${req.cmd}`);
        };
        batches.length = 0;
        const singleLocked = await milkTea.__testing.craftAllFruits(1, 10);
        check('单 UID 批次遇到 1034149 后继续后续可制作批次',
            singleLocked.ok === true && singleLocked.used === 2
            && singleLocked.batches === 3 && singleLocked.failedUids.length === 1
            && singleLocked.failedUids[0] === bagUids[0], {
                result: singleLocked,
                batches,
            });

        warehouse.getBagItems = () => bagUids.slice(0, 3)
            .map((uid) => ({ id: 40525, uid, count: 1 }));
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                batches.push(requestUids);
                if (requestUids.length > 1 || requestUids[0] === bagUids[0]) {
                    return operateReply(62, {
                        errorCode: 1034149,
                        result: Buffer.alloc(0),
                        resultField: 167,
                    });
                }
                return operateReply(62, { result: craftResult(requestUids), resultField: 167 });
            }
            throw new Error(`手动制作回退用例收到 cmd=${req.cmd}`);
        };
        batches.length = 0;
        const manualFallbackLogStart = activityLogs.length;
        const manualFallback = await milkTea.craftMilkTea(3);
        const manualFallbackLogs = activityLogs.slice(manualFallbackLogStart).map((x) => x.msg).join('\n');
        check('手动制作入口同样隔离 1034149 并保留成功项',
            manualFallback.ok === true && manualFallback.partial === true
            && manualFallback.used === 2 && manualFallback.failedUids.length === 1
            && manualFallback.batches === 4, {
                result: manualFallback,
                batches,
            });
        check('手动制作逐 UID 完成时日志报告失败项且未处理为 0',
            /成功 2 个 UID，失败 1 个，未处理 0 个/.test(manualFallbackLogs), manualFallbackLogs);

        batches.length = 0;
        let manualNetworkSingles = 0;
        router = async (req) => {
            if (req.cmd === 58) {
                return operateReply(58, {
                    result: menuResult([{ id: 2, name: '甜莓奶茶', unlocked: true }]),
                    resultField: 163,
                });
            }
            if (req.cmd === 62) {
                const payload = mg.parseTop(req.payload);
                const requestUids = parsePackedVarints((payload.find((x) => x.f === 1) || {}).v);
                batches.push(requestUids);
                if (requestUids.length > 1) {
                    return operateReply(62, {
                        errorCode: 1034149,
                        result: Buffer.alloc(0),
                        resultField: 167,
                    });
                }
                manualNetworkSingles += 1;
                if (manualNetworkSingles === 2) {
                    throw new Error('socket closed during manual craft retry');
                }
                return operateReply(62, { result: craftResult(requestUids), resultField: 167 });
            }
            throw new Error(`手动制作网络异常用例收到 cmd=${req.cmd}`);
        };
        const manualNetworkLogStart = activityLogs.length;
        const manualNetworkFailure = await milkTea.craftMilkTea(3);
        const manualNetworkLogs = activityLogs.slice(manualNetworkLogStart).map((x) => x.msg).join('\n');
        check('手动制作逐 UID 中断时返回失败与未处理 UID',
            manualNetworkFailure.ok === true && manualNetworkFailure.partial === true
            && manualNetworkFailure.used === 1 && manualNetworkFailure.failedUids.length === 1
            && manualNetworkFailure.unprocessedUids.length === 1,
            { result: manualNetworkFailure, batches });
        check('手动制作逐 UID 中断时日志报告完整三类计数',
            /成功 1 个 UID，失败 1 个，未处理 1 个（请求异常后停止）/.test(manualNetworkLogs), manualNetworkLogs);

        warehouse.getBagItems = originalItems;
        warehouse.getBag = originalGetBag;
        warehouse.getBagItems = originalGetBagItems;
        milkTea.__testing.clearMenuCache();
    }

    section('19. 店铺排行榜 cmd66/#171 页码、本人排名与好友标记');
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

    section('20. 活动 List 快照、商店已购/限购与店铺升级奖励');
    {
        const fixedNow = Date.UTC(2026, 9, 19, 4, 0, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '活动快照测试店'),
            varintField(4, 3),
            varintField(5, 45678),
            varintField(16, 1792203600),
        ]);
        const snapshotGoods = [
            shopGoods({
                goodsId: 301,
                itemId: 20525,
                limitCount: 108,
                purchasedCount: 108,
                restrictionType: 4,
                name: '森野甜莓种子',
            }),
            shopGoods({
                goodsId: 308,
                itemId: 29005,
                limitCount: 1,
                purchasedCount: 1,
                restrictionType: 1,
                name: '森野黄金芽种子',
            }),
            shopGoods({
                goodsId: 311,
                itemId: 20525,
                limitCount: 0,
                purchasedCount: 0,
                name: '不限购测试商品',
            }),
        ];
        router = async (req) => {
            if (req.method === 'List') {
                return activityListReply([
                    mainActivity(state),
                    shopActivity(snapshotGoods),
                    taskActivity({
                        tasks: [
                            taskEntry({
                                id: 9001,
                                status: 2,
                                conditionText: '累计制作 3 杯奶茶',
                                conditionType: 7,
                                taskIndex: 4,
                                conditionValue: 3,
                                rewards: [{ id: 1041, count: 50 }],
                            }),
                            taskEntry({
                                id: 9002,
                                status: 1,
                                conditionText: '尚未开始的任务',
                                conditionType: 8,
                                taskIndex: 5,
                                conditionValue: 0,
                            }),
                        ],
                    }),
                ]);
            }
            throw new Error(`活动快照用例不应发送 ${req.method || `cmd=${req.cmd}`}`);
        };

        sent.length = 0;
        const main = await milkTea.getMainStatus(true);
        const shop = await milkTea.getShopGoods();
        const tasks = await milkTea.getTasks();
        check('主店/商店/升级奖励连续读取只发送一次 ActivityService.List',
            main.ok === true && shop.ok === true && tasks.ok === true
            && sent.filter((x) => x.method === 'List').length === 1,
            sent.map((x) => x.method || x.cmd));

        const goods301 = shop.goods.find((x) => x.goodsId === 301);
        const goods308 = shop.goods.find((x) => x.goodsId === 308);
        const goods311 = shop.goods.find((x) => x.goodsId === 311);
        check('商店 #4/#5/#11 映射为 limitCount/purchasedCount/restrictionType',
            goods301.limitCount === 108 && goods301.purchasedCount === 108
            && goods301.boughtCount === 108 && goods301.restrictionType === 4
            && goods308.limitCount === 1 && goods308.purchasedCount === 1
            && goods308.boughtCount === 1 && goods308.restrictionType === 1,
            { goods301, goods308 });
        check('服务端已购数达到限购时直接标记 soldOut',
            goods301.soldOut === true && goods308.soldOut === true
            && goods311.soldOut === false, [goods301, goods308, goods311]);

        check('升级奖励档位与奖励明细完整解析',
            tasks.kind === 'store-upgrade-rewards'
            && tasks.tasks[0].level === 9001
            && tasks.tasks[0].rewards[0].id === 1041
            && tasks.tasks[0].rewards[0].count === 50,
            tasks.tasks[0]);
        check('升级奖励内部条件字段完整保留',
            tasks.tasks[0].conditionText === '累计制作 3 杯奶茶'
            && tasks.tasks[0].conditionType === 7
            && tasks.tasks[0].taskIndex === 4
            && tasks.tasks[0].conditionValue === 3
            && tasks.tasks[0].conditionMet === null,
            tasks.tasks[0]);
        check('升级奖励内部条件参数不冒充当前完成状态',
            tasks.tasks[1].conditionValue === 0 && tasks.tasks[1].conditionMet === null,
            tasks.tasks[1]);

        sent.length = 0;
        const skippedSoldOut = await milkTea.buyShopGoods(308, 1);
        check('已售罄商品在购买前直接跳过且不发送 Operate',
            skippedSoldOut.ok === false && skippedSoldOut.skipped === true
            && skippedSoldOut.soldOut === true && sent.length === 0,
            { result: skippedSoldOut, sent: sent.map((x) => x.method || x.cmd) });
    }

    {
        const fixedNow = Date.UTC(2026, 9, 19, 4, 0, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '增量测试店'),
            varintField(4, 3),
        ]);
        let serverPurchased = 0;
        router = async (req) => {
            if (req.method === 'List') {
                return activityListReply([
                    mainActivity(state),
                    shopActivity([
                        shopGoods({
                            goodsId: 311,
                            itemId: 20525,
                            limitCount: 4,
                            purchasedCount: serverPurchased,
                            restrictionType: 1,
                            name: '增量测试商品',
                        }),
                    ]),
                ]);
            }
            if (req.cmd === 1 && req.group === GROUP_SHOP) {
                const payload = mg.parseTop(req.payload);
                const count = toInt((payload.find((x) => x.f === 2) || {}).v);
                return operateReply(1, {
                    group: GROUP_SHOP,
                    result: Buffer.concat([
                        bytesField(1, Buffer.concat([varintField(1, 20525), varintField(2, count)])),
                        bytesField(2, Buffer.concat([varintField(1, 1041), varintField(2, count * 100)])),
                    ]),
                    resultField: 101,
                });
            }
            throw new Error(`商店增量用例收到 ${req.method || `cmd=${req.cmd}`}`);
        };

        sent.length = 0;
        const bought = await milkTea.buyShopGoods(311, 2);
        const staleSnapshot = await milkTea.getShopGoods();
        const staleGoods = staleSnapshot.goods.find((x) => x.goodsId === 311);
        check('购买成功后使用 max(服务端 #5, 本地增量) 防止旧快照回退',
            bought.ok === true && staleGoods.purchasedCount === 0
            && staleGoods.boughtCount === 2 && staleGoods.soldOut === false,
            { bought, staleGoods });
        check('购买后复用当前 List 快照，不立即重复请求',
            sent.filter((x) => x.method === 'List').length === 1
            && sent.filter((x) => x.group === GROUP_SHOP && x.cmd === 1).length === 1,
            sent.map((x) => x.method || `cmd=${x.cmd}`));

        serverPurchased = 3;
        milkTea.__testing.clearMainStatusCache();
        const refreshed = await milkTea.getShopGoods();
        const refreshedGoods = refreshed.goods.find((x) => x.goodsId === 311);
        check('服务端已购数高于本地增量时采用服务端值',
            refreshedGoods.purchasedCount === 3 && refreshedGoods.boughtCount === 3,
            refreshedGoods);
        check('购买失效缓存后下一次读取重新发送 List',
            sent.filter((x) => x.method === 'List').length === 2,
            sent.map((x) => x.method || `cmd=${x.cmd}`));

        sent.length = 0;
        const truncated = await milkTea.buyShopGoods(311, 2);
        const truncatedReq = sent.find((x) => x.group === GROUP_SHOP && x.cmd === 1);
        const truncatedPayload = truncatedReq && mg.parseTop(truncatedReq.payload);
        const truncatedCount = toInt((truncatedPayload || []).find((x) => x.f === 2)?.v);
        check('剩余限购为 1 时请求数量从 2 截断为 1',
            truncated.ok === true && truncated.count === 1 && truncatedCount === 1
            && truncated.got && truncated.got.count === 1, {
                result: truncated,
                sent: sent.map((x) => ({ cmd: x.cmd, payload: x.payload && x.payload.toString('hex') })),
            });

        milkTea.__testing.setShopClock(() => fixedNow + 24 * 60 * 60 * 1000);
        serverPurchased = 0;
        const nextDay = await milkTea.getShopGoods();
        const nextDayGoods = nextDay.goods.find((x) => x.goodsId === 311);
        check('北京时间跨日后清空日限额商品本地已购与售罄状态',
            nextDayGoods.purchasedCount === 0 && nextDayGoods.boughtCount === 0
            && nextDayGoods.soldOut === false, nextDayGoods);
    }

    {
        const fixedNow = Date.UTC(2026, 9, 19, 5, 0, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '实际成交测试店'),
            varintField(4, 3),
        ]);
        router = async (req) => {
            if (req.method === 'List') {
                return activityListReply([
                    mainActivity(state),
                    shopActivity([
                        shopGoods({
                            goodsId: 312,
                            itemId: 20526,
                            limitCount: 5,
                            purchasedCount: 0,
                            name: '实际成交测试商品',
                        }),
                    ]),
                ]);
            }
            if (req.cmd === 1 && req.group === GROUP_SHOP) {
                return operateReply(1, {
                    group: GROUP_SHOP,
                    result: Buffer.concat([
                        bytesField(1, Buffer.concat([varintField(1, 20526), varintField(2, 1)])),
                        bytesField(2, Buffer.concat([varintField(1, 1041), varintField(2, 100)])),
                    ]),
                    resultField: 101,
                });
            }
            throw new Error(`实际成交用例收到 ${req.method || `cmd=${req.cmd}`}`);
        };
        sent.length = 0;
        const partialBought = await milkTea.buyShopGoods(312, 2);
        const staleSnapshot = await milkTea.getShopGoods();
        const staleGoods = staleSnapshot.goods.find((x) => x.goodsId === 312);
        check('服务端实际成交少于请求量时返回实际数量并据此记账',
            partialBought.ok === true && partialBought.count === 1
            && partialBought.got && partialBought.got.count === 1
            && staleGoods.boughtCount === 1,
            { result: partialBought, staleGoods });
        milkTea.__testing.setShopClock(() => Date.now());
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
    }

    section('21. 森野系列种子自动购买');
    {
        const fixedNow = Date.UTC(2026, 9, 19, 6, 0, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.resetStoreLevelHint();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '森野自动购买测试店'),
            varintField(4, 15),
        ]);
        const seedGoods = [
            { goodsId: 301, itemId: 20525, currencyId: 1001, unitPrice: 10000, limitCount: 108, requireLevel: 0, name: '森野甜莓种子' },
            { goodsId: 302, itemId: 20526, currencyId: 1001, unitPrice: 10000, limitCount: 108, requireLevel: 3, name: '森野白桃种子' },
            { goodsId: 303, itemId: 20527, currencyId: 1001, unitPrice: 10000, limitCount: 108, requireLevel: 5, name: '森野甜橙种子' },
            { goodsId: 304, itemId: 20528, currencyId: 1001, unitPrice: 10000, limitCount: 108, requireLevel: 7, name: '森野红柚种子' },
            { goodsId: 305, itemId: 20021, currencyId: 1001, unitPrice: 10000, limitCount: 108, requireLevel: 9, name: '森野可可豆种子' },
            { goodsId: 306, itemId: 21435, currencyId: 1001, unitPrice: 20000, limitCount: 108, requireLevel: 11, name: '森野柿子种子' },
            { goodsId: 307, itemId: 20529, currencyId: 1001, unitPrice: 20000, limitCount: 36, requireLevel: 13, name: '森野芭乐种子' },
            { goodsId: 308, itemId: 29005, currencyId: 1041, unitPrice: 8000, limitCount: 1, requireLevel: 0, name: '森野黄金芽种子' },
        ];
        const byGoodsId = new Map(seedGoods.map((g) => [g.goodsId, g]));
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [
                { id: 1001, count: 100000 },
                { id: 1041, count: 8000 },
            ];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(state),
                        shopActivity(seedGoods.map((g) => shopGoods({
                            ...g,
                            purchasedCount: 0,
                            conditionText: g.requireLevel ? `店铺等级` : '',
                        }))),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    const payload = mg.parseTop(req.payload);
                    const goodsId = toInt((payload.find((x) => x.f === 1) || {}).v);
                    const count = toInt((payload.find((x) => x.f === 2) || {}).v);
                    const target = byGoodsId.get(goodsId);
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        result: Buffer.concat([
                            bytesField(1, Buffer.concat([
                                varintField(1, target.itemId),
                                varintField(2, count),
                            ])),
                            bytesField(2, Buffer.concat([
                                varintField(1, target.currencyId),
                                varintField(2, target.unitPrice * count),
                            ])),
                        ]),
                        resultField: 101,
                    });
                }
                throw new Error(`森野 8 种购买用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            activityLogs.length = 0;
            sent.length = 0;
            const boughtAll = await milkTea.buyDailySeeds(1);
            const shop = await milkTea.getShopGoods();
            const goods302 = shop.goods.find((g) => g.goodsId === 302);
            const buyRequests = sent.filter((x) => x.cmd === 1 && x.group === GROUP_SHOP);
            const requestedGoodsIds = buyRequests.map((x) => {
                const payload = mg.parseTop(x.payload);
                return toInt((payload.find((y) => y.f === 1) || {}).v);
            });
            const balances = await milkTea.getCurrencyBalances();
            check('8 种森野种子均按设置份数购买',
                boughtAll.ok === true && boughtAll.boughtCount === 8
                && boughtAll.bought.length === 8 && buyRequests.length === 8
                && requestedGoodsIds.join(',') === '301,302,303,304,305,306,307,308',
                { result: boughtAll, requestedGoodsIds });
            check('真实抓包中缺少 #13.#3 时 302~307 不会被误判未解锁',
                goods302.unlocked === true && goods302.requireLevel === 3,
                goods302);
            check('金币与奶茶券按实际成交在本轮内扣减',
                boughtAll.spentGold === 90000 && boughtAll.spentCoupon === 8000
                && balances.gold === 10000 && balances.milkCoupon === 0,
                { result: boughtAll, balances });
            check('8 种购买汇总为一条活动日志',
                activityLogs.filter((x) => /森野种子自动购买/.test(x.msg)).length === 1
                && activityLogs.some((x) => /8 种\/8 份/.test(x.msg)),
                activityLogs.map((x) => x.msg));

            sent.length = 0;
            const alreadyComplete = await milkTea.buyDailySeeds(1);
            check('旧 List 快照下也不会重复购买同一天已补齐的种子',
                alreadyComplete.boughtCount === 0 && alreadyComplete.skipped === true
                && sent.filter((x) => x.cmd === 1 && x.group === GROUP_SHOP).length === 0,
                { result: alreadyComplete, sent: sent.map((x) => x.method || x.cmd) });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    section('22. 自动购种刷新升级后的店铺等级');
    {
        const defaultAutoBuySeed = store.getMilkTeaConfig(process.env.FARM_ACCOUNT_ID).autoBuySeed;
        store.applyConfigSnapshot(
            { milkTeaAutoBuySeed: true, milkTeaSeedBuyCount: 3 },
            { persist: false, accountId: process.env.FARM_ACCOUNT_ID },
        );
        const savedAutoBuyConfig = store.getMilkTeaConfig(process.env.FARM_ACCOUNT_ID);
        check('自动购种开关和每种份数保存后可正确读回',
            defaultAutoBuySeed === false
            && savedAutoBuyConfig.autoBuySeed === true
            && savedAutoBuyConfig.seedBuyCount === 3,
            { defaultAutoBuySeed, savedAutoBuyConfig });

        const fixedNow = Date.UTC(2026, 9, 19, 10, 0, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        let level = 8;
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [{ id: 1001, count: 100000 }];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(Buffer.concat([
                            varintField(1, 1792200000),
                            bytesField(2, '森野升级购种测试店'),
                            varintField(4, level),
                        ])),
                        shopActivity([
                            shopGoods({
                                goodsId: 305,
                                itemId: 20021,
                                currencyId: 1001,
                                unitPrice: 10000,
                                limitCount: 108,
                                requireLevel: 9,
                                name: '森野可可豆种子',
                            }),
                        ]),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    const payload = mg.parseTop(req.payload);
                    const goodsId = toInt((payload.find((x) => x.f === 1) || {}).v);
                    const count = toInt((payload.find((x) => x.f === 2) || {}).v);
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        result: Buffer.concat([
                            bytesField(1, Buffer.concat([
                                varintField(1, goodsId === 305 ? 20021 : 0),
                                varintField(2, count),
                            ])),
                            bytesField(2, Buffer.concat([
                                varintField(1, 1001),
                                varintField(2, count * 10000),
                            ])),
                        ]),
                        resultField: 101,
                    });
                }
                throw new Error(`自动购种升级刷新用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            const cachedLevel8 = await milkTea.getMainStatus(true);
            level = 9;
            sent.length = 0;
            const out = await milkTea.runMilkTea({
                cashier: false,
                craft: false,
                speaker: false,
                autoInteract: false,
                autoUpgrade: false,
                autoWage: false,
                autoHire: false,
                autoBuySeed: true,
                seedBuyCount: 1,
            });
            const listCalls = sent.filter((x) => x.method === 'List').length;
            const buyRequests = sent
                .filter((x) => x.cmd === 1 && x.group === GROUP_SHOP)
                .map((x) => {
                    const payload = mg.parseTop(x.payload);
                    return {
                        goodsId: toInt((payload.find((y) => y.f === 1) || {}).v),
                        count: toInt((payload.find((y) => y.f === 2) || {}).v),
                    };
                });
            const buyStep = out.steps.find((x) => x.step === 'buyDailySeeds');
            check('自动购种会重新读取店铺状态，升级到 Lv9 后立即购买新解锁种子',
                cachedLevel8.ok === true && cachedLevel8.storeLevel === 8
                && listCalls >= 2 && buyStep && buyStep.boughtCount === 1
                && JSON.stringify(buyRequests) === JSON.stringify([{ goodsId: 305, count: 1 }]), {
                    cachedLevel8,
                    listCalls,
                    buyRequests,
                    out,
                });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.setShopClock(() => Date.now());
            milkTea.__testing.resetShopState();
            milkTea.__testing.resetStoreLevelHint();
            milkTea.__testing.clearMainStatusCache();
            milkTea.__testing.resetCurrencyCache();
        }
    }

    section('23. 升级响应等级兜底旧商店快照');
    {
        const fixedNow = Date.UTC(2026, 9, 19, 10, 30, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.resetStoreLevelHint();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        let listedLevel = 8;
        const buyRequests = [];
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [{ id: 1001, count: 100000 }];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(Buffer.concat([
                            varintField(1, 1792200000),
                            bytesField(2, '升级响应等级兜底测试店'),
                            varintField(4, listedLevel),
                        ])),
                        shopActivity([
                            shopGoods({
                                goodsId: 305,
                                itemId: 20021,
                                currencyId: 1001,
                                unitPrice: 10000,
                                limitCount: 108,
                                requireLevel: 9,
                                name: '森野可可豆种子',
                            }),
                        ]),
                    ]);
                }
                if (req.cmd === 55) {
                    return operateReply(55, {
                        result: cashierDetailResult({
                            level: listedLevel,
                            revenue: 100000,
                            nextLevelRevenue: 50000,
                        }),
                        resultField: 160,
                    });
                }
                if (req.cmd === 61) {
                    return operateReply(61, {
                        result: varintField(1, 9),
                        resultField: 166,
                    });
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    const payload = mg.parseTop(req.payload);
                    const goodsId = toInt((payload.find((x) => x.f === 1) || {}).v);
                    const count = toInt((payload.find((x) => x.f === 2) || {}).v);
                    buyRequests.push({ goodsId, count });
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        result: Buffer.concat([
                            bytesField(1, Buffer.concat([
                                varintField(1, 20021),
                                varintField(2, count),
                            ])),
                            bytesField(2, Buffer.concat([
                                varintField(1, 1001),
                                varintField(2, count * 10000),
                            ])),
                        ]),
                        resultField: 101,
                    });
                }
                throw new Error(`升级响应等级兜底用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            const commonOpts = {
                cashier: false,
                craft: false,
                speaker: false,
                autoInteract: false,
                autoWage: false,
                autoHire: false,
                autoBuySeed: true,
                seedBuyCount: 1,
            };
            const firstRun = await milkTea.runMilkTea({ ...commonOpts, autoUpgrade: true });
            const firstBuy = firstRun.steps.find((x) => x.step === 'buyDailySeeds');
            const upgrade = firstRun.steps.find((x) => x.step === 'upgradeStore');
            listedLevel = 8;
            const secondRun = await milkTea.runMilkTea({ ...commonOpts, autoUpgrade: false });
            const secondBuy = secondRun.steps.find((x) => x.step === 'buyDailySeeds');
            check('升级响应明确 Lv9 但后续 List 仍为 Lv8 时，下一轮仍立即购买新解锁种子',
                firstBuy && firstBuy.boughtCount === 0
                && upgrade && upgrade.ok === true && upgrade.level === 9
                && secondBuy && secondBuy.boughtCount === 1
                && JSON.stringify(buyRequests) === JSON.stringify([{ goodsId: 305, count: 1 }]), {
                    listedLevel,
                    buyRequests,
                    firstBuy,
                    upgrade,
                    secondBuy,
                });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.setShopClock(() => Date.now());
            milkTea.__testing.resetShopState();
            milkTea.__testing.resetStoreLevelHint();
            milkTea.__testing.clearMainStatusCache();
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        let now = Date.UTC(2026, 9, 19, 6, 0, 0);
        milkTea.__testing.setShopClock(() => now);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '森野跨日限额测试店'),
            varintField(4, 15),
        ]);
        const goods = [
            { goodsId: 301, itemId: 20525, currencyId: 1001, unitPrice: 10000, limitCount: 108, restrictionType: 4, name: '森野甜莓种子' },
            { goodsId: 307, itemId: 20529, currencyId: 1001, unitPrice: 20000, limitCount: 36, restrictionType: 1, name: '森野芭乐种子' },
        ];
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [{ id: 1001, count: 100000 }];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(state),
                        // 模拟跨日后仍返回已购数为 0 的旧 List 快照。
                        shopActivity(goods.map((g) => shopGoods({ ...g, purchasedCount: 0 }))),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    const payload = mg.parseTop(req.payload);
                    const goodsId = toInt((payload.find((x) => x.f === 1) || {}).v);
                    const count = toInt((payload.find((x) => x.f === 2) || {}).v);
                    const target = goods.find((g) => g.goodsId === goodsId);
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        result: Buffer.concat([
                            bytesField(1, Buffer.concat([
                                varintField(1, target.itemId),
                                varintField(2, count),
                            ])),
                            bytesField(2, Buffer.concat([
                                varintField(1, target.currencyId),
                                varintField(2, target.unitPrice * count),
                            ])),
                        ]),
                        resultField: 101,
                    });
                }
                throw new Error(`森野跨日限额用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            const firstDay = await milkTea.buyDailySeeds(1);
            now = Date.UTC(2026, 9, 19, 16, 1, 0); // 北京时间次日 00:01
            const staleAfterMidnight = await milkTea.getShopGoods();
            const permanent = staleAfterMidnight.goods.find((x) => x.goodsId === 301);
            const daily = staleAfterMidnight.goods.find((x) => x.goodsId === 307);
            check('北京时间跨日后每日限额清零，永久限额与旧快照防重记录保留',
                firstDay.boughtCount === 2
                && permanent && permanent.boughtCount === 1
                && daily && daily.boughtCount === 0,
                { firstDay, permanent, daily });

            sent.length = 0;
            const secondDay = await milkTea.buyDailySeeds(1);
            const requestedGoodsIds = sent
                .filter((x) => x.cmd === 1 && x.group === GROUP_SHOP)
                .map((x) => {
                    const payload = mg.parseTop(x.payload);
                    return toInt((payload.find((y) => y.f === 1) || {}).v);
                });
            check('跨日后只补购日限额商品，永久限额商品不会再次购买',
                secondDay.boughtCount === 1 && requestedGoodsIds.join(',') === '307',
                { result: secondDay, requestedGoodsIds });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        let now = Date.UTC(2026, 9, 19, 6, 30, 0);
        milkTea.__testing.setShopClock(() => now);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '森野跨日售罄测试店'),
            varintField(4, 15),
        ]);
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [{ id: 1001, count: 100000 }];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(state),
                        shopActivity([
                            shopGoods({ goodsId: 301, itemId: 20525, currencyId: 1001, unitPrice: 10000, limitCount: 108, restrictionType: 4, name: '森野甜莓种子' }),
                            shopGoods({ goodsId: 307, itemId: 20529, currencyId: 1001, unitPrice: 20000, limitCount: 36, restrictionType: 1, name: '森野芭乐种子' }),
                        ]),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        errorCode: 1034007,
                        result: null,
                        resultField: 101,
                    });
                }
                throw new Error(`森野跨日售罄用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            await milkTea.buyDailySeeds(1);
            const soldOutBeforeMidnight = await milkTea.getShopGoods();
            const permanentBefore = soldOutBeforeMidnight.goods.find((x) => x.goodsId === 301);
            const dailyBefore = soldOutBeforeMidnight.goods.find((x) => x.goodsId === 307);
            now = Date.UTC(2026, 9, 19, 16, 2, 0); // 北京时间次日 00:02
            const soldOutAfterMidnight = await milkTea.getShopGoods();
            const permanentAfter = soldOutAfterMidnight.goods.find((x) => x.goodsId === 301);
            const dailyAfter = soldOutAfterMidnight.goods.find((x) => x.goodsId === 307);
            check('跨日后清除日限额售罄状态，同时保留永久限额售罄状态',
                permanentBefore && permanentBefore.soldOut === true
                && dailyBefore && dailyBefore.soldOut === true
                && permanentAfter && permanentAfter.soldOut === true
                && dailyAfter && dailyAfter.soldOut === false,
                { permanentBefore, dailyBefore, permanentAfter, dailyAfter });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        const fixedNow = Date.UTC(2026, 9, 19, 7, 0, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '森野余额校验测试店'),
            varintField(4, 7),
        ]);
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [
                { id: 1001, count: 25000 },
                { id: 1041, count: 0 },
            ];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(state),
                        shopActivity([
                            shopGoods({ goodsId: 301, itemId: 20525, currencyId: 1001, unitPrice: 10000, limitCount: 108, name: '森野甜莓种子' }),
                            shopGoods({ goodsId: 302, itemId: 20526, currencyId: 1001, unitPrice: 20000, limitCount: 108, requireLevel: 3, name: '森野白桃种子' }),
                            shopGoods({ goodsId: 303, itemId: 20527, currencyId: 1041, unitPrice: 8000, limitCount: 108, requireLevel: 5, name: '森野甜橙种子' }),
                            shopGoods({ goodsId: 304, itemId: 20528, currencyId: 1001, unitPrice: 10000, limitCount: 108, unlocked: false, requireLevel: 7, name: '森野红柚种子' }),
                            shopGoods({ goodsId: 305, itemId: 20021, currencyId: 1001, unitPrice: 10000, limitCount: 108, requireLevel: 9, name: '森野可可豆种子' }),
                            shopGoods({ goodsId: 306, itemId: 21435, currencyId: 1001, unitPrice: 20000, limitCount: 108, purchasedCount: 108, requireLevel: 11, name: '森野柿子种子' }),
                            shopGoods({ goodsId: 308, itemId: 29005, currencyId: 1041, unitPrice: 8000, limitCount: 1, name: '森野黄金芽种子' }),
                        ]),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    const payload = mg.parseTop(req.payload);
                    const count = toInt((payload.find((x) => x.f === 2) || {}).v);
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        result: Buffer.concat([
                            bytesField(1, Buffer.concat([varintField(1, 20525), varintField(2, count)])),
                            bytesField(2, Buffer.concat([varintField(1, 1001), varintField(2, count * 10000)])),
                        ]),
                        resultField: 101,
                    });
                }
                throw new Error(`森野余额校验用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            sent.length = 0;
            const limited = await milkTea.buyDailySeeds(1);
            const buyRequests = sent.filter((x) => x.cmd === 1 && x.group === GROUP_SHOP);
            const skipReasons = limited.skippedGoods.map((x) => x.reason).join('；');
            check('未解锁、等级不足、售罄与余额不足分别跳过',
                limited.boughtCount === 1 && limited.ok === true
                && /未解锁/.test(skipReasons) && /店铺 Lv7 < Lv9/.test(skipReasons)
                && /限购/.test(skipReasons) && /金币不足/.test(skipReasons)
                && /奶茶券不足/.test(skipReasons), limited);
            check('本轮首个商品扣减后余额不足，后续商品不再超支发请求',
                buyRequests.length === 1, {
                    requests: buyRequests.length,
                    skippedGoods: limited.skippedGoods,
                });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        const fixedNow = Date.UTC(2026, 9, 19, 7, 30, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [{ id: 1001, count: 50000 }];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(Buffer.concat([
                            varintField(1, 1792200000),
                            bytesField(2, '森野成交价测试店'),
                            varintField(4, 3),
                        ])),
                        shopActivity([
                            shopGoods({
                                goodsId: 301,
                                itemId: 20525,
                                currencyId: 1001,
                                unitPrice: 10000,
                                limitCount: 108,
                                name: '森野甜莓种子',
                            }),
                        ]),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        result: Buffer.concat([
                            bytesField(1, Buffer.concat([
                                varintField(1, 20525),
                                varintField(2, 1),
                            ])),
                            bytesField(2, Buffer.concat([
                                varintField(1, 1001),
                                varintField(2, 12345),
                            ])),
                        ]),
                        resultField: 101,
                    });
                }
                throw new Error(`森野成交价用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            const bought = await milkTea.buyDailySeeds(1);
            const balances = await milkTea.getCurrencyBalances();
            check('余额与花费按 Operate 响应总价扣减，而非使用 List 单价',
                bought.ok === true && bought.boughtCount === 1
                && bought.spentGold === 12345 && balances.gold === 37655,
                { result: bought, balances });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        const fixedNow = Date.UTC(2026, 9, 19, 8, 0, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        const state = Buffer.concat([
            varintField(1, 1792200000),
            bytesField(2, '森野部分成交测试店'),
            varintField(4, 13),
        ]);
        let sold301 = 0;
        const parseBuyRequests = () => sent
            .filter((x) => x.cmd === 1 && x.group === GROUP_SHOP)
            .map((x) => {
                const payload = mg.parseTop(x.payload);
                return {
                    goodsId: toInt((payload.find((y) => y.f === 1) || {}).v),
                    count: toInt((payload.find((y) => y.f === 2) || {}).v),
                };
            });
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [{ id: 1001, count: 100000 }];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(state),
                        shopActivity([
                            shopGoods({ goodsId: 301, itemId: 20525, currencyId: 1001, unitPrice: 10000, limitCount: 108, name: '森野甜莓种子' }),
                            shopGoods({ goodsId: 302, itemId: 20526, currencyId: 1001, unitPrice: 10000, limitCount: 5, purchasedCount: 4, requireLevel: 3, name: '森野白桃种子' }),
                        ]),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    const payload = mg.parseTop(req.payload);
                    const goodsId = toInt((payload.find((x) => x.f === 1) || {}).v);
                    const requested = toInt((payload.find((x) => x.f === 2) || {}).v);
                    let actual = requested;
                    if (goodsId === 301) {
                        sold301 += 1;
                        actual = sold301 === 1 ? 1 : requested;
                    }
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        result: Buffer.concat([
                            bytesField(1, Buffer.concat([
                                varintField(1, goodsId === 301 ? 20525 : 20526),
                                varintField(2, actual),
                            ])),
                            bytesField(2, Buffer.concat([
                                varintField(1, 1001),
                                varintField(2, actual * 10000),
                            ])),
                        ]),
                        resultField: 101,
                    });
                }
                throw new Error(`森野部分成交用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            sent.length = 0;
            const firstRound = await milkTea.buyDailySeeds(6);
            check('剩余限购会把请求数量从设置份数截断',
                firstRound.boughtCount === 2
                && JSON.stringify(parseBuyRequests()) === JSON.stringify([
                    { goodsId: 301, count: 6 },
                    { goodsId: 302, count: 1 },
                ]), { result: firstRound, requests: parseBuyRequests() });

            sent.length = 0;
            const secondRound = await milkTea.buyDailySeeds(6);
            check('服务端少成交后下一轮只补差额且不再购买已售罄商品',
                secondRound.boughtCount === 5
                && JSON.stringify(parseBuyRequests()) === JSON.stringify([
                    { goodsId: 301, count: 5 },
                ]), { result: secondRound, requests: parseBuyRequests() });

            sent.length = 0;
            const thirdRound = await milkTea.buyDailySeeds(6);
            check('所有商品补齐后后续轮次零购买请求',
                thirdRound.boughtCount === 0 && thirdRound.skipped === true
                && parseBuyRequests().length === 0,
                { result: thirdRound, requests: parseBuyRequests() });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        const fixedNow = Date.UTC(2026, 9, 19, 9, 30, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [{ id: 1001, count: 50000 }];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(Buffer.concat([
                            varintField(1, 1792200000),
                            bytesField(2, '森野未知错误测试店'),
                            varintField(4, 3),
                        ])),
                        shopActivity([
                            shopGoods({
                                goodsId: 301,
                                itemId: 20525,
                                currencyId: 1001,
                                unitPrice: 10000,
                                limitCount: 108,
                                name: '森野甜莓种子',
                            }),
                        ]),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        errorCode: 1034999,
                        result: null,
                        resultField: 101,
                    });
                }
                throw new Error(`森野未知错误用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };

            sent.length = 0;
            const first = await milkTea.buyDailySeeds(1);
            const second = await milkTea.buyDailySeeds(1);
            const shop = await milkTea.getShopGoods();
            const goods = shop.goods.find((x) => x.goodsId === 301);
            const buyRequests = sent.filter((x) => x.cmd === 1 && x.group === GROUP_SHOP);
            check('普通购买失败不会被永久标记售罄，下一轮仍会重试',
                first.ok === false && first.failed.length === 1
                && second.ok === false && second.failed.length === 1
                && buyRequests.length === 2 && goods && goods.soldOut === false,
                { first, second, buyRequests: buyRequests.length, goods });
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        milkTea.__testing.setShopClock(() => Date.now());
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        try {
            warehouse.getBag = async () => {
                throw new Error('背包读取失败');
            };
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(Buffer.concat([
                            varintField(1, 1792200000),
                            bytesField(2, '森野背包失败测试店'),
                            varintField(4, 15),
                        ])),
                        shopActivity([
                            shopGoods({ goodsId: 301, itemId: 20525, currencyId: 1001, unitPrice: 10000, limitCount: 108, name: '森野甜莓种子' }),
                        ]),
                    ]);
                }
                throw new Error(`森野背包失败用例不应发送 ${req.method || `cmd=${req.cmd}`}`);
            };
            sent.length = 0;
            const noBag = await milkTea.buyDailySeeds(1);
            check('余额读取失败时不盲目发送购买请求',
                noBag.ok === false && noBag.skipped === true
                && /余额失败/.test(noBag.reason)
                && sent.filter((x) => x.cmd === 1 && x.group === GROUP_SHOP).length === 0,
                { result: noBag, sent: sent.map((x) => x.method || x.cmd) });
        } finally {
            warehouse.getBag = originalGetBag;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        const fixedNow = Date.UTC(2026, 9, 19, 9, 0, 0);
        milkTea.__testing.setShopClock(() => fixedNow);
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        milkTea.__testing.resetCurrencyCache();
        const originalGetBag = warehouse.getBag;
        const originalGetBagItems = warehouse.getBagItems;
        try {
            warehouse.getBag = async () => ({});
            warehouse.getBagItems = () => [{ id: 1001, count: 100000 }];
            router = async (req) => {
                if (req.method === 'List') {
                    return activityListReply([
                        mainActivity(Buffer.concat([
                            varintField(1, 1792200000),
                            bytesField(2, '森野失败隔离测试店'),
                            varintField(4, 3),
                        ])),
                        shopActivity([
                            shopGoods({ goodsId: 301, itemId: 20525, currencyId: 1001, unitPrice: 10000, limitCount: 108, name: '森野甜莓种子' }),
                            shopGoods({ goodsId: 302, itemId: 20526, currencyId: 1001, unitPrice: 10000, limitCount: 108, requireLevel: 3, name: '森野白桃种子' }),
                        ]),
                    ]);
                }
                if (req.cmd === 1 && req.group === GROUP_SHOP) {
                    const payload = mg.parseTop(req.payload);
                    const goodsId = toInt((payload.find((x) => x.f === 1) || {}).v);
                    if (goodsId === 301) {
                        return operateReply(1, {
                            group: GROUP_SHOP,
                            errorCode: 1034149,
                            result: null,
                            resultField: 101,
                        });
                    }
                    return operateReply(1, {
                        group: GROUP_SHOP,
                        result: Buffer.concat([
                            bytesField(1, Buffer.concat([varintField(1, 20526), varintField(2, 1)])),
                            bytesField(2, Buffer.concat([varintField(1, 1001), varintField(2, 10000)])),
                        ]),
                        resultField: 101,
                    });
                }
                throw new Error(`森野失败隔离用例收到 ${req.method || `cmd=${req.cmd}`}`);
            };
            activityLogs.length = 0;
            const partialFailure = await milkTea.buyDailySeeds(1);
            check('单个商品失败不会中断其余商品，并保留下一轮重试状态',
                partialFailure.ok === false && partialFailure.partial === true
                && partialFailure.boughtCount === 1 && partialFailure.failed.length === 1,
                partialFailure);
            check('部分成功日志同时列出成功与失败商品',
                activityLogs.some((x) => /森野种子自动购买 1 种\/1 份/.test(x.msg)
                    && /失败 森野甜莓种子/.test(x.msg)),
                activityLogs.map((x) => x.msg));
        } finally {
            warehouse.getBag = originalGetBag;
            warehouse.getBagItems = originalGetBagItems;
            milkTea.__testing.resetCurrencyCache();
        }
    }

    {
        milkTea.__testing.setShopClock(() => Date.now());
        milkTea.__testing.resetShopState();
        milkTea.__testing.clearMainStatusCache();
        router = async (req) => {
            if (req.method === 'List') return activityListReply([mainActivity()]);
            throw new Error(`缺失活动体用例不应发送 ${req.method || `cmd=${req.cmd}`}`);
        };
        const shopMissing = await milkTea.getShopGoods();
        const upgradeRewardsMissing = await milkTea.getTasks();
        check('活动 List 缺少 #102 时商店返回 ok:false',
            shopMissing.ok === false && /#102/.test(shopMissing.reason), shopMissing);
        check('活动 List 缺少 #122 时升级奖励返回 ok:false',
            upgradeRewardsMissing.ok === false && /#122/.test(upgradeRewardsMissing.reason), upgradeRewardsMissing);

        sent.length = 0;
        const claimOne = await milkTea.claimTask(9001);
        const claimAll = await milkTea.claimAllTasks();
        check('旧领取接口确认升级奖励无领取协议后仍保持零请求',
            claimOne.skipped === true && claimAll.skipped === true && sent.length === 0,
            { claimOne, claimAll, sent });
    }

    {
        milkTea.__testing.clearMainStatusCache();
        let activeListRequests = 0;
        let maxActiveListRequests = 0;
        router = async (req) => {
            if (req.method !== 'List') {
                throw new Error(`List 并发用例收到 ${req.method || `cmd=${req.cmd}`}`);
            }
            activeListRequests += 1;
            maxActiveListRequests = Math.max(maxActiveListRequests, activeListRequests);
            await new Promise((resolve) => setTimeout(resolve, 20));
            activeListRequests -= 1;
            return activityListReply([
                mainActivity(),
                shopActivity([]),
                taskActivity({ tasks: [] }),
            ]);
        };
        sent.length = 0;
        const [main, shop, tasks] = await Promise.all([
            milkTea.getMainStatus(true),
            milkTea.getShopGoods(),
            milkTea.getTasks(),
        ]);
        check('并发读取主店/商店/任务会合并为一次 List 且不重叠',
            main.ok === true && shop.ok === true && tasks.ok === true
            && sent.length === 1 && maxActiveListRequests === 1,
            { sent: sent.map((x) => x.method || x.cmd), maxActiveListRequests });

        let activeOperates = 0;
        let maxActiveOperates = 0;
        router = async (req) => {
            if (req.cmd !== 60) throw new Error(`RPC 串行用例收到 cmd=${req.cmd}`);
            activeOperates += 1;
            maxActiveOperates = Math.max(maxActiveOperates, activeOperates);
            await new Promise((resolve) => setTimeout(resolve, 20));
            activeOperates -= 1;
            return operateReply(60, {
                result: Buffer.concat([
                    varintField(1, 50),
                    varintField(2, 2250),
                    varintField(3, 2908400),
                ]),
                resultField: 165,
            });
        };
        sent.length = 0;
        await Promise.all([milkTea.getCashierStatus(), milkTea.getCashierStatus()]);
        check('活动 Operate RPC 并发最大值不超过 1',
            sent.filter((x) => x.cmd === 60).length === 2 && maxActiveOperates === 1,
            { sent: sent.map((x) => x.cmd), maxActiveOperates });
    }

    {
        const gid = 1300000501;
        const employees = [];
        router = async (req) => {
            if (req.cmd === 55) {
                return operateReply(55, {
                    result: cashierDetailResult({ level: 3, employees }),
                    resultField: 160,
                });
            }
            if (req.cmd === 56) {
                return operateReply(56, {
                    result: employeePanelResult({
                        friends: [hireCandidateFriend({ gid })],
                        staff: [],
                    }),
                    resultField: 161,
                });
            }
            if (req.cmd === 57) {
                employees.push(cashierEmployee({
                    slot: hireRequestSlot(req),
                    shiftUid: '30070362835095999',
                    gid,
                    name: '重复白名单好友',
                    level: 100,
                    startAt: 1792200000,
                    endAt: 1792214400,
                    wage: 40,
                    titleId: 9001,
                    titleName: '金牌销售',
                }));
                return operateReply(57, { result: Buffer.alloc(0), resultField: 162 });
            }
            throw new Error(`重复白名单用例收到 cmd=${req.cmd}`);
        };
        sent.length = 0;
        const duplicateWhitelist = await milkTea.autoHire([gid, gid, String(gid)], { duration: 1 });
        check('自动雇佣白名单去重且保持输入顺序，同一 GID 只尝试一次',
            duplicateWhitelist.ok === true && duplicateWhitelist.hired === 1
            && duplicateWhitelist.attempted === 1
            && sent.filter((x) => x.cmd === 57).length === 1,
            { result: duplicateWhitelist, sent: sent.map((x) => x.cmd) });
    }

    milkTea.__testing.setShopClock(() => Date.now());
    milkTea.__testing.resetShopState();
    milkTea.__testing.clearMainStatusCache();

    finish();
})().catch((e) => {
    console.log('测试异常:', e && e.stack ? e.stack : e);
    process.exit(1);
});
