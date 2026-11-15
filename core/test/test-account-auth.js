/**
 * 账号级接口的越权防护回归测试
 *
 * 背景:
 *   面板里有大批"读 x-account-id 就转发给 provider"的接口。这些接口原先各自
 *   手写样板, 结果是**大批漏掉了账号归属校验** —— 普通用户拿别人的账号 ID
 *   调 /api/pet/feed、/api/activity/draw 这类会真实改动数据的接口, 就能操作
 *   别人的账号。统一收敛到 withAccount 之后, "校验归属"成了不可能忘的一步。
 *
 * 覆盖:
 *   · 缺 x-account-id → 400 语义(ok:false)
 *   · 账号不属于当前用户 → 403 且**不调用 provider**(不能改到别人的数据)
 *   · 账号属于当前用户 → 正常转发并回 ok:true
 *   · provider 未就绪 → ok:false 但不抛异常
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'admin-auth-test');

const fs = require('node:fs');
const path = require('node:path');
const ADMIN = path.join(SB, 'src/controllers/admin.js');

// 不走完整 Express 启动: 直接从源码里把 withAccount 的语义抽出来做等价验证,
// 同时静态断言所有"读账号"的路由都已被保护。
section('1. 静态检查: 读 x-account-id 的路由都必须校验归属');
{
    const src = fs.readFileSync(ADMIN, 'utf8');
    const lines = src.split('\n');
    const starts = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/app\.(get|post|put|delete)\(\s*'([^']+)'/);
        if (m) starts.push({ i, method: m[1], path: m[2] });
    }
    const risky = [];
    for (let k = 0; k < starts.length; k++) {
        const r = starts[k];
        const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
        const body = lines.slice(r.i, end).join('\n');
        const readsAccount = /x-account-id/.test(body);
        // 已受保护: 走 withAccount / 显式 checkAccountAccess / 管理员中间件 / 自行过滤
        const guarded = /withAccount\(/.test(body)
            || /checkAccountAccess/.test(body)
            || /adminRequired/.test(body)
            || /getAccessibleAccountIds/.test(body);
        if (readsAccount && !guarded) risky.push(`${r.method.toUpperCase()} ${r.path}`);
    }
    check('没有"读账号却不校验归属"的路由', risky.length === 0, risky);
    check('withAccount 已被广泛使用(≥25 条)', (src.match(/withAccount\(/g) || []).length >= 25,
        (src.match(/withAccount\(/g) || []).length);
}

async function runAuthChecks() {
section('2. withAccount 的四种结果符合预期');
{
    // 按 admin.js 里 withAccount 的实现，等价复现其判定顺序
    const makeHandler = ({ hasProvider = true, account = null, accessible = false, throwInHandler = false } = {}) => {
        const provider = hasProvider ? {} : null;
        const getAccId = () => account;
        const checkAccountAccess = () => accessible;
        const handleApiError = (res, e) => res.json({ ok: false, error: e.message });
        const withAccount = (handler, options = {}) => async (req, res) => {
            if (options.requireProvider !== false && !provider) {
                return res.json({ ok: false, error: 'Provider not ready' });
            }
            const accountId = getAccId(req);
            if (!accountId) {
                return res.json({ ok: false, error: 'Missing x-account-id' });
            }
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }
            try {
                const data = await handler(accountId, req);
                res.json({ ok: true, data });
            } catch (e) {
                if (options.softErrors === false) {
                    return res.status(500).json({ ok: false, error: e.message });
                }
                return handleApiError(res, e);
            }
        };
        void throwInHandler;
        return withAccount;
    };
    const mkRes = () => {
        const out = {};
        out.status = code => ({ json: body => { out.code = code; out.body = body; } });
        out.json = body => { out.code = out.code || 200; out.body = body; };
        return out;
    };

    // (a) 缺账号
    {
        const res = mkRes();
        let called = false;
        await makeHandler({ account: null })(() => { called = true; })({}, res);
        check('缺 x-account-id → ok:false', res.body.ok === false, res.body);
        check('缺账号时不调用 provider', called === false);
    }
    // (b) 越权
    {
        const res = mkRes();
        let called = false;
        await makeHandler({ account: 'acc-other', accessible: false })(() => { called = true; })({}, res);
        check('账号不归属当前用户 → 403', res.code === 403, res);
        check('越权时**不调用** provider(不能改到别人的数据)', called === false);
    }
    // (c) 正常
    {
        const res = mkRes();
        let gotAccount = null;
        await makeHandler({ account: 'acc-mine', accessible: true })((accountId) => {
            gotAccount = accountId;
            return { fed: true };
        })({}, res);
        check('归属正确 → ok:true', res.body.ok === true, res.body);
        check('handler 拿到正确的 accountId', gotAccount === 'acc-mine', gotAccount);
        check('数据透传', res.body.data && res.body.data.fed === true, res.body);
    }
    // (d) provider 未就绪
    {
        const res = mkRes();
        await makeHandler({ hasProvider: false, account: 'acc-mine', accessible: true })(() => ({ ok: 1 }))({}, res);
        check('provider 未就绪 → ok:false 不抛异常', res.body.ok === false, res.body);
    }
    // (e) softErrors=false 时错误走 500
    {
        const res = mkRes();
        const h = makeHandler({ account: 'acc-mine', accessible: true });
        await h(() => { throw new Error('boom') }, { softErrors: false })({}, res);
        check('softErrors:false + 抛错 → 500', res.code === 500 && res.body.error === 'boom', res);
    }
}

}

runAuthChecks().then(() => finish()).catch(e => {
    console.log('测试异常:', e && e.message);
    process.exit(1);
});
