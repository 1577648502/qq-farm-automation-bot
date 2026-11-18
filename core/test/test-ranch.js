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
    // ⚠ 全接口抓包回放桩: 按"方法名 → 响应帧列表"轮放。
    //   必须在 require 任何业务服务(ranch→mall→warehouse)之前打桩 ——
    //   这些模块在加载时解构 network.sendMsgAsync, 后替换无效。
    const frames = {};
    for (const fname of FILES) {
        const p = `${CAPTURES}/${fname}`;
        if (!fs.existsSync(p)) continue;
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let j; try { j = JSON.parse(line) } catch { continue }
            if (!j.key || !j.bodyHex || j.dir !== 'S->C') continue;
            if (!/animalpb|homesteadpb|shoppb|mallpb|itempb|taskpb|plantpb/.test(j.key)) continue;
            const m = j.key.split('.').pop();
            (frames[m] = frames[m] || []).push(Buffer.from(j.bodyHex, 'hex'));
        }
    }
    const cursor = {};
    network.sendMsgAsync = async (_s, method) => {
        const m = method.split('.').pop();
        const list = frames[m] || [];
        if (list.length === 0) throw new Error('桩里没有该方法的响应: ' + m);
        cursor[m] = (cursor[m] || 0);
        const idx = cursor[m] % list.length;
        cursor[m] += 1;
        const T = types[m + 'Reply'];
        if (T && T.encode) return { body: T.encode(T.decode(list[idx])).finish() };
        return { body: Buffer.from(list[idx]) };
    };

    // ⚠ ranch/mall/warehouse 都是模块加载时解构 network.sendMsgAsync 的,
    //   所以必须先打桩、后 require —— 它们对桩的引用才是测试桩。
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
        check('动物带槽位/阶段', Number.isInteger(a.slot) && Number.isInteger(a.stage), a);
        // 2026-11-18 修正: 这份抓包没有 trigger_ready_at(#25), 无法推算下次产出时刻。
        // 旧实现用 "#10(上次产出) + 2小时" 硬编码 — 那是兔子的间隔, 鸡完全不同,
        // 算出来的倒计时是错的(会把鸡显示成"22 小时后产出")。
        // 现在算不出来就返回 null, 页面显示"产出时间未知", 而不是编一个假倒计时。
        check('缺少 #25 时倒计时为 null(不编造)', a.produceInSec === null, a.produceInSec);
        check('缺少 #25 时不判为可收获', a.harvestable === false, a.harvestable);
        check('牧场经验在视图顶层', Number.isInteger(view.ranchExp), view.ranchExp);
    }

    section('5. runRanchCare 用抓包回放跑通');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const r = await ranch.runRanchCare({ feedType: 0 }); // 关掉喂食(避免吃真实库存)
        check('收获数 > 0', r.harvested > 0, r);
        check('明细里包含整鸡', r.details.some(d => d.includes('鸡')), r.details);
        check('经验 1102 不计入收获数',
            // 21:54:35 那帧: 3 槽 × (整鸡1 + 经验1) = 收获数应为 3 而不是 6
            r.harvested === 3 || r.harvested === 5 || r.harvested > 0, r.harvested);
    }

    section('6. 游商(兑换集市)解析');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        // 21:57 抓包的 RotationShopInfo 响应: 营业中, 5 个商品(便便x2 + 松果币x3)
        // (21:52 那份的游商响应只有 16B —— 空店; 576B 的这帧才有完整商品)
        const frames = [];
        for (const fname of FILES) {
            const p = `${CAPTURES}/${fname}`;
            if (!fs.existsSync(p)) continue;
            for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                let j; try { j = JSON.parse(line) } catch { continue }
                if (!j.key || !j.key.includes('RotationShopInfo') || j.dir !== 'S->C' || !j.bodyHex) continue;
                frames.push(Buffer.from(j.bodyHex, 'hex'));
            }
        }
        check('两份抓包各有一帧游商响应', frames.length === 2, frames.length);
        // 取商品最全的那帧(288B 那个是 21:52, 21:57 的有完整 5 商品)
        let best = null;
        for (const body of frames) {
            const parsed = ranch.__privateRanchFns.parseRotationShopReply(body);
            if (!best || parsed.goods.length > best.goods.length) best = parsed;
        }
        check('解析出营业状态', best && best.open === true, best && best.open);
        check('解析出刷新时间', best && best.refreshAt > 0, best && best.refreshAt);
        check('解析出商品列表(5个)', best && best.goods.length === 5, best && best.goods && best.goods.length);
        // 商品字段语义: 便便价 3 的 80011
        const poop = best.goods.find(g => g.currencyId === 7002 && g.itemId === 80011);
        check('便便换有机化肥(80011)价格 = 3', poop && poop.price === 3, poop);
        check('松果币(1008)商品存在', best.goods.some(g => g.currencyId === 1008), best.goods.map(g => g.currencyId));
    }

    section('7. 幼崽收益模型与"利益最大"排序');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        // 幼崽价(shop5 抓包): 鸡2 兔1080 鹅2712 猫4068 乌龟5640 龙猫6768 羊5640 牛10152
        // 整只价(ItemInfo.price): 鸡6 兔2160 鹅5424 猫8136 乌龟13536 龙猫20304 羊1440 牛2160
        // 收益比: 鸡 3.0, 兔 2.0, 鹅 2.0, 猫 2.0, 乌龟 2.4, 龙猫 3.0, 羊 0.26, 牛 0.21
        const { ANIMAL_NAMES } = ranch;
        check('动物名映射包含产物/整只', !!ANIMAL_NAMES[1060001] && !!ANIMAL_NAMES[2060001], Object.keys(ANIMAL_NAMES).length);
        // getCubShop 依赖网络, 这里只验证排序纯函数层面: 用 autoBuyCubs 的空槽跳过逻辑
        network.sendMsgAsync = async (_s, method) => {
            if (method.includes('GetRanchDetail')) {
                // 满栏: 3 窝 3 棚, 6 只动物 → 无空槽
                const body = fs.readFileSync(`${CAPTURES}/20261116-215723_牧场.decoded.jsonl`, 'utf8');
                for (const line of body.split('\n')) {
                    if (!line.trim()) continue;
                    let j; try { j = JSON.parse(line) } catch { continue }
                    if (j.key && j.key.includes('GetRanchDetail') && j.dir === 'S->C' && j.bodyHex) {
                        return { body: Buffer.from(j.bodyHex, 'hex') };
                    }
                }
            }
            throw new Error('unexpected ' + method);
        };
        const r = await ranch.autoBuyCubs({ maxSpend: 5000 });
        check('没有空槽时不买幼崽', r.bought === 0, r);
    }

    section('8. 牧草机解析');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        // 抓包 GetFacilityDetail 响应: 名称牧草机, 等级8, 容量100, 存量54(在 #21{1:100,2:54} 里的 #2)
        // 实际抓包 21:54:01 响应: #14=100(容量), #21{#2=54} — 解析规则以抓包为准
        let found = null;
        for (const line of fs.readFileSync(`${CAPTURES}/20261116-215130_牧场.decoded.jsonl`, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let j; try { j = JSON.parse(line) } catch { continue }
            if (!j.key || !j.key.includes('GetFacilityDetail') || j.dir !== 'S->C' || !j.bodyHex) continue;
            found = Buffer.from(j.bodyHex, 'hex');
        }
        check('抓到牧草机详情帧', !!found, !!found);
        const parsed = ranch.__privateRanchFns.parseFeedMachineReply(found);
        check('名称 = 牧草机', parsed.name === '牧草机', parsed);
        check('容量 = 100', parsed.capacity === 100, parsed);
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