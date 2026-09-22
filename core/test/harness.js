/**
 * 测试沙箱: 让回归测试自给自足地跑(不依赖 /tmp 里手工准备的副本)
 *
 * 为什么要沙箱:
 *   服务里不少模块用**模块级变量**存状态(连接/调度器/配置), 直接对真实 src 跑会互相污染,
 *   也会往 core/data 写测试数据。沙箱 = src 的副本 + node_modules 软链,
 *   数据目录再用 runtime-paths 打桩重定向到临时目录。
 *
 * 用法:
 *   const { setupSandbox, isolateDataDir, makeCaptureReplayer, createChecker } = require('./harness');
 *   const SB = setupSandbox();
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const process = require('node:process');

const CORE = path.join(__dirname, '..');
const SANDBOX = process.env.FARM_TEST_SANDBOX || path.join(os.tmpdir(), 'qqfarm-test-sandbox');

/** 准备沙箱: 复制 core/src + 软链 core/node_modules; 幂等, 每次都刷新 src */
function setupSandbox() {
    const srcDst = path.join(SANDBOX, 'src');
    fs.mkdirSync(SANDBOX, { recursive: true });
    fs.rmSync(srcDst, { recursive: true, force: true });
    fs.cpSync(path.join(CORE, 'src'), srcDst, { recursive: true });

    const nm = path.join(SANDBOX, 'node_modules');
    if (!fs.existsSync(nm)) {
        try { fs.symlinkSync(path.join(CORE, 'node_modules'), nm, 'dir'); }
        catch (e) { fs.cpSync(path.join(CORE, 'node_modules'), nm, { recursive: true }); }
    }
    const pkg = path.join(SANDBOX, 'package.json');
    if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'sandbox', version: '0.0.0' }, null, 2));
    return SANDBOX;
}

/** 数据目录重定向到临时目录, 避免污染 core/data; 必须在 require 业务模块之前调用 */
function isolateDataDir(sandbox, tag = 'test') {
    const dir = path.join(os.tmpdir(), 'qqfarm-data-' + tag);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const rp = require(path.join(sandbox, 'src/config/runtime-paths'));
    rp.getDataFile = (f) => path.join(dir, f);
    rp.getDataDir = () => dir;
    return dir;
}

/** 用「抓包帧」回放网络响应: key = "service.Method" */
function makeCaptureReplayer(sandbox, captureFile) {
    const { types } = require(path.join(sandbox, 'src/utils/proto'));
    const replies = {};
    if (fs.existsSync(captureFile)) {
        for (const line of fs.readFileSync(captureFile, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            if (j.ev || j.dir !== 'S->C' || !j.hex) continue;
            (replies[j.key] = replies[j.key] || []).push(Buffer.from(j.hex, 'hex'));
        }
    }
    const cursor = {};
    const bodyOf = (hexBuf) => {
        const msg = types.GateMessage.decode(hexBuf);
        return Buffer.from(msg.body || []);
    };
    return {
        /** 把沙箱 network.sendMsgAsync 换成回放实现 */
        install(network) {
            network.sendMsgAsync = async (service, method) => {
                const key = service + '.' + method;
                const list = replies[key] || [];
                if (!list.length) throw new Error('抓包里没有 ' + key);
                const i = cursor[key] || 0;
                cursor[key] = (i + 1) % list.length;
                return { body: bodyOf(list[i]) };
            };
        },
        has: (key) => !!(replies[key] && replies[key].length),
    };
}

/** 极简断言器(与既有测试风格一致) */
function createChecker() {
    let pass = 0;
    const fails = [];
    return {
        section: (t) => console.log('\n── ' + t),
        check: (name, cond, extra) => {
            if (cond) pass += 1;
            else fails.push(name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
        },
        finish: () => {
            console.log('\n通过 ' + pass + ' / ' + (pass + fails.length));
            if (fails.length) {
                console.log('✗ 失败:');
                fails.forEach(f => console.log('  - ' + f));
                process.exit(1);
            }
            console.log('✓ 全部通过');
            process.exit(0);
        },
    };
}

module.exports = { SANDBOX, CORE, setupSandbox, isolateDataDir, makeCaptureReplayer, createChecker };
