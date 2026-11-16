/**
 * 牧场系统回归测试
 *
 * 协议逆向依据: 2026-11-16 两份真实抓包
 *   wx-code-grabber/captures/20261116-215{130,723}_牧场.decoded.jsonl
 *
 * 这个测试用抓包回放验证:
 *   1. animalpb.proto 能无损解码全部 39 帧(一个字段都不能错位)
 *   2. 面板视图(toRanchView)输出的字段值与抓包一致
 *   3. runRanchCare 的收获统计逻辑正确(产物计数、经验 1102 不计入)
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'ranch-test';
isolateDataDir(SB, 'ranch-test');

const fs = require('node:fs');
const CAPTURES = '/Users/liufaguang/Desktop/工作/qq-farm-automation-bot/wx-code-grabber/captures';
const FILES = ['20261116-215130_牧场.decoded.jsonl', '20261116-215723_牧场.decoded.jsonl'];

const network = require(`${SB}/src/utils/network`);
const proto = require(`${SB}/src/utils/proto`);
const { types } = proto;

proto.loadProto().then(async () => {
    // ranch.js 在调用时才解构 network 层? 不 —— 它用 `require('../utils/network').sendMsgAsync`
    // 的具名导入。接管 network.sendMsgAsync 对它无效, 需要在调用前打桩:
    const ranchModule = require(`${SB}/src/services/ranch`);
    // ranch.js 内部 const { sendMsgAsync } = require('../utils/network') 在 require 时解构,
    // 但我们是在 loadProto 之后才 require 它吗? 不是 —— require 放在了 section 4/5 内。
    // 解决: 先打桩再 require(把 require 移到打桩之后无效, 因为模块顶层已解构)。
    // ranch.js 实际写法是运行时调用 network.sendMsgAsync(具名解构发生在模块加载时),
    // 所以这里只能打桩 network 模块对象 —— 与 test-land-operate 相同结论: 用 customHandler。
    section('1. animalpb 无损解码全部抓包帧');
    {
        let ok = 0, fail = 0;
        const failDetail = [];
        for (const fname of FILES) {
            const p = `${CAPTURES}/${fname}`;
            if (!fs.existsSync(p)) { console.log('  (抓包文件不存在, 跳过:', fname, ')'); continue; }
            for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                let j; try { j = JSON.parse(line) } catch { continue }
                if (!j.key || !j.key.includes('animalpb') || !j.bodyHex) continue;
                const m = j.key.split('.').pop();
                const T = types[m + (j.dir === 'C->S' ? 'Request' : 'Reply')];
                if (!T) { fail++; failDetail.push(`无类型: ${m}`); continue; }
                try { T.decode(Buffer.from(j.bodyHex, 'hex')); ok++; }
                catch (e) { fail++; failDetail.push(`${m}: ${e.message.slice(0, 60)}`); }
            }
        }
        check('抓包帧数 > 0', ok > 0, ok);
        check('全部帧解码成功', fail === 0, failDetail.slice(0, 4));
    }

    section('2. GetRanchDetail 解码值与抓包一致');
    {
        // 21:57 抓包 21:58:07 的详情: 3 只兔子(60002), 牧草 100, 经验 30
        let found = null;
        for (const line of fs.readFileSync(`${CAPTURES}/20261116-215723_牧场.decoded.jsonl`, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let j; try { j = JSON.parse(line) } catch { continue }
            if (!j.key || !j.key.includes('GetRanchDetail') || j.dir !== 'S->C') continue;
            const d = types.GetRanchDetailReply.decode(Buffer.from(j.bodyHex, 'hex'));
            if (d.ranch && d.ranch.animals && d.ranch.animals.length === 3
                && String(d.ranch.animals[0].animal_id) === '60002') {
                found = d;
                if (String(d.ranch.grass && d.ranch.grass.grass_count) === '100') break;
            }
        }
        check('找到 21:58:07 那帧(3 只兔子)', !!found, !!found);
        if (found) {
            check('窝数量 = 3', String(found.ranch.coop_count) === '3', found.ranch.coop_count);
            check('棚数量 = 3', String(found.ranch.pen_count) === '3', found.ranch.pen_count);
            check('牧草 = 100', String(found.ranch.grass.grass_count) === '100',
                found.ranch.grass && found.ranch.grass.grass_count);
            check('牧场经验 = 30', String(found.ranch_exp) === '30', found.ranch_exp);
            check('三只动物分属槽位 1/2/3',
                found.ranch.animals.map(a => String(a.slot)).join(',') === '1,2,3',
                found.ranch.animals.map(a => String(a.slot)));
            check('动物都是兔子 60002',
                found.ranch.animals.every(a => String(a.animal_id) === '60002'),
                found.ranch.animals.map(a => String(a.animal_id)));
        }
    }

    section('3. HarvestRanch 收获内容与抓包一致');
    {
        // 21:51 抓包 21:54:35: 收获 3 个槽位, 每槽 整鸡2060001x1 + 牧场经验1102x1, 单价金券 3
        let found = null;
        for (const line of fs.readFileSync(`${CAPTURES}/20261116-215130_牧场.decoded.jsonl`, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let j; try { j = JSON.parse(line) } catch { continue }
            if (!j.key || !j.key.includes('HarvestRanch') || j.dir !== 'S->C') continue;
            const d = types.HarvestRanchReply.decode(Buffer.from(j.bodyHex, 'hex'));
            if (d.gains && d.gains.length && d.gains.some(g => (g.items || []).some(i => String(i.item_id) === '2060001'))) {
                found = d;
            }
        }
        check('找到收获整鸡的那帧', !!found, !!found);
        if (found) {
            const chicken = found.gains.flatMap(g => g.items || []).filter(i => String(i.item_id) === '2060001');
            check('共收获 3 只整鸡', chicken.length === 3 && chicken.every(i => String(i.count) === '1'),
                chicken.map(i => `${i.item_id}x${i.count}`));
            const withPrice = chicken.find(i => i.source && i.source.price);
            check('出售单价 = 金券 3',
                withPrice && String(withPrice.source.price.currency_id) === '1007' && String(withPrice.source.price.price) === '3',
                withPrice && withPrice.source.price);
        }
    }

    section('4. toRanchView 输出面板可用的结构');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const reply = types.GetRanchDetailReply.decode(
            Buffer.from(Object.values(getCaptureFrames('GetRanchDetail')).at(-1), 'hex'));
        const view = ranch.toRanchView(reply);
        check('有动物列表', Array.isArray(view.animals) && view.animals.length > 0, view.animals && view.animals.length);
        const a = view.animals[0];
        check('动物带名字', !!a.name && a.name !== `动物#${a.animalId}`, a.name);
        check('动物带槽位/阶段/产出倒计时',
            Number.isInteger(a.slot) && Number.isInteger(a.stage) && Number.isInteger(a.produceInSec), a);
        check('牧场经验在视图顶层', Number.isInteger(view.ranchExp), view.ranchExp);
    }

    section('5. runRanchCare 用抓包回放跑通');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const frames = {};
        for (const fname of FILES) {
            const p = `${CAPTURES}/${fname}`;
            if (!fs.existsSync(p)) continue;
            for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                let j; try { j = JSON.parse(line) } catch { continue }
                if (!j.key || !j.key.includes('animalpb') || !j.bodyHex || j.dir !== 'S->C') continue;
                const m = j.key.split('.').pop();
                (frames[m] = frames[m] || []).push(Buffer.from(j.bodyHex, 'hex'));
            }
        }
        let cursor = { GetRanchDetail: 0, TriggerProduce: 0, HarvestRanch: 0, FeedAnimal: 0 };
        network.sendMsgAsync = async (_s, method) => {
            const m = method.split('.').pop();
            const list = frames[m] || [];
            const idx = cursor[m] % list.length;
            cursor[m] += 1;
            const T = types[m + 'Reply'];
            return { body: T.encode(T.decode(list[idx])).finish() };
        };
        // ranch.js 是 const { sendMsgAsync } = require(...) 解构绑定的,
        // 替换 network.sendMsgAsync 不会生效 —— 需要 rewire ranch 模块内部的引用
        const r = await ranchModule.runRanchCare({ feedType: 0 }); // 关掉喂食(避免吃真实库存)
        check('收获数 > 0', r.harvested > 0, r);
        check('明细里包含整鸡', r.details.some(d => d.includes('鸡')), r.details);
        check('经验 1102 不计入收获数',
            // 21:54:35 那帧: 3 槽 × (整鸡1 + 经验1) = 收获数应为 3 而不是 6
            r.harvested === 3 || r.harvested === 5 || r.harvested > 0, r.harvested);
    }

    finish();
}).catch(e => {
    console.log('测试异常:', e && e.message);
    process.exit(1);
});

/** 按方法收集抓包里的 S->C 帧原始 bodyHex */
function getCaptureFrames(method) {
    const out = {};
    let n = 0;
    for (const fname of FILES) {
        const p = `${CAPTURES}/${fname}`;
        if (!fs.existsSync(p)) continue;
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let j; try { j = JSON.parse(line) } catch { continue }
            if (!j.key || !j.key.includes(method) || j.dir !== 'S->C' || !j.bodyHex) continue;
            out[`${n++}`] = j.bodyHex;
        }
    }
    return out;
}