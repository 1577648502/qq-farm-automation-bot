/**
 * 背包道具自动使用回归测试
 *
 * 需求: 背包里"能使用"的道具要支持自动使用。
 *
 * 判定原则: ItemInfo.can_use=1 是前提, 再用排除清单剔除"已经在自动处理"
 * (礼包/化肥) 或"必须先选目标/要走别的协议/不该自动做"的类型 —— 自动盲用
 * 会报参数错误, 或做用户没预期的动作。
 *
 * 覆盖:
 *   · allowlist: 种子解锁卡等可自动用; 礼包/化肥/容器/狗粮/活动道具/红包/罐头不可
 *   · 执行: 按背包实际数量 Use, 同 ID 多条合并
 *   · 容错: 单个道具失败不影响其它; 失败的道具被记住, 下轮不再反复重试
 *   · 背包详情下发的 usable 标记: 礼包也算可用(可手动开), 容器/解锁卡以外的不行
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'auto-use-test';
isolateDataDir(SB, 'auto-use-test');

const network = require(`${SB}/src/utils/network`);
const proto = require(`${SB}/src/utils/proto`);
const { types } = proto;

// 背包内容按用例设置
let bagItems = [];
// 记录发出去的 Use 请求
let useCalls = [];
let failIds = new Set();

network.sendMsgAsync = async (_service, method, body) => {
    if (method === 'Bag') {
        return {
            body: Buffer.from(types.BagReply.encode(types.BagReply.create({
                item_bag: { items: bagItems.map(it => ({ id: it.id, count: it.count, uid: it.uid || 0 })) },
            })).finish()),
        };
    }
    if (method === 'Use') {
        const req = types.UseRequest.decode(body);
        const itemId = Number(req.item_id);
        const count = Number(req.count);
        useCalls.push({ itemId, count });
        if (failIds.has(itemId)) throw new Error('使用失败 code=1000019');
        return { body: Buffer.from(types.UseReply.encode(types.UseReply.create({})).finish()) };
    }
    throw new Error(`unexpected method: ${method}`);
};

proto.loadProto().then(async () => {
    const warehouse = require(`${SB}/src/services/warehouse`);

    section('1. allowlist: 哪些道具能自动使用');
    {
        // 能: 种子解锁卡(type=14, 用掉即解锁, 无目标参数)
        check('卡特兰种子解锁卡 30184 可自动用', warehouse.isAutoUsableItemId(30184) === true);
        check('茱萸种子解锁卡 30165 可自动用', warehouse.isAutoUsableItemId(30165) === true);

        // 不能: 礼包 → 归 autoOpenGiftPacks
        check('成长宝箱 100002 不归本函数(礼包那套管)', warehouse.isAutoUsableItemId(100002) === false);
        check('藏品礼包 101619 不归本函数(礼包那套管)', warehouse.isAutoUsableItemId(101619) === false);
        // 不能: 化肥 → 归 fertilizer_gift(带容器上限裁剪)
        check('化肥 80001 不归本函数(化肥那套管)', warehouse.isAutoUsableItemId(80001) === false);
        // 不能: 容器
        check('普通化肥容器 1011 不可自动用', warehouse.isAutoUsableItemId(1011) === false);
        check('无机罐头容器 7003 不可自动用', warehouse.isAutoUsableItemId(7003) === false);
        // 不能: 狗粮(走 FeedDog)
        check('狗粮 90004 不可自动用', warehouse.isAutoUsableItemId(90004) === false);
        // 不能: 活动道具(要选地块/好友)
        check('催化剂 5011 不可自动用', warehouse.isAutoUsableItemId(5011) === false);
        check('闪电变异瓶 5003 不可自动用', warehouse.isAutoUsableItemId(5003) === false);
        // 不能: 红包/兑换券(站外权益/现金)
        check('福运红包 101400 不可自动用', warehouse.isAutoUsableItemId(101400) === false);
        check('奶茶兑换券 101405 不可自动用', warehouse.isAutoUsableItemId(101405) === false);
        // 不能: 罐头(没有牧场模块)
        check('罐头 80021 不可自动用', warehouse.isAutoUsableItemId(80021) === false);
        // 不能: 货币/果实/种子(本来就不能用)
        check('金币 1001 不可自动用', warehouse.isAutoUsableItemId(1001) === false);
        check('不存在的道具 999999999 不可自动用', warehouse.isAutoUsableItemId(999999999) === false);
    }

    section('2. 执行: 只对可自动用的道具发 Use, 按背包实际数量');
    {
        warehouse.resetAutoUseFailedIds();
        useCalls = [];
        failIds = new Set();
        bagItems = [
            { id: 30184, count: 2 },   // 卡特兰种子解锁卡 x2
            { id: 30165, count: 1 },   // 茱萸种子解锁卡 x1
            { id: 1011, count: 999 },  // 化肥容器: 必须原样留着
            { id: 100002, count: 3 },  // 礼包: 归礼包那套, 这里不动
            { id: 80001, count: 5 },   // 化肥道具: 归化肥那套, 这里不动
            { id: 90004, count: 2 },   // 狗粮: 不动
            { id: 101400, count: 1 },  // 红包: 不动
            { id: 5011, count: 4 },    // 催化剂: 不动
        ];
        const r = await warehouse.autoUseBagItems();
        check('共使用 3 个道具', r.used === 3, r);
        check('只发了 2 次 Use', useCalls.length === 2, useCalls);
        check('解锁卡按背包数量 x2 使用',
            useCalls.some(c => c.itemId === 30184 && c.count === 2), useCalls);
        check('另一张解锁卡 x1 使用',
            useCalls.some(c => c.itemId === 30165 && c.count === 1), useCalls);
        check('化肥容器没有被使用', !useCalls.some(c => c.itemId === 1011), useCalls);
        check('礼包没有被本函数使用', !useCalls.some(c => c.itemId === 100002), useCalls);
        check('化肥道具没有被本函数使用', !useCalls.some(c => c.itemId === 80001), useCalls);
        check('狗粮没有被使用', !useCalls.some(c => c.itemId === 90004), useCalls);
        check('红包没有被使用', !useCalls.some(c => c.itemId === 101400), useCalls);
        check('催化剂没有被使用', !useCalls.some(c => c.itemId === 5011), useCalls);
    }

    section('3. 同一道具散在多条时合并数量');
    {
        warehouse.resetAutoUseFailedIds();
        useCalls = [];
        bagItems = [
            { id: 30184, count: 2, uid: 1 },
            { id: 30184, count: 5, uid: 2 },
        ];
        await warehouse.autoUseBagItems();
        check('合并成一次 Use 且数量为 7',
            useCalls.length === 1 && useCalls[0].count === 7, useCalls);
    }

    section('4. 单个失败不影响其它');
    {
        warehouse.resetAutoUseFailedIds();
        useCalls = [];
        failIds = new Set([30184]);
        bagItems = [
            { id: 30184, count: 1 },  // 会失败
            { id: 30165, count: 1 },  // 应照常成功
        ];
        const r = await warehouse.autoUseBagItems();
        check('成功的那件仍然被使用', r.used === 1, r);
        check('失败后继续处理下一件', useCalls.length === 2, useCalls);
    }

    section('5. 失败记忆: 同轮之后不再反复重试');
    {
        warehouse.resetAutoUseFailedIds();
        useCalls = [];
        failIds = new Set([30184]);
        bagItems = [{ id: 30184, count: 1 }];
        await warehouse.autoUseBagItems();
        check('首轮尝试了 1 次', useCalls.length === 1, useCalls);

        failIds = new Set();
        useCalls = [];
        await warehouse.autoUseBagItems();
        check('次轮跳过已失败的道具(不再发 Use)', useCalls.length === 0, useCalls);

        // reset 后应重新尝试
        warehouse.resetAutoUseFailedIds();
        useCalls = [];
        await warehouse.autoUseBagItems();
        check('reset 后重新尝试并成功', useCalls.length === 1, useCalls);
    }

    section('6. 背包详情的 usable 标记');
    {
        const { __privateWarehouseFns } = warehouse;
        const built = __privateWarehouseFns.buildBagDetailFromItems([
            { id: 30184, count: 1 },   // 解锁卡: 可自动用
            { id: 100002, count: 3 },  // 礼包: 可手动用(自动那套管)
            { id: 1011, count: 3600 }, // 容器: 不可用
            { id: 5011, count: 2 },    // 催化剂: 不可盲用
            { id: 90004, count: 1 },   // 狗粮: 不可盲用
        ]);
        const byId = new Map(built.items.map(it => [Number(it.id), it]));
        check('解锁卡 usable=true', byId.get(30184)?.usable === true, byId.get(30184));
        check('礼包 usable=true(可手动开)', byId.get(100002)?.usable === true, byId.get(100002));
        check('化肥容器 usable=false', byId.get(1011)?.usable === false, byId.get(1011));
        check('催化剂 usable=false', byId.get(5011)?.usable === false, byId.get(5011));
        check('狗粮 usable=false', byId.get(90004)?.usable === false, byId.get(90004));
    }

    finish();
}).catch(e => {
    console.log('测试异常:', e && e.message);
    process.exit(1);
});
