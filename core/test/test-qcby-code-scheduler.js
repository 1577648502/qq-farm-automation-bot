/**
 * qcby 单账号热更新回归测试
 *
 * 覆盖:
 *   · 只请求指定账号，不触发其他账号
 *   · 取码结果应用到目标账号并返回动作
 *   · 失败原因透传
 *   · 同账号重入保护
 *   · 基础配置校验
 */
const path = require('node:path');
const { setupSandbox, createChecker } = require('./harness');

const sandbox = setupSandbox();
const { createQcbyCodeScheduler } = require(path.join(sandbox, 'src/runtime/qcby-code-scheduler'));
const { section, check, finish } = createChecker();

function makeScheduler(overrides = {}) {
    const calls = {
        fetch: [],
        apply: [],
        save: [],
    };
    const config = {
        enabled: false,
        baseUrl: 'http://qcby.test',
        protocol: 'mywc',
        appid: 'wx-default',
        accounts: [
            { accountId: 'qcby', wxid: 'wxid-qcby', ref: '', appid: '', protocol: '' },
            { accountId: 'other', wxid: '', ref: 'ref-other', appid: 'wx-app', protocol: 'yyb' },
        ],
        ...overrides.config,
    };
    const scheduler = createQcbyCodeScheduler({
        config,
        log: () => {},
        fetchCode: async (options) => {
            calls.fetch.push(options);
            if (overrides.fetchCode) return overrides.fetchCode(options, calls);
            return { ok: true, code: 'code-' + options.protocol + '-' + (options.wxid || options.ref) };
        },
        saveAccountCode: (accountId, code) => calls.save.push({ accountId, code }),
        refreshAccountCode: async (accountId, code) => {
            calls.apply.push({ accountId, code });
            if (overrides.applyCode) return overrides.applyCode(accountId, code, calls);
            return { ok: true, started: true };
        },
    });
    return { scheduler, calls, config };
}

async function run() {
    section('1. 未绑定账号直接拒绝');
    {
        const { scheduler, calls } = makeScheduler();
        const result = await scheduler.refreshAccount('missing');
        check('返回 no_mapping', result.ok === false && result.reason === 'no_mapping', result);
        check('没有发起取码请求', calls.fetch.length === 0, calls.fetch);
    }

    section('2. 单账号热更新只处理目标账号');
    {
        const { scheduler, calls } = makeScheduler();
        const result = await scheduler.refreshAccount('qcby');
        check('刷新成功', result.ok === true && result.action === 'started', result);
        check('只请求 qcby 一次', calls.fetch.length === 1 && calls.fetch[0].wxid === 'wxid-qcby', calls.fetch);
        check('继承默认 appid', calls.fetch[0].appid === 'wx-default', calls.fetch[0]);
        check('取码结果应用到 qcby', calls.apply.length === 1 && calls.apply[0].accountId === 'qcby', calls.apply);
        check('其他账号没有启动取码', !calls.fetch.some(item => item.ref === 'ref-other'), calls.fetch);
    }

    section('3. 账号级协议与 appid 覆盖默认值');
    {
        const { scheduler, calls } = makeScheduler();
        const result = await scheduler.refreshAccount('other');
        check('刷新成功', result.ok === true, result);
        check('使用 yyb 和 ref', calls.fetch[0].protocol === 'yyb' && calls.fetch[0].ref === 'ref-other', calls.fetch[0]);
        check('使用账号 appid', calls.fetch[0].appid === 'wx-app', calls.fetch[0]);
    }

    section('4. 取码失败原因透传');
    {
        const { scheduler, calls } = makeScheduler({
            fetchCode: async () => ({ ok: false, reason: 'missing_wxid' }),
        });
        const result = await scheduler.refreshAccount('qcby');
        check('返回原始失败原因', result.ok === false && result.reason === 'missing_wxid', result);
        check('失败时不应用 code', calls.apply.length === 0, calls.apply);
    }

    section('5. 保留在线会话时返回 updated_only');
    {
        const { scheduler } = makeScheduler({
            applyCode: async () => ({ ok: true, skipped: 'stealth_keep_running' }),
        });
        const result = await scheduler.refreshAccount('qcby');
        check('返回 updated_only', result.ok === true && result.action === 'updated_only', result);
    }

    section('6. 同账号重入保护');
    {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const { scheduler, calls } = makeScheduler({
            fetchCode: async () => {
                await gate;
                return { ok: true, code: 'slow-code' };
            },
        });
        const first = scheduler.refreshAccount('qcby');
        await Promise.resolve();
        const second = await scheduler.refreshAccount('qcby');
        check('第二次返回 in_progress', second.ok === false && second.reason === 'in_progress', second);
        release();
        const firstResult = await first;
        check('第一次正常完成', firstResult.ok === true, firstResult);
        check('只发起一次请求', calls.fetch.length === 1, calls.fetch);
    }

    section('7. 缺少基础配置时不发请求');
    {
        const { scheduler, calls } = makeScheduler({
            config: {
                appid: '',
                accounts: [{ accountId: 'qcby', wxid: 'wxid-qcby', ref: '', appid: '', protocol: '' }],
            },
        });
        const result = await scheduler.refreshAccount('qcby');
        check('返回 missing_appid', result.ok === false && result.reason === 'missing_appid', result);
        check('没有请求取码服务', calls.fetch.length === 0, calls.fetch);
    }

    finish();
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
