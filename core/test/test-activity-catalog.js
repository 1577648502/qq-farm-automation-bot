/**
 * activity.js 纯函数回归测试(__testing 导出)
 *
 * 覆盖: 活动条目选择(selectActivityEntries, 青酿特殊分支) + 活动列表归一化(normalizeActivityList)
 * 之前整个 1669 行的 activity 服务零测试, 协议选择逻辑(shop/lottery/draw/dailySignin 四类条目)
 * 是历史 bug 高发区, 这里锁住行为。
 *
 * 运行: node test/test-activity-catalog.js
 */
const { setupSandbox, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();

(async () => {
    const proto = require(`${SB}/src/utils/proto`);
    await proto.loadProto();

    const activity = require(`${SB}/src/services/activity`);
    const { selectActivityEntries, normalizeActivityList } = activity.__testing;

    // ---- 构造 ListReply 的辅助(proto.js 的 types 只注册了 ListReply, 其余从 root 直接取) ----
    const { types } = proto;
    const root = proto.getRoot ? proto.getRoot() : null;
    const ActivityHeadT = root.lookupType('gamepb.activitypb.ActivityHead');
    const ActivityDataT = root.lookupType('gamepb.activitypb.ActivityData');
    const ActivityGroupT = root.lookupType('gamepb.activitypb.ActivityGroup');
    const ActivityBodyShopT = root.lookupType('gamepb.activitypb.ActivityBodyShop');
    const ActivityBodyLotteryT = root.lookupType('gamepb.activitypb.ActivityBodyLottery');
    const ActivityBodyDrawT = root.lookupType('gamepb.activitypb.ActivityBodyDraw');

    function makeGroup(head, children) {
        return ActivityGroupT.create({ head, children });
    }
    function makeHead(id, type, name) {
        return ActivityHeadT.create({ id, type, name, status: 1 });
    }
    function makeData(head, bodyField, bodyValue) {
        return ActivityDataT.create(Object.assign({ head }, bodyField ? { [bodyField]: bodyValue } : {}));
    }
    function makeReply(groups) {
        return types.ActivityListReply.decode(types.ActivityListReply.encode(
            types.ActivityListReply.create({ groups }),
        ).finish());
    }

    section('1. selectActivityEntries: 无匹配活动返回 null 条目');
    {
        const reply = makeReply([
            makeGroup(makeHead(1001, 1, '无关节日'), [
                makeData(makeHead(1002, 2, '无关节日')),
            ]),
        ]);
        const sel = selectActivityEntries(reply, '青酿换万金');
        check('entries 含全部条目', sel.entries.length === 1, sel.entries.length);
        check('matched 为空', sel.matched.length === 0, sel.matched.length);
        check('shopEntry 为 null', sel.shopEntry === null);
        check('lotteryEntry 为 null', sel.lotteryEntry === null);
    }

    section('2. selectActivityEntries: 按名字匹配到活动');
    {
        // 青酿 shop 条目判定: goods[].cost[].id === 青梅果实(41221), 构造一个合规商品
        const qingniangShop = ActivityBodyShopT.create({
            goods: [{ id: 1, cost: [{ id: 41221, count: 10 }] }],
        });
        const reply = makeReply([
            makeGroup(makeHead(2001, 1, '青酿换万金'), [
                makeData(makeHead(2002, 2, '青酿换万金'), 'shop', qingniangShop),
                makeData(makeHead(2003, 3, '青酿换万金'), 'lottery', ActivityBodyLotteryT.create({})),
            ]),
        ]);
        const sel = selectActivityEntries(reply, '青酿换万金');
        check('matched 命中 2 个', sel.matched.length === 2, sel.matched.length);
        check('shopEntry 已选', !!sel.shopEntry && !!sel.shopEntry.data.shop);
        check('lotteryEntry 已选', !!sel.lotteryEntry && !!sel.lotteryEntry.data.lottery);
    }

    section('3. selectActivityEntries: 名字模糊匹配(含变体词)');
    {
        const reply = makeReply([
            makeGroup(makeHead(3001, 1, '荷风游记·周年庆'), [
                makeData(makeHead(3002, 2, '荷风游记'), 'draw', ActivityBodyDrawT.create({})),
            ]),
        ]);
        const sel = selectActivityEntries(reply, '荷风游记');
        check('子串活动名命中 drawEntry', !!sel.drawEntry && !!sel.drawEntry.data.draw);
    }

    section('4. normalizeActivityList: summaries 归一化');
    {
        const reply = makeReply([]);
        const r = normalizeActivityList(reply, '青酿换万金');
        check('返回结构齐全', !!(r.activities && r.matchedActivities && r.summaries));
        check('空 reply 活动列表为空数组', Array.isArray(r.activities) && r.activities.length === 0);
    }

    finish();
})().catch((e) => { console.error(e); process.exit(1); });
