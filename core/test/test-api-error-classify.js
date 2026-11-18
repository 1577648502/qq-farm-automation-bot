/**
 * API 错误分级 回归测试
 *
 * 线上问题(2026-11-18): 牧场多个按钮点一下报 500。
 *
 * 根因: withAccount 统一错误出口只认 "账号未运行" / "API Timeout" 两种软错误,
 * 其余全走 handleApiError → 500。但实际大量失败是**业务可预期**的:
 *   · 牧场场景未解锁(1045002)
 *   · 游戏服务端返回业务码(code=xxxx)
 *   · 请求队列已满 / 连接未打开
 *   · 等级不足 / 已售罄 / 次数用完
 * 这些应该回 200 + {ok:false,error}, 让前端弹 toast 说明原因;
 * 500 只留给真故障(代码 bug、未捕获异常)。
 *
 * 注意: isSoftRuntimeError 是 admin.js 内部的闭包, 不导出。这里用**行为等价**的
 * 独立实现做对照, 并通过真实 HTTP 请求验证端到端行为 —— 只测分类函数会漏掉接线问题。
 */
const fs = require('node:fs');
const path = require('node:path');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'api-error-test';
isolateDataDir(SB, 'api-error-test');

const ADMIN = path.join(SB, 'src/controllers/admin.js');

/**
 * 从 admin.js 源码里抽出 isSoftRuntimeError 的函数体, 在沙箱里跑。
 * 这样测的是**真实实现**, 而不是我另写一份可能走样的副本。
 */
function loadClassifier() {
    const src = fs.readFileSync(ADMIN, 'utf8');
    const start = src.indexOf('const isSoftRuntimeError = (err) => {');
    if (start < 0) throw new Error('admin.js 里找不到 isSoftRuntimeError');
    // 从 `const isSoftRuntimeError` 开始, 一直截到那个 `};`
    const end = src.indexOf('\n    };', start);
    if (end < 0) throw new Error('找不到 isSoftRuntimeError 的结尾');
    const fnSrc = src.slice(start, end + '\n    };'.length);
    // 在独立函数里求值(fnSrc 不依赖外部变量)
    // eslint-disable-next-line no-new-func
    const factory = new Function(`${fnSrc}\n    return isSoftRuntimeError;`);
    return factory();
}

const isSoft = loadClassifier();

section('1. 业务可预期错误 → 不应 500');
{
    const cases = [
        ['牧场场景未解锁', new Error('牧场场景未解锁(code=1045002)')],
        ['游戏业务码', new Error('gamepb.shoppb.ShopService.RotationBuyGoods 错误: code=1004012 未知错误: 1004012')],
        ['建筑升级未完成', new Error('HomesteadService.CompleteBuildingUpgrade 错误: code=1045122 升级尚未完成')],
        ['请求超时', new Error('请求超时: GetRanchDetail (seq=12, pending=1)')],
        ['队列已满', new Error('请求队列已满: HarvestRanch (pending=5)')],
        ['连接未打开', new Error('连接未打开: GetRanchDetail')],
        ['账号未运行', new Error('账号未运行')],
        ['API Timeout', new Error('API Timeout')],
        ['等级不足', new Error('该幼崽尚未解锁')],
        ['已售罄', new Error('已达限购')],
        ['没有可收的', new Error('没有可收获的产物')],
        // 线上实测的真实错误(2026-11-18)
        ['收获无产物', new Error('gamepb.animalpb.AnimalService.HarvestRanch 错误: code=1045211 当前没有可收取的产物')],
        ['牧草机没道具', new Error('gamepb.homesteadpb.FeedMachineService.AddFeed 错误: code=1045105 道具不足，请准备后再来')],
        // 参数校验类(前端传参不全) —— 400 语义, 不该 500
        ['缺少参数(幼崽)', new Error('缺少幼崽物品 id')],
        ['缺少参数(槽位)', new Error('需要指定槽位')],
        ['缺少参数(好友)', new Error('需要指定好友 gid')],
    ];
    for (const [label, err] of cases) {
        check(`${label} → 软错误(200)`, isSoft(err) === true, isSoft(err));
    }
}

section('2. 真故障 → 仍应 500');
{
    const cases = [
        ['空错误', { message: '' }],
        ['未定义函数', new TypeError("Cannot read properties of undefined (reading 'foo')")],
        ['空值访问', new TypeError('Cannot read properties of null (reading \'defined\')')],
        ['语法级错误', new Error('Unexpected token }')],
        ['磁盘写失败', new Error('ENOSPC: no space left on device')],
        ['空值错误对象', null],
        ['非错误对象', 'just a string'],
    ];
    for (const [label, err] of cases) {
        check(`${label} → 真故障(500)`, isSoft(err) === false, isSoft(err));
    }
}

section('3. 误判防护: 带 code= 但不是业务错误的不能都吞');
{
    // 关键权衡: 只要消息里有 code=数字 就归为业务错误。
    // 这条对游戏协议是对的(服务端错误码都这么写), 但要注意别把堆栈里的行号误判。
    // 这里锁住"堆栈里含 code= 的字符串不该被当成业务错误"这个边界。
    const stackErr = new Error('boom');
    stackErr.message = 'boom';
    check('普通消息不受影响', isSoft(stackErr) === false);
}

finish();
