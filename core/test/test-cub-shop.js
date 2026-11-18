/**
 * 幼崽商城加购 回归测试
 *
 * 背景(2026-11-18):
 *   面板原来只有一个「买 1 只」按钮, 它调的 autoBuyCubs 是"按收益比自动挑、自己算数量",
 *   用户完全控制不了买什么、买几只; 而农场商城早就有"数量步进 + 合计 + 限购/余额拦截 + 确认弹窗"。
 *   这次按农场商城的架构补齐, 于是必须锁住三件事:
 *
 *     1) 传了 goodsId 就只买那一只(不能退化成"自动挑收益比最高的");
 *     2) 数量可以被限购余量和金券余额削减, 且削减是**静默正确**的(不超卖、不超支);
 *     3) 买不了时要给出具体原因(未解锁/已售罄/余额不足), 而不是发一个必然失败的下单请求。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'cub-shop-test';
isolateDataDir(SB, 'cub-shop-test');

const proto = require(`${SB}/src/utils/proto`);
const network = require(`${SB}/src/utils/network`);
const { types } = require(`${SB}/src/utils/proto`);

const SHOP_SERVICE = 'gamepb.shoppb.ShopService';

/** 造一个 ShopInfo 回复(幼崽商店 = shop 5) */
function shopInfoReply(goodsList) {
    return types.ShopInfoReply.encode(types.ShopInfoReply.create({
        goods_list: goodsList.map(g => ({
            id: g.id,
            item_id: g.itemId,
            price: g.price,
            price_id: 1007,
            limit_count: g.limit ?? 0,
            bought_num: g.bought ?? 0,
            unlocked: g.unlocked !== false,
        })),
    })).finish();
}

/** 造一个背包回复(金券 1007) */
function bagReply(voucher) {
    return types.BagReply.encode(types.BagReply.create({
        item_bag: { items: voucher > 0 ? [{ id: 1007, count: voucher }] : [] },
    })).finish();
}

/**
 * 装一个可编程网络层。
 * 注意: ranch/mall/warehouse 在**模块加载时**解构 sendMsgAsync, 所以必须先打桩再 require。
 */
function installStub(handlers) {
    const calls = [];
    network.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        calls.push({ key, body, service, method });
        const h = handlers[key] || handlers[method];
        if (!h) throw new Error(`未预期请求: ${key}`);
        return { body: h(body) };
    };
    return calls;
}

/** 每个用例加载全新的 ranch 模块(它内部有模块级缓存) */
function freshRanch() {
    for (const key of Object.keys(require.cache)) {
        if (key.includes('/services/ranch.js') || key.includes('/services/mall.js') || key.includes('/services/warehouse.js')) {
            delete require.cache[key];
        }
    }
    return require(`${SB}/src/services/ranch`);
}

const GOODS = [
    { id: 5001, itemId: 60001, price: 2, limit: 10, bought: 0 },      // 鸡, 限购 10
    { id: 5002, itemId: 70001, price: 1440, limit: 0, bought: 0 },    // 羊, 不限购
];

proto.loadProto().then(async () => {
    section('1. 指定 goodsId 只买那一只(不退化成绩效比自动挑)');
    {
        const calls = installStub({
            [`${SHOP_SERVICE}.ShopInfo`]: () => shopInfoReply(GOODS),
            [`${SHOP_SERVICE}.BuyGoods`]: () => types.BuyGoodsReply.encode(types.BuyGoodsReply.create({})).finish(),
            'gamepb.itempb.ItemService.Bag': () => bagReply(999999),
            'ItemService.Bag': () => bagReply(999999),
        });
        const ranch = freshRanch();
        // 买的是 5002(羊, 收益比最低的那只) —— 如果退化成自动挑, 会买 5001
        const r = await ranch.buyCubByGoods(5002, 3);
        const buyCalls = calls.filter(c => c.key === `${SHOP_SERVICE}.BuyGoods`);
        check('购买成功', r.ok === true, r);
        check('只发一次 BuyGoods', buyCalls.length === 1, buyCalls.length);
        const req = types.BuyGoodsRequest.decode(buyCalls[0].body);
        check('买的是用户点的 5002(不是收益比最高的 5001)', Number(req.goods_id) === 5002, Number(req.goods_id));
        check('数量 = 3', Number(req.num) === 3, Number(req.num));
        check('返回 bought=3', r.bought === 3, r.bought);
    }

    section('2. 限购余量会削减数量');
    {
        // 限购 10 已买 8 → 剩余 2
        const calls = installStub({
            [`${SHOP_SERVICE}.ShopInfo`]: () => shopInfoReply([
                { id: 5001, itemId: 60001, price: 2, limit: 10, bought: 8 },
            ]),
            [`${SHOP_SERVICE}.BuyGoods`]: () => types.BuyGoodsReply.encode(types.BuyGoodsReply.create({})).finish(),
            'gamepb.itempb.ItemService.Bag': () => bagReply(999999),
            'ItemService.Bag': () => bagReply(999999),
        });
        const ranch = freshRanch();
        const r = await ranch.buyCubByGoods(5001, 5);
        const req = types.BuyGoodsRequest.decode(calls.find(c => c.method === 'BuyGoods').body);
        check('数量被削减到剩余 2', Number(req.num) === 2, Number(req.num));
        check('返回 bought=2', r.bought === 2, r.bought);
    }

    section('3. 金券余额不足 → 不发请求, 给明确原因');
    {
        const calls = installStub({
            [`${SHOP_SERVICE}.ShopInfo`]: () => shopInfoReply(GOODS),
            [`${SHOP_SERVICE}.BuyGoods`]: () => { throw new Error('不该发 BuyGoods'); },
            'gamepb.itempb.ItemService.Bag': () => bagReply(5),   // 只有 5 金券, 羊单价 1440
            'ItemService.Bag': () => bagReply(5),
        });
        const ranch = freshRanch();
        const r = await ranch.buyCubByGoods(5002, 1);
        check('返回失败', r.ok === false, r);
        check('不发 BuyGoods', calls.filter(c => c.method === 'BuyGoods').length === 0);
        check('原因是金券不足', /金券不足/.test(String(r.error)), r.error);
    }

    section('4. 余额够但只够买 N 只 → 削减到 N');
    {
        const calls = installStub({
            [`${SHOP_SERVICE}.ShopInfo`]: () => shopInfoReply(GOODS),
            [`${SHOP_SERVICE}.BuyGoods`]: () => types.BuyGoodsReply.encode(types.BuyGoodsReply.create({})).finish(),
            'gamepb.itempb.ItemService.Bag': () => bagReply(5),    // 5 / 单价 2 = 2 只
            'ItemService.Bag': () => bagReply(5),
        });
        const ranch = freshRanch();
        const r = await ranch.buyCubByGoods(5001, 10);
        const req = types.BuyGoodsRequest.decode(calls.find(c => c.method === 'BuyGoods').body);
        check('数量削减到 2(余额只够 2 只)', Number(req.num) === 2, Number(req.num));
        check('返回 bought=2', r.bought === 2, r.bought);
    }

    section('5. 已售罄 / 未解锁 → 不发请求');
    {
        installStub({
            [`${SHOP_SERVICE}.ShopInfo`]: () => shopInfoReply([
                { id: 5001, itemId: 60001, price: 2, limit: 10, bought: 10 },   // 已售罄
                { id: 5003, itemId: 60003, price: 100, limit: 0, bought: 0, unlocked: false },
            ]),
            [`${SHOP_SERVICE}.BuyGoods`]: () => { throw new Error('不该发 BuyGoods'); },
            'gamepb.itempb.ItemService.Bag': () => bagReply(999999),
            'ItemService.Bag': () => bagReply(999999),
        });
        const ranch = freshRanch();
        const soldOut = await ranch.buyCubByGoods(5001, 1);
        check('售罄 → 失败且原因是限购', soldOut.ok === false && /限购/.test(String(soldOut.error)),
            { ok: soldOut.ok, error: soldOut.error });

        const locked = await ranch.buyCubByGoods(5003, 1);
        check('未解锁 → 失败且原因是未解锁', locked.ok === false && /未解锁/.test(String(locked.error)),
            { ok: locked.ok, error: locked.error });
    }

    section('6. 商店列表带 remaining, 供前端算上限');
    {
        installStub({
            [`${SHOP_SERVICE}.ShopInfo`]: () => shopInfoReply([
                { id: 5001, itemId: 60001, price: 2, limit: 10, bought: 3 },
                { id: 5002, itemId: 70001, price: 1440, limit: 0, bought: 0 },
            ]),
            'gamepb.itempb.ItemService.Bag': () => bagReply(0),
            'ItemService.Bag': () => bagReply(0),
        });
        const ranch = freshRanch();
        const shop = await ranch.getCubShop();
        const limited = shop.find(g => g.goodsId === 5001);
        const unlimited = shop.find(g => g.goodsId === 5002);
        check('限购商品 remaining = 7', limited && limited.remaining === 7, limited && limited.remaining);
        check('不限购商品 remaining = null', unlimited && unlimited.remaining === null,
            unlimited && unlimited.remaining);
    }

    section('7. 读不到余额时不拦截(交给服务端判定)');
    {
        const calls = installStub({
            [`${SHOP_SERVICE}.ShopInfo`]: () => shopInfoReply(GOODS),
            [`${SHOP_SERVICE}.BuyGoods`]: () => types.BuyGoodsReply.encode(types.BuyGoodsReply.create({})).finish(),
            // 背包接口直接报错 → getVoucherBalance 返回 null
            'gamepb.itempb.ItemService.Bag': () => { throw new Error('背包读取失败'); },
            'ItemService.Bag': () => { throw new Error('背包读取失败'); },
        });
        const ranch = freshRanch();
        const r = await ranch.buyCubByGoods(5001, 3);
        check('仍会下单', calls.filter(c => c.method === 'BuyGoods').length === 1);
        check('买 3 只', r.bought === 3, r.bought);
    }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
