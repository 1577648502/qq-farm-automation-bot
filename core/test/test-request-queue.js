/**
 * 请求队列排队机制 回归测试 (2026-11-28)
 *
 * 线上问题: 单 worker 里农场巡检(3-5s)/活动任务/牧场(20-25s)/神秘商店/以薯换福
 *   并发撞车, pending 一到 5 sendMsgAsync 就直接 reject "请求队列已满",
 *   任务丢一轮还要等下个周期重试。2h 日志里平均 ~1.5 次/小时。
 *
 * 改造: 队列满改为 FIFO 排队等槽位(响应/超时/断连释放槽位时按序放行),
 *   心跳永不排队(保活优先), 排队硬上限 50(超过恢复直接拒绝), 排队等待
 *   有超时兜底(请求 timeout + FARM_QUEUE_WAIT_EXTRA_MS)。
 *
 * 锁住的不变量:
 *   1) 满 5 时新请求不 reject, 进等待队列
 *   2) 一个响应回来 → 恰好放行一个排队请求(FIFO)
 *   3) 断连(rejectAllPendingRequests) → 在途+排队全部释放
 *   4) 心跳在满载时也直接发(不排队)
 *   5) 排队等待超时会拒绝(文案含"请求超时", 归软错误)
 *   6) 排队硬上限 50: 第 51 个恢复直接拒绝"请求队列已满"
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'queue-test';
process.env.FARM_QUEUE_WAIT_EXTRA_MS = '300';
isolateDataDir(SB, 'queue-test');

const { types } = require(`${SB}/src/utils/proto`);
const protobuf = require('protobufjs');

// ⚠ 钩子必须装在 require network 之前: network.js 顶层就 require('ws'),
//   后装钩子它已经拿到真 ws 了。回包入口: network 自己会
//   ws.on('message', handleMessage), 对假 ws emit('message', 帧) 等于调 handleMessage。
const Module = require('node:module');
const origResolve = Module._resolveFilename;
let fakeWsInstance = null;
class FakeWS {
    // network.js 用 WebSocket.OPEN 常量比对 readyState, 假类也必须带
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor() {
        this.readyState = 0; // CONNECTING
        this.sent = [];
        this.listeners = {};
        fakeWsInstance = this;
    }
    set binaryType(_) {}
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    removeAllListeners() { this.listeners = {}; }
    close() {
        this.readyState = 3;
        for (const fn of (this.listeners.close || [])) fn(1000, Buffer.alloc(0));
    }
    emit(ev, ...args) {
        for (const fn of (this.listeners[ev] || [])) fn(...args);
    }
    send(data) {
        this.sent.push(Buffer.from(data));
        return true;
    }
    /** 解出第 i 个请求帧的 client_seq 与方法名 */
    seqOf(i) {
        const frame = types.GateMessage.decode(this.sent[i]);
        return { seq: Number(frame.meta.client_seq), method: frame.meta.method_name };
    }
    /** 按方法名找请求帧(登录帧也混在 sent 里, 不能用裸下标) */
    findByMethod(method) {
        for (let i = 0; i < this.sent.length; i++) {
            const frame = types.GateMessage.decode(this.sent[i]);
            if (frame.meta.method_name === method && Number(frame.meta.message_type) === 1) {
                return { seq: Number(frame.meta.client_seq), method, index: i };
            }
        }
        return null;
    }
    /** 回所有还没回的请求帧(节间清理, 防悬挂超时定时器炸测试进程) */
    replyAll() {
        for (let i = 0; i < this.sent.length; i++) {
            const frame = types.GateMessage.decode(this.sent[i]);
            if (Number(frame.meta.message_type) === 1) {
                this.replyTo(Number(frame.meta.client_seq), frame.meta.method_name);
            }
        }
    }
    /** 注入一条 Response 帧(模拟服务端回包) */
    replyTo(seq, methodName, bodyBuf = Buffer.alloc(0)) {
        const frame = types.GateMessage.create({
            meta: {
                service_name: 'gamepb.userpb.UserService',
                method_name: methodName,
                message_type: 2,
                client_seq: seq,
                server_seq: 1,
            },
            body: bodyBuf,
        });
        this.emit('message', types.GateMessage.encode(frame).finish());
    }
    /** 回 LoginReply(空 basic 也行): sendLogin 走 sendMsg 也占 pending 槽,
     *  不回包它会永远占一个槽, 所有排队判定都会失真 */
    replyLogin() {
        let body = Buffer.alloc(0);
        try {
            const reply = types.LoginReply.create({
                basic: { gid: 123, name: 't', level: 1, gold: 0, exp: 0, diamond: 0 },
            });
            body = types.LoginReply.encode(reply).finish();
        } catch { body = Buffer.alloc(0); }
        const login = this.findByMethod('Login');
        if (login) this.replyTo(login.seq, 'Login', Buffer.from(body));
    }
}
Module._resolveFilename = function (request, ...rest) {
    if (request === 'ws') return 'fake-ws-stub';
    return origResolve.call(this, request, ...rest);
};
require.cache['fake-ws-stub'] = { id: 'fake-ws-stub', filename: 'fake-ws-stub', loaded: true, exports: FakeWS };

const net = require(`${SB}/src/utils/network`);
(async () => {
    // proto.js 的 loadProto 要 resources 目录, 这里只用到 GateMessage: 用
    // parse() 从内联 proto 源构建(比手工拼 Type/Field 可靠, protobufjs 8 的
    // Namespace 构造参数不同版本不一样)
    if (!types.GateMessage) {
        const parsed = protobuf.parse(`
            syntax = "proto3";
            package gatepb;
            message Meta {
                string service_name = 1;
                string method_name = 2;
                int32 message_type = 3;
                int64 client_seq = 4;
                int64 server_seq = 5;
                int64 error_code = 6;
                string error_message = 7;
            }
            message Message {
                Meta meta = 1;
                bytes body = 2;
            }
            message EventMessage {
                string message_type = 1;
                bytes body = 2;
            }
            message KickoutNotify {
                int64 reason = 1;
                string reason_message = 2;
            }
        `, { keepCase: true });
        // userpb.Login 系列: emit('open') 会触发 sendLogin, 编码这些类型
        const userParsed = protobuf.parse(`
            syntax = "proto3";
            package gamepb.userpb;
            message DeviceInfo {
                string client_version = 1;
                string sys_software = 2;
                string network = 3;
                string memory = 4;
                string device_id = 5;
            }
            message ReportData {
                string callback = 1;
                string cd_extend_info = 2;
                string click_id = 3;
                string clue_token = 4;
                string minigame_channel = 5;
                int32 minigame_platid = 6;
                string req_id = 7;
                string trackid = 8;
            }
            message LoginRequest {
                int64 sharer_id = 1;
                string sharer_open_id = 2;
                DeviceInfo device_info = 3;
                int64 share_cfg_id = 4;
                string scene_id = 5;
                ReportData report_data = 6;
            }
            message LoginReply {
                Basic basic = 1;
                int64 time_now_millis = 2;
                VersionInfo version_info = 3;
            }
            message Basic {
                int64 gid = 1;
                string name = 2;
                int32 level = 3;
                int64 gold = 4;
                int64 exp = 5;
                int64 diamond = 6;
                int32 ranch_level = 20;
                int64 ranch_exp = 21;
            }
            message VersionInfo {}
            message HeartbeatRequest {
                int64 host_gid = 1;
                string client_version = 2;
                int32 host_type = 3;
            }
            message HeartbeatReply {
                int64 server_time = 1;
            }
        `, { keepCase: true });
        const root = new protobuf.Root();
        root.add(parsed.root);
        root.add(userParsed.root);
        root.resolveAll();
        types.GateMessage = root.lookupType('gatepb.Message');
        // sendLogin/heartbeat 编码需要的类型(proto.js 原本从 resources 加载)
        types.LoginRequest = root.lookupType('gamepb.userpb.LoginRequest');
        types.LoginReply = root.lookupType('gamepb.userpb.LoginReply');
        types.HeartbeatRequest = root.lookupType('gamepb.userpb.HeartbeatRequest');
        types.HeartbeatReply = root.lookupType('gamepb.userpb.HeartbeatReply');
    }

    net.connect('test-code', null);
    // connect 是同步 new WebSocket, 立刻 open
    fakeWsInstance.readyState = 1;
    fakeWsInstance.emit('open');
    // sendLogin 是 async: 等它把 Login 帧写进 sent 再回包。
    // Login 也占 pending 槽(走 sendMsg), 不回包它会永远占一个槽,
    // 后续"满 5 排队"的判定全部失真
    await new Promise(r => setTimeout(r, 20));
    fakeWsInstance.replyLogin();
    await new Promise(r => setTimeout(r, 20));

    section('1. 队列满 → 排队而不是拒绝');
    {
        const LIMIT = 5;
        // 先发 5 个占满槽位(不回包)
        const inflight = [];
        for (let i = 0; i < LIMIT; i++) {
            inflight.push(net.sendMsgAsync('gamepb.userpb.UserService', `Op${i}`, Buffer.alloc(0), 20000).catch(e => `REJ:${e.message}`));
        }
        await new Promise(r => setTimeout(r, 20));
        // sent 里有 1 个 Login 帧 + 5 个业务帧
        check(fakeWsInstance.sent.length === LIMIT + 1, `5 个请求都上 wire (实际 ${fakeWsInstance.sent.length - 1})`);

        // 第 6 个: 旧逻辑这里直接 reject "请求队列已满", 新逻辑应排队 pending
        let queuedResolved = false, queuedRejected = false;
        const p6 = net.sendMsgAsync('gamepb.userpb.UserService', 'Op5', Buffer.alloc(0), 20000)
            .then(() => { queuedResolved = true; })
            .catch((e) => { queuedRejected = e.message; });
        await new Promise(r => setTimeout(r, 20));
        check(!queuedRejected, `第 6 个请求没有立刻被拒 (实际 ${queuedRejected})`);
        check(fakeWsInstance.sent.length === LIMIT + 1, '排队中的请求还没上 wire');

        // 回一个包 → 槽位释放 → Op5 应被放行上 wire。注意 sent[0] 是 Login 帧,
        // 用 findByMethod 精确回业务帧 —— 这同时验证 Login 这类不走
        // sendMsgAsync 的请求回包后也会 drain 排队队列
        const first = fakeWsInstance.findByMethod('Op0');
        fakeWsInstance.replyTo(first.seq, first.method);
        await new Promise(r => setTimeout(r, 30));
        check(fakeWsInstance.sent.length === LIMIT + 2, `Op5 被放行上 wire (业务帧 ${fakeWsInstance.sent.length - 1})`);
        // 回 Op5 的包让它完成
        const op5 = fakeWsInstance.findByMethod('Op5');
        fakeWsInstance.replyTo(op5.seq, op5.method);
        await p6;
        check(queuedResolved, `响应回来后排队的 Op5 被放行并完成 (实际 ${queuedRejected || 'resolved'})`);
        check(!queuedRejected, 'Op5 全程未被拒');
        void inflight;
        // 清场: 回完所有在途, 防悬挂定时器
        fakeWsInstance.replyAll();
        await new Promise(r => setTimeout(r, 20));
    }

    section('2. FIFO 顺序');
    {
        // 占满 5 个, 再排 3 个 (A, B, C), 回 5 个在途的包 → A, B, C 依次上 wire
        const inflight = [];
        for (let i = 0; i < 5; i++) {
            inflight.push(net.sendMsgAsync('gamepb.userpb.UserService', `Hold${i}`, Buffer.alloc(0), 20000).catch(() => {}));
        }
        await new Promise(r => setTimeout(r, 20));
        const order = [];
        const pa = net.sendMsgAsync('gamepb.userpb.UserService', 'QueuedA', Buffer.alloc(0), 20000).then(() => order.push('A'), () => order.push('A!'));
        const pb = net.sendMsgAsync('gamepb.userpb.UserService', 'QueuedB', Buffer.alloc(0), 20000).then(() => order.push('B'), () => order.push('B!'));
        const pc = net.sendMsgAsync('gamepb.userpb.UserService', 'QueuedC', Buffer.alloc(0), 20000).then(() => order.push('C'), () => order.push('C!'));
        await new Promise(r => setTimeout(r, 20));
        // 逐个回 5 个在途的包(注意 Login 帧混在里面, 按方法名找)
        for (let i = 0; i < 5; i++) {
            const hold = fakeWsInstance.findByMethod(`Hold${i}`);
            if (hold) fakeWsInstance.replyTo(hold.seq, hold.method);
        }
        await new Promise(r => setTimeout(r, 30));
        // 回 A/B/C 的包让它们完成
        fakeWsInstance.replyAll();
        await new Promise(r => setTimeout(r, 30));
        check(order.join('') === 'ABC', `FIFO 放行顺序 A→B→C (实际 ${order.join('')})`);
        void inflight;
    }

    section('3. 断连释放: 在途+排队一起 reject');
    {
        const inflight = [];
        for (let i = 0; i < 5; i++) {
            inflight.push(net.sendMsgAsync('gamepb.userpb.UserService', `Hold${i}`, Buffer.alloc(0), 20000)
                .then(() => 'resolved', e => `rejected: ${e.message}`));
        }
        await new Promise(r => setTimeout(r, 20));
        const queued = net.sendMsgAsync('gamepb.userpb.UserService', 'WillDrop', Buffer.alloc(0), 20000)
            .then(() => 'resolved', e => `rejected: ${e.message}`);
        await new Promise(r => setTimeout(r, 20));
        // 模拟 ws close → cleanup() → rejectAllPendingRequests
        fakeWsInstance.close();
        const qResult = await queued;
        check(qResult.includes('rejected'), `排队请求被断连释放 (实际 ${qResult})`);
        const settled = await Promise.all(inflight);
        check(settled.every(s => String(s).includes('rejected')),
            `在途请求也全部释放 (实际 ${settled.join(' | ')})`);
        // 重开连接供后续 section 使用
        net.connect('test-code', null);
        await new Promise(r => setTimeout(r, 10));
        fakeWsInstance.readyState = 1;
        fakeWsInstance.emit('open');
        await new Promise(r => setTimeout(r, 20));
        fakeWsInstance.replyLogin();
        await new Promise(r => setTimeout(r, 20));
        fakeWsInstance.replyAll();
        await new Promise(r => setTimeout(r, 20));
    }

    section('4. 心跳永不排队');
    {
        // 占满 5 个普通槽位
        const inflight = [];
        for (let i = 0; i < 5; i++) {
            inflight.push(net.sendMsgAsync('gamepb.userpb.UserService', `Hold${i}`, Buffer.alloc(0), 20000).catch(() => 'x'));
        }
        await new Promise(r => setTimeout(r, 20));
        const before = fakeWsInstance.sent.length;
        let hbResolved = false;
        const hb = net.sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', Buffer.alloc(0), 15000)
            .then(() => { hbResolved = true; }, () => { hbResolved = false; });
        await new Promise(r => setTimeout(r, 20));
        check(fakeWsInstance.sent.length === before + 1, `满载时心跳直接上 wire (实际 ${fakeWsInstance.sent.length - before} 帧)`);
        const last = fakeWsInstance.seqOf(fakeWsInstance.sent.length - 1);
        check(last.method === 'Heartbeat', `上 wire 的就是心跳 (实际 ${last.method})`);
        fakeWsInstance.replyTo(last.seq, 'Heartbeat');
        await hb;
        check(hbResolved, '心跳正常完成');
        void inflight;
        fakeWsInstance.replyAll();
        await new Promise(r => setTimeout(r, 20));
    }

    section('5. 排队等待超时兜底');
    {
        // FARM_QUEUE_WAIT_EXTRA_MS=300: 占满 5 个且永不回包 → 排队的请求应在
        // timeout+300ms 后被拒, 文案含"请求超时"(软错误分类)
        const inflight = [];
        for (let i = 0; i < 5; i++) {
            inflight.push(net.sendMsgAsync('gamepb.userpb.UserService', `Hold${i}`, Buffer.alloc(0), 20000).catch(() => 'x'));
        }
        await new Promise(r => setTimeout(r, 20));
        const t0 = Date.now();
        let err = null;
        await net.sendMsgAsync('gamepb.userpb.UserService', 'WaitTooLong', Buffer.alloc(0), 200)
            .catch(e => { err = e; });
        const waited = Date.now() - t0;
        check(!!err, '排队超时被拒绝');
        if (err) {
            check(err.message.includes('请求超时'), `文案含"请求超时"(软错误) (实际 ${err.message})`);
            check(err.message.includes('排队'), `文案说明是排队超时 (实际 ${err.message})`);
        }
        check(waited >= 250 && waited < 2000, `等待时长 ≈ timeout+300ms (实际 ${waited}ms)`);
        // 清场: 回掉这轮 5 个在途(它们的 20s 定时器还挂着)
        fakeWsInstance.replyAll();
        await new Promise(r => setTimeout(r, 20));
    }

    section('6. 排队硬上限 50');
    {
        // 占满 5, 排满 50, 第 51 个应直接拒绝"请求队列已满"
        const inflight = [];
        for (let i = 0; i < 5; i++) {
            inflight.push(net.sendMsgAsync('gamepb.userpb.UserService', `Hold${i}`, Buffer.alloc(0), 60000));
        }
        await new Promise(r => setTimeout(r, 20));
        const queued = [];
        for (let i = 0; i < 50; i++) {
            queued.push(net.sendMsgAsync('gamepb.userpb.UserService', `Q${i}`, Buffer.alloc(0), 60000)
                .catch(() => 'rejected'));
        }
        await new Promise(r => setTimeout(r, 20));
        let overRejected = null;
        await net.sendMsgAsync('gamepb.userpb.UserService', 'OverLimit', Buffer.alloc(0), 60000)
            .then(() => { overRejected = 'resolved'; })
            .catch(e => { overRejected = e.message; });
        check(overRejected && overRejected.includes('请求队列已满'), `第 51 个排队请求直接拒绝 (实际 ${overRejected})`);
        check(overRejected && overRejected.includes('waiting=50'), `错误信息带等待队列长度 (实际 ${overRejected})`);
    }

    net.cleanup('测试结束');
    finish();
})().catch((e) => { console.error(e); process.exit(1); });
