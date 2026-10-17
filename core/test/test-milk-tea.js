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

/** 最小活动体: 只需让 parseMainState 识别出主活动组并返回 ok=true。 */
function mainActivity() {
    return bytesField(1, varintField(1, GROUP_MAIN));
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

function workRefreshResult({
    employerGid = 0,
    employerName = '',
    startAt = 1792200000,
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
    if (startAt) current.push(varintField(6, startAt), varintField(7, startAt + 3600), varintField(11, 40));
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
    throw new Error('测试未设置 Operate 应答');
};
sendImpl = async (service, method, body) => {
    if (service !== ACTIVITY_SERVICE || method !== 'Operate') {
        throw new Error(`未预期的网络调用: ${service}.${method}`);
    }
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
            if (req.cmd === 63) return operateReply(63, { activity: mainActivity(), result: Buffer.alloc(0), resultField: 168 });
            if (req.cmd === 67) return operateReply(67, { result: sales, resultField: 172 });
            if (req.cmd === 58) return operateReply(58, { result: menu, resultField: 163 });
            throw new Error(`营业记录用例收到 cmd=${req.cmd}`);
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
        const uids = [54428, 54535, 54536, 54537, 54501, 54492, 54500, 54483];
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
        check('八个果实 UID 完整打包', packed && parsePackedVarints(packed).join(',') === uids.join(','), packed && Array.from(packed));
        check('制作结果解析八条产出', r.ok === true && r.made.length === 8, r.made && r.made.length);
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

    section('7. 互动只认刷新 #168.#1');
    {
        const noEmployer = workRefreshResult({ employerGid: 0 });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { activity: mainActivity(), result: noEmployer, resultField: 168 });
            throw new Error(`无雇主用例不应发送 cmd=${req.cmd}`);
        };

        sent.length = 0;
        const skipped = await milkTea.__testing.interactWithFriend(999999, 2);
        check('没有当前雇主时跳过互动', skipped.ok === false && skipped.skipped === true, skipped);
        check('旧 employerGid 没有机会触发 cmd65', !sent.some((x) => x.cmd === 65), sent.map((x) => x.cmd));

        const liveGid = 1253397809;
        const current = workRefreshResult({ employerGid: liveGid, employerName: '哈哈' });
        router = async (req) => {
            if (req.cmd === 63) return operateReply(63, { activity: mainActivity(), result: current, resultField: 168 });
            if (req.cmd === 65) {
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
        const corrected = await milkTea.__testing.interactWithFriend(123456, 2);
        const interactReq = sent.find((x) => x.cmd === 65);
        const payload = interactReq && mg.parseTop(interactReq.payload);
        const gidField = payload && payload.find((x) => x.f === 1);
        const typeField = payload && payload.find((x) => x.f === 2);
        check('错误 GID 被刷新结果纠正', corrected.ok === true && corrected.friendGid === liveGid && corrected.correctedGid === true, corrected);
        check('cmd65 payload 字段为 #170', interactReq && interactReq.payloadField === 170, interactReq && interactReq.payloadField);
        check('#170 直接包含 #1 当前雇主 GID', gidField && gidField.w === 0 && toInt(gidField.v) === liveGid, gidField);
        check('#170 直接包含 #2 互动类型', typeField && typeField.w === 0 && toInt(typeField.v) === 2, typeField);
        check('#170 没有多余嵌套 #1', payload.length === 2 && payload.filter((x) => x.f === 1).length === 1, payload);
        check('互动结果按刷新工资与 #8.#3 返回工资变化', corrected.interact && corrected.interact.wage
            && corrected.interact.wage.before === 40 && corrected.interact.wage.after === 52
            && corrected.interact.wage.change === 12, corrected.interact);
        check('未确认字段保留原始结构且不命名底薪/加成', corrected.interact
            && corrected.interact.effects.field7[1] === 1000 && corrected.interact.effects.field7[2] === 148
            && corrected.interact.effects.field8[1] === 3000 && corrected.interact.effects.field8[3] === 12
            && !Object.prototype.hasOwnProperty.call(corrected.interact.wage, 'base')
            && !Object.prototype.hasOwnProperty.call(corrected.interact.wage, 'extra'), corrected.interact);
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

    finish();
})().catch((e) => {
    console.log('测试异常:', e && e.stack ? e.stack : e);
    process.exit(1);
});
