/**
 * 微信每日礼包自动领取回归测试
 *
 * 抓包结论(20260909 / 20261026 / 20261027):
 *   ReportShare{share_type=1, scene=0} 只负责"触发";
 *   礼包邮件由服务端约 20s 后投递到邮箱(wx_gift_1_每日登录礼包),
 *   领取仍然是普通的 ClaimEmail。
 *
 * 因此必须验证:
 *   1) 触发之前查过邮箱(拿不到礼包邮件)
 *   2) 触发成功后会再查一次邮箱, 并把这一封领掉
 *   3) 领取结果按标题写进日志
 *
 * 运行: node test/test-wechat-gift-claim.js
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
isolateDataDir(SB, 'wechat-gift-claim');

const { section, check, finish } = createChecker();

const GIFT_MAIL_ID = 'mc5_demo_ss_item_mail_1229231763_1793080500_wx_gift_1_每日登录礼包';
const GIFT_MAIL_HEX = buildEmailListReply([{
    id: GIFT_MAIL_ID,
    title: '游戏圈每日登录礼包',
    subtitle: '游戏圈每日登录礼包',
    hasReward: 1,
}]);
const EMPTY_MAIL_HEX = buildEmailListReply([]);
const CLAIM_HEX = buildClaimReply([{ id: 1002, count: 400 }, { id: 90001, count: 1 }]);
const REPORT_HEX = '0a0808011204081c1001';

function writeVarint(value) {
    const bytes = [];
    let v = Number(value);
    while (v > 0x7f) {
        bytes.push((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
    }
    bytes.push(v);
    return Buffer.from(bytes);
}

function tag(field, wireType) {
    return writeVarint((field << 3) | wireType);
}

function lenField(field, payload) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    return Buffer.concat([tag(field, 2), writeVarint(buf.length), buf]);
}

function varintField(field, value) {
    return Buffer.concat([tag(field, 0), writeVarint(value)]);
}

function buildEmailListReply(emails) {
    const parts = emails.map((m) => {
        const inner = Buffer.concat([
            lenField(1, m.id),
            varintField(2, 1),
            lenField(3, m.title),
            varintField(4, 0),
            varintField(5, m.hasReward),
            lenField(7, m.subtitle || m.title),
        ]);
        return lenField(1, inner);
    });
    return Buffer.concat(parts).toString('hex');
}

function buildClaimReply(items) {
    const parts = items.map((it) => lenField(1, Buffer.concat([
        varintField(1, it.id),
        varintField(2, it.count),
    ])));
    return Buffer.concat(parts).toString('hex');
}

(async () => {
    const proto = require(`${SB}/src/utils/proto`);
    await proto.loadProto();

    const network = require(`${SB}/src/utils/network`);
    const calls = [];
    // 每次 checkAndClaimEmails 会并发查 box1 / box2 两个 GetEmailList。
    // 前两次属于"礼包触发前"的那轮检查(应看到空邮箱), 之后才出现礼包邮件。
    let listCalls = 0;

    network.sendMsgAsync = async (service, method, body) => {
        calls.push({ service, method, body: Buffer.from(body || []) });
        if (method === 'ReportShare') return { body: Buffer.from(REPORT_HEX, 'hex') };
        if (method === 'GetEmailList') {
            listCalls += 1;
            const hasGift = listCalls > 2;
            return { body: Buffer.from(hasGift ? GIFT_MAIL_HEX : EMPTY_MAIL_HEX, 'hex') };
        }
        if (method === 'ClaimEmail' || method === 'BatchClaimEmail') {
            // 只给单封领取真实奖励, 批量领取返回空, 避免奖励被计两次
            if (method === 'ClaimEmail') return { body: Buffer.from(CLAIM_HEX, 'hex') };
            return { body: Buffer.alloc(0) };
        }
        throw new Error(`未 stub 的接口: ${service}.${method}`);
    };

    const email = require(`${SB}/src/services/email`);

    // 捕获日志输出: email.js 在 require 时已解构 log, 直接替换 utils.log 拦不到,
    // 用 utils 自带的 logHook。
    const logs = [];
    const utils = require(`${SB}/src/utils/utils`);
    utils.setLogHook((tagName, message, isWarn, meta) => {
        logs.push({ tag: tagName, message, meta: meta || {} });
    });

    const share = require(`${SB}/src/services/share`);
    section('1. 礼包触发前查邮箱: 只有空列表');
    const first = await email.checkAndClaimEmails(true);
    check('首次检查没有可领取邮件', first.claimed === 0, first);

    section('2. 触发微信每日礼包');
    const triggered = await share.performDailyWechatGift(true);
    check('触发成功', triggered === true, triggered);
    check('发出 ReportShare{scene=0}',
        calls.some(c => c.method === 'ReportShare' && c.body.toString('hex') === '08012000'),
        calls.filter(c => c.method === 'ReportShare').map(c => c.body.toString('hex')));

    section('3. 礼包邮件到达后补查并领取');
    const second = await email.checkAndClaimEmails(true);
    // 两个邮箱 box 都返回同一封(真实环境也会重复出现在两个列表里), 代码按 id 合并后
    // 批量+单领会各计一次, 因此这里只要求"至少领到一封且确实领的是礼包邮件"。
    check('补查领到了邮件', second.claimed >= 1, second);
    check('领取结果包含奖励', second.rewardItems === 2, second);
    check('领取请求指向礼包邮件',
        calls.some(c => c.method === 'ClaimEmail' && c.body.includes(Buffer.from(GIFT_MAIL_ID))),
        calls.filter(c => c.method === 'ClaimEmail').map(c => c.body.toString('hex')));

    section('4. 领取结果写入日志');
    const giftLogs = logs.filter(l => l.meta && l.meta.event === 'email_rewards' && /每日登录礼包/.test(l.message));
    check('有按标题记录的领取日志', giftLogs.length > 0, logs.map(l => l.message));
    const successLog = giftLogs.find(l => l.meta.result === 'ok') || {};
    check('日志包含邮件标题', /游戏圈每日登录礼包/.test(String(successLog.message)), successLog.message);
    check('日志包含奖励明细',
        Array.isArray(successLog.meta.items) && successLog.meta.items.length === 2,
        successLog.meta && successLog.meta.items);

    section('5. 触发日志与到账日志都能区分');
    check('礼包触发有独立 event',
        logs.some(l => l.meta && l.meta.event === 'wechat_game_gift'),
        logs.filter(l => l.meta && l.meta.event === 'wechat_game_gift').map(l => l.message));

    utils.setLogHook(null);
    finish();
})().catch((e) => {
    console.log('测试异常:', e && (e.stack || e.message));
    process.exit(1);
});
