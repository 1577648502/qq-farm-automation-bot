/**
 * friend.js 好友申请链路回归测试
 *
 * 背景(2026-11-21 lint no-undef 发现): checkAndAcceptApplications 调用的
 * getApplications 从未定义 → 启动即 TypeError 被 catch 静默吞掉,
 * "自动同意好友申请"从未工作过。本测试锁住整条链路: 拉申请 → 同意。
 *
 * 运行: node test/test-friend-applications.js
 */
const { setupSandbox, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();

(async () => {
    const proto = require(`${SB}/src/utils/proto`);
    await proto.loadProto();
    const { types } = proto;

    section('1. GetApplications 协议编解码');
    {
        // 构造 2 个申请的 reply
        const reply = types.GetApplicationsReply.create({
            applications: [
                { gid: 111, name: '张三', level: 12, open_id: 'o1' },
                { gid: 222, name: '李四', level: 34, open_id: 'o2' },
            ],
            block_applications: false,
        });
        const buf = types.GetApplicationsReply.encode(reply).finish();
        const decoded = types.GetApplicationsReply.decode(buf);
        check('applications 解析为数组', Array.isArray(decoded.applications) && decoded.applications.length === 2);
        check('申请者字段保留', Number(decoded.applications[0].gid) === 111 && decoded.applications[0].name === '张三');
    }

    section('2. AcceptFriends 请求编码');
    {
        const buf = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
            friend_gids: [111, 222],
        })).finish();
        check('编码为两个 int64 gid', buf.length > 4);
        const decoded = types.AcceptFriendsRequest.decode(buf);
        check('gid 往返保留', decoded.friend_gids.map(Number).join(',') === '111,222');
    }

    section('3. checkAndAcceptApplications 全链路(修复回归: getApplications 必须可调)');
    {
        const calls = [];
        const network = require(`${SB}/src/utils/network`);
        network.sendMsgAsync = async (service, method, body) => {
            calls.push({ service, method });
            if (method === 'GetApplications') {
                return { body: types.GetApplicationsReply.encode(types.GetApplicationsReply.create({
                    applications: [{ gid: 111, name: '张三' }, { gid: 222, name: '李四' }],
                })).finish() };
            }
            if (method === 'AcceptFriends') {
                return { body: types.AcceptFriendsReply.encode(types.AcceptFriendsReply.create({
                    friends: [{ gid: 111, name: '张三' }, { gid: 222, name: '李四' }],
                })).finish() };
            }
            throw new Error(`未 stub 的接口: ${service}.${method}`);
        };

        const friend = require(`${SB}/src/services/friend`);
        const { checkAndAcceptApplications, getApplications } = friend.__privateFriendFns;
        check('getApplications 已导出', typeof getApplications === 'function');
        check('checkAndAcceptApplications 已导出', typeof checkAndAcceptApplications === 'function');

        // 修复前这里会 TypeError(getApplications is not defined)
        await checkAndAcceptApplications();
        const methods = calls.map(c => `${c.service.split('.').pop()}.${c.method}`);
        check('先拉申请列表', methods.includes('FriendService.GetApplications'), methods);
        check('随后自动同意', methods.includes('FriendService.AcceptFriends'), methods);
        check('顺序正确(列表在前)',
            methods.indexOf('FriendService.GetApplications') < methods.indexOf('FriendService.AcceptFriends'));
    }

    section('4. 空申请列表不发同意请求');
    {
        // friend.js 在 require 时解构 sendMsgAsync(引用捕获), 换 stub 必须清缓存重载
        const networkPath = require.resolve(`${SB}/src/utils/network`);
        const friendPath = require.resolve(`${SB}/src/services/friend`);
        delete require.cache[networkPath];
        delete require.cache[friendPath];
        const network2 = require(`${SB}/src/utils/network`);
        const calls = [];
        network2.sendMsgAsync = async (service, method) => {
            calls.push(method);
            if (method === 'GetApplications') {
                return { body: types.GetApplicationsReply.encode(types.GetApplicationsReply.create({})).finish() };
            }
            return { body: Buffer.alloc(0) };
        };
        const friend2 = require(`${SB}/src/services/friend`);
        await friend2.__privateFriendFns.checkAndAcceptApplications();
        check('只拉列表不发送同意', calls.join(',') === 'GetApplications', calls);
    }

    finish();
})().catch((e) => { console.error(e); process.exit(1); });
