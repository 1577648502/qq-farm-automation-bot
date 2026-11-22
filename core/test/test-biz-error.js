/**
 * biz-error 工具回归测试 (2026-11-22 牧歌日志降噪的通用化防回归)
 *
 * 覆盖:
 *   1. isBizStateError: 11 类业务态语料命中, 真失败不误判, Error/字符串/空值入参
 *   2. shortNetErr: 网络层前缀压缩成 "code=NNNN 原因", 无 code= 原样返回, 多空格压一
 *   3. 无回溯: 超长对抗性输入正常返回(切片实现, 无多项式复杂度)
 *   4. 接线防回归: 4 个业务态误报站点(charity/monthcard/mall/email)与
 *      worker/redpacket 熔断接线仍在位
 */
const fs = require('node:fs');
const path = require('node:path');
const { isBizStateError, shortNetErr } = require('../src/utils/biz-error');
const { createChecker } = require('./harness');

const t = createChecker();
const SRC = path.join(__dirname, '..', 'src');

async function main() {
    t.section('isBizStateError: 业务态语料命中');
    {
        const samples = [
            'gamepb.activitypb.ActivityService.Operate 错误: code=1034162 该档位奖励已领取',
            'code=1031013 今日已领取看广告礼包',
            '领取失败: 奖励已领过',
            '今日已收取',
            '任务已完成, 无需重复操作',
            '今日已参与该活动',
            '当前状态不可领取',
            '暂无可领取奖励',
            '领取次数已用完',
            '超出限购次数',
            '活动已过期',
            '请勿重复领取',
        ];
        for (const s of samples) {
            t.check(`命中: ${s.slice(0, 30)}...`, isBizStateError(s) === true);
        }
    }

    t.section('isBizStateError: 真失败不误判');
    {
        const realFails = [
            'gamepb.emailpb.EmailService.GetEmailList 错误: code=1034199 服务器内部错误',
            'code=1000020 请求参数错误',
            '连接未打开',
            'timeout of 8000ms exceeded',
            '',
            '服务器开小差了',
        ];
        for (const s of realFails) {
            t.check(`不误判: ${s || '(空串)'}`, isBizStateError(s) === false);
        }
    }

    t.section('isBizStateError: 入参形态');
    {
        t.check('Error 对象', isBizStateError(new Error('code=1034162 已领取')) === true);
        t.check('Error 对象(真失败)', isBizStateError(new Error('code=1034199 服务器内部错误')) === false);
        t.check('null → false', isBizStateError(null) === false);
        t.check('undefined → false', isBizStateError(undefined) === false);
        t.check('数字入参 → false', isBizStateError(12345) === false);
    }

    t.section('shortNetErr: 前缀压缩');
    {
        t.check(
            '标准网络层前缀',
            shortNetErr(new Error('gamepb.activitypb.ActivityService.Operate 错误: code=1034162 该档位奖励已领取'))
                === 'code=1034162 该档位奖励已领取',
        );
        t.check(
            '消息本体无空格',
            shortNetErr('EmailService.ClaimEmail 错误: code=1031013今日已领取')
                === 'code=1031013今日已领取',
        );
        t.check(
            '码后多空格压成一个',
            shortNetErr('Service.Method 错误: code=1001    多空格原因')
                === 'code=1001 多空格原因',
        );
        t.check(
            '无 code= 原样返回',
            shortNetErr(new Error('连接未打开')) === '连接未打开',
        );
        t.check('null → "null" 字符串', shortNetErr(null) === 'null');
        t.check('空串 → 空串', shortNetErr('') === '');
        t.check(
            'code= 出现在中间时从首个 code= 起截取',
            shortNetErr('前缀 code=9 提示, 详情 code=1034199 服务器内部错误')
                === 'code=9 提示, 详情 code=1034199 服务器内部错误',
        );
    }

    t.section('shortNetErr: 无回溯(超长对抗输入, 切片实现应瞬时返回)');
    {
        // 对抗性语料: 大量 "code=" + 无空格长尾, 若用贪婪正则会多项式爆炸
        const evil = `${'code=123 '.repeat(2000)}${'x'.repeat(100000)}已领取`;
        const started = Date.now();
        const out = shortNetErr(evil);
        const cost = Date.now() - started;
        t.check('超长输入正常返回', typeof out === 'string' && out.length > 0);
        t.check(`耗时受控(${cost}ms < 500ms)`, cost < 500);
        t.check('结果从首个 code= 起', out.startsWith('code=123 '));
    }

    t.section('接线防回归: 4 个业务态站点已接入');
    {
        const wiring = [
            ['services/charity.js', "require('../utils/biz-error')"],
            ['services/monthcard.js', "require('../utils/biz-error')"],
            ['services/mall.js', "require('../utils/biz-error')"],
            ['services/email.js', "require('../utils/biz-error')"],
            ['services/activity.js', "require('../utils/biz-error')"],
        ];
        for (const [rel, needle] of wiring) {
            const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
            t.check(`${rel} 引入 biz-error`, src.includes(needle));
        }
        for (const rel of ['services/charity.js', 'services/monthcard.js', 'services/mall.js', 'services/email.js']) {
            const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
            t.check(`${rel} 使用 isBizStateError 分流`, src.includes('isBizStateError(e)'));
            t.check(`${rel} 使用 shortNetErr 压缩`, src.includes('shortNetErr(e)'));
        }
    }

    t.section('接线防回归: worker 周期任务熔断 + redpacket 熔断');
    {
        const worker = fs.readFileSync(path.join(SRC, 'core/worker.js'), 'utf8');
        const wrappers = [
            ['BUY_BOOK_BREAKER', 'runBuyChallengeBooks'],
            ['LIMITED_PACK_BREAKER', 'runBuyLimitedPacks'],
            ['COLLECTION_BREAKER', 'runCollection'],
            ['AUTUMN_WISH_BREAKER', 'runAutumnWish'],
            ['FIREWORK_BREAKER', '放烟花'],
            ['HAPPY_SHARE_BREAKER', 'runHappyShare'],
            ['AD_GIFT_BREAKER', 'runAdGift'],
            ['MILK_TEA_BREAKER', 'runMilkTea'],
        ];
        for (const [breaker, fn] of wrappers) {
            const guard = new RegExp(`${breaker}\\.isOpen\\(\\)`);
            const failCall = new RegExp(`${breaker}\\.failure\\(\\)`);
            t.check(`worker: ${fn} 挂 ${breaker}(入口守卫+failure)`, guard.test(worker) && failCall.test(worker));
        }

        const rp = fs.readFileSync(path.join(SRC, 'services/redpacket.js'), 'utf8');
        t.check('redpacket: 引入 createFailureBreaker', rp.includes("require('../utils/failure-breaker')"));
        t.check('redpacket: 入口守卫', /RED_PACKET_BREAKER\.isOpen\(\)/.test(rp));
        t.check('redpacket: 查询/领取 failure 上报', (rp.match(/RED_PACKET_BREAKER\.failure\(\)/g) || []).length === 2);
        t.check('redpacket: 熔断即 break 不再打同轮后续红包', /if \(st\) \{/.test(rp) && /break;/.test(rp));
    }

    t.finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
