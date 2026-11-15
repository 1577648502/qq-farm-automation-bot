/**
 * 好友拜访流程回归测试
 *
 * friend.js 是第二大服务(2000+ 行)却长期零测试。这里只覆盖最关键的
 * "拜访前奏/收尾"契约 —— 它刚被抽成 withFriendFarm, 帮忙和偷菜两条路径共用:
 *
 *   · 进入失败(已自动处理: 加黑名单/移出列表) → 不记错误日志, acted=false
 *   · 进入失败(未处理) → 记一条 warn, acted=false
 *   · 没有地块 → 必须 leave 再返回 acted=false
 *   · 正常 → 执行动作, 返回 acted
 *   · **业务动作抛错时也必须 leave**(否则服务端一直认为在别人农场)
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'friend-visit-test';
isolateDataDir(SB, 'friend-visit-test');

const proto = require(`${SB}/src/utils/proto`);

proto.loadProto().then(async () => {
    const friend = require(`${SB}/src/services/friend`);
    const fn = friend.__privateFriendFns;
    check('withFriendFarm 已导出供测试', !!fn && typeof fn.withFriendFarm === 'function',
        fn && Object.keys(fn));

    if (!fn || typeof fn.withFriendFarm !== 'function') {
        return finish();
    }

    const { withFriendFarm } = fn;
    const warns = [];
    const { setLogHook } = require(`${SB}/src/utils/utils`);
    setLogHook((tag, msg, isWarn) => { if (isWarn) warns.push(String(msg)) });

    const makeHooks = ({ enterError = null, lands = null } = {}) => {
        const calls = [];
        return {
            calls,
            enter: async () => {
                calls.push('enter');
                if (enterError) throw enterError;
                return { lands: lands || [] };
            },
            leave: async () => { calls.push('leave') },
            handleError: () => ({ handled: true, kind: 'blacklist' }),
        };
    };

    section('1. 进入失败且已自动处理 → 不记错误日志');
    {
        warns.length = 0;
        const hooks = makeHooks({ enterError: new Error('好友已加黑名单') });
        const r = await withFriendFarm(
            { gid: 1, name: 'A' }, 1, 'acc',
            async () => { throw new Error('不该被调用') },
            hooks,
        );
        check('acted=false / entered=false', r.acted === false && r.entered === false, r);
        check('没有留错误日志', warns.length === 0, warns);
        check('没有调用 leave(压根没进去)', !hooks.calls.includes('leave'), hooks.calls);
    }

    section('2. 进入失败且未自动处理 → 记一条 warn');
    {
        warns.length = 0;
        const hooks = makeHooks({ enterError: new Error('网络错误') });
        hooks.handleError = () => ({ handled: false });
        await withFriendFarm({ gid: 2, name: 'B' }, 1, 'acc', async () => 'x', hooks);
        check('留了一条错误日志', warns.length === 1, warns);
        check('日志里带好友名', warns[0].includes('B'), warns);
    }

    section('3. 没有地块 → 先 leave 再返回');
    {
        const hooks = makeHooks({ lands: [] });
        const r = await withFriendFarm({ gid: 3, name: 'C' }, 1, 'acc', async () => 'x', hooks);
        check('entered=true 但 acted=false', r.acted === false && r.entered === true, r);
        check('确实调用了 leave', hooks.calls.includes('leave'), hooks.calls);
        check('leave 在 enter 之后', hooks.calls.indexOf('leave') > hooks.calls.indexOf('enter'), hooks.calls);
    }

    section('4. 正常拜访 → 执行动作并返回结果');
    {
        const hooks = makeHooks({ lands: [{ id: 1, unlocked: true }] });
        let gotLands = null;
        const r = await withFriendFarm({ gid: 4, name: 'D' }, 1, 'acc', async (lands) => {
            gotLands = lands;
            return { acted: true, entered: true };
        }, hooks);
        check('回调拿到地块', Array.isArray(gotLands) && gotLands.length === 1, gotLands);
        check('返回回调结果', r.acted === true, r);
        check('也调用了 leave', hooks.calls.includes('leave'), hooks.calls);
    }

    section('5. 业务动作抛错时也必须 leave');
    {
        const hooks = makeHooks({ lands: [{ id: 1, unlocked: true }] });
        let threw = null;
        try {
            await withFriendFarm({ gid: 5, name: 'E' }, 1, 'acc', async () => {
                throw new Error('业务炸了');
            }, hooks);
        } catch (e) { threw = e; }
        check('异常继续向上抛', !!threw && threw.message === '业务炸了', threw);
        check('仍然调用了 leave(否则服务端认为一直在别人农场)', hooks.calls.includes('leave'), hooks.calls);
    }

    setLogHook(null);
    finish();
}).catch(e => {
    console.log('测试异常:', e && e.message);
    process.exit(1);
});
