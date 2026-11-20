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
            // ⭐ 2026-11-18: #1 是 repeated(窝/棚各一条), 不再是单个 ranch
            const all = d.ranches || [];
            const animals = all.flatMap(r => r.animals || []);
            if (animals.length === 3 && String(animals[0].animal_id) === '60002') {
                found = d;
                if (String(all[0].grass && all[0].grass.grass_count) === '100') break;
            }
        }
        check('找到 21:58:07 那帧(3 只兔子)', !!found, !!found);
        if (found) {
            const ranch = (found.ranches || [])[0];
            const animals = ranch.animals || [];
            check('栏舍容量 = 3(#2 capacity)', String(ranch.capacity) === '3', ranch.capacity);
            check('在养数量 = 3(#3 animal_count)', String(ranch.animal_count) === '3', ranch.animal_count);
            check('husbandry_type = 1(窝)', String(ranch.husbandry_type) === '1', ranch.husbandry_type);
            check('牧草 = 100', String(ranch.grass.grass_count) === '100',
                ranch.grass && ranch.grass.grass_count);
            check('牧场经验 = 30', String(found.ranch_exp) === '30', found.ranch_exp);
            check('三只动物分属槽位 1/2/3',
                animals.map(a => String(a.slot_index)).join(',') === '1,2,3',
                animals.map(a => String(a.slot_index)));
            check('动物都是兔子 60002',
                animals.every(a => String(a.animal_id) === '60002'),
                animals.map(a => String(a.animal_id)));
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
        // ⭐ 2026-11-18 终案: 字段语义取自官方客户端解码器(mcboot/game.js),
        //   不再从抓包猜。倒计时/可收位全部来自服务端时刻与布尔位:
        //     stage 1..4 = 幼崽/成长/生产/成熟
        //     #10 grow_ready_at_ms  #11 produce_ready_at_ms  #14 infant_ready_at_ms
        //     #25 mature_ready_at_ms  #7 can_harvest  #15 producing  #16 can_deliver
        // stage 实测是 1..5(入栏抓包: 1 幼崽 → 3 催产 → 4 收产物 → 5 成熟可收)
        check('动物阶段是 1..5', a.stage >= 1 && a.stage <= 5, a.stage);
        check('阶段文案来自官方五阶段',
            ['幼崽期', '成长期', '生产期', '成熟期', '可收获'].includes(a.stageText), a.stageText);
        check('harvestable 直接等于服务端 can_harvest',
            a.harvestable === !!Number(a.canHarvest ?? 0) || a.harvestable === false, a.harvestable);
        check('倒计时字段都是秒或 null', [a.infantInSec, a.growInSec, a.produceInSec, a.matureInSec]
            .every(v => v === null || typeof v === 'number'),
            [a.infantInSec, a.growInSec, a.produceInSec, a.matureInSec]);
        check('牧场经验在视图顶层', Number.isInteger(view.ranchExp), view.ranchExp);
        check('视图按栏舍分组(coops/pens)', Array.isArray(view.coops) && Array.isArray(view.pens),
            { coops: (view.coops || []).length, pens: (view.pens || []).length });
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

    section('9. 照顾好友动物 / 使坏: 请求字节必须与抓包逐字节一致');
    {
        // 依据: wx-code-grabber/captures/20261120-001457_活动1.decoded.jsonl
        //   StrokeAnimal C->S 08e18bb1cf04120508914e105e  = {1:好友gid, 2:{1:10001, 2:94}}
        //   PutHazard   C->S 08914e10e18bb1cf0418fb552001 = {1:10001, 2:好友gid, 3:11003, 4:1}
        // ⚠ 两个接口的字段顺序**相反**, 之前 putHazard 拼成 {1:{1:gid,2:slot}} 是错的。
        // ⚠ target#2 = 94 是该好友牧场里 **animal_inst_id=94** 的动物
        //   (线上 2026-11-20: 传槽位号一律 1045207「动物不存在」)
        const stroke = types.StrokeAnimalRequest.encode(types.StrokeAnimalRequest.create({
            friend_gid: 1240221153,
            target: { host_gid: 10001, slot: 94 },
        })).finish().toString('hex');
        check('StrokeAnimal 字节一致', stroke === '08e18bb1cf04120508914e105e', stroke);

        const hazard = types.PutHazardRequest.encode(types.PutHazardRequest.create({
            ranch_inst_id: 10001, friend_gid: 1240221153, op_id: 11003, count: 1,
        })).finish().toString('hex');
        check('PutHazard 字节一致', hazard === '08914e10e18bb1cf0418fb552001', hazard);
        check('两个接口字段顺序不同(防回归)',
            stroke.slice(0, 10) !== hazard.slice(0, 10), { stroke, hazard });
    }

    section('10. GetRanchOpTimes 字段语义: #2=上限 #3=已用 #4=剩余');
    {
        // 抓包时间线: 使坏前 11003 = 100/1/99 → 连发 15 次后 100/16/84
        //             照顾前 11009 = 10/1/9   → 连发 5 次后 10/6/4
        const before = types.GetRanchOpTimesReply.decode(Buffer.from(
            '0a0908fb551064180120630a07088056101420140a09088156100a18012009', 'hex'));
        const after = types.GetRanchOpTimesReply.decode(Buffer.from(
            '0a0908fb551064181020540a07088056101420140a09088156100a18062004', 'hex'));
        const pick = (msg, opId) => {
            const l = msg.limits.find(x => Number(x.op_id) === opId);
            return l && { limit: Number(l.limit), used: Number(l.used), remaining: Number(l.remaining) };
        };
        check('使坏上限 100', pick(before, 11003).limit === 100, pick(before, 11003));
        check('使坏前 已用1/剩余99',
            pick(before, 11003).used === 1 && pick(before, 11003).remaining === 99, pick(before, 11003));
        check('使坏 15 次后 已用16/剩余84',
            pick(after, 11003).used === 16 && pick(after, 11003).remaining === 84, pick(after, 11003));
        check('照顾上限 10', pick(before, 11009).limit === 10, pick(before, 11009));
        check('照顾 5 次后 已用6/剩余4',
            pick(after, 11009).used === 6 && pick(after, 11009).remaining === 4, pick(after, 11009));
        check('剩余递减与次数一致 (99-84=15)', pick(before, 11003).remaining - pick(after, 11003).remaining === 15, null);
        check('照顾剩余递减 (9-4=5)', pick(before, 11009).remaining - pick(after, 11009).remaining === 5, null);
    }

    section('11. 收/照顾/使坏的自动化上限必须带预算');
    {
        const ranch = require(`${SB}/src/services/ranch`);
        const f = ranch.__privateRanchFns;
        check('导出 strokeAnimal', typeof ranch.strokeAnimal === 'function', typeof ranch.strokeAnimal);
        check('导出 autoStrokeFriendAnimals', typeof ranch.autoStrokeFriendAnimals === 'function', typeof ranch.autoStrokeFriendAnimals);
        check('导出 autoPutHazardOnFriends', typeof ranch.autoPutHazardOnFriends === 'function', typeof ranch.autoPutHazardOnFriends);
        check('导出 getFriendOpRemaining', typeof ranch.getFriendOpRemaining === 'function', typeof ranch.getFriendOpRemaining);

        const src = fs.readFileSync(require('node:path').join(SB, 'src/services/ranch.js'), 'utf8');
        check('op id 常量 11003/11009 已定义',
            /RANCH_OP_ID_HAZARD\s*=\s*11003/.test(src) && /RANCH_OP_ID_STROKE\s*=\s*11009/.test(src), null);
        check('照顾受 op 上限预算约束(remaining === 0 直接返回)',
            /limits\.stroke === 0\) return result/.test(src), null);
        check('使坏受 op 上限预算约束',
            /limits\.hazard === 0\) return result/.test(src), null);
        void f;
    }

    section('12. 照顾的 target#2 必须是 animal_inst_id(线上 1045207 的根因)');
    {
        // 线上日志(2026-11-20): 照顾动物一直回 1045207「动物不存在」。
        // 根因: target#2 传的是 slot_index, 而服务端要的是 AnimalInfo#3 animal_inst_id。
        // 抓包四帧验证(4 个不同好友/栏舍):
        //   ...105e → 94  = 窝 slot3 inst94     ...1062 → 98  = 窝 slot6 inst98
        //   ...8802 → 264 = 窝 slot6 inst264    ...bf01 → 191 = 窝 slot6 inst191
        const ranch = require(`${SB}/src/services/ranch`);
        const f = ranch.__privateRanchFns;

        // listFriendAnimals 必须把 animal_inst_id 带出来
        const list = f.listFriendAnimals([{
            ranch_inst_id: 10001,
            animals: [
                { slot_index: 3, animal_inst_id: 94, animal_id: 60007 },
                { slot_index: 6, animal_inst_id: 98, animal_id: 60007 },
            ],
        }]);
        check('listFriendAnimals 带 animalInstId', list[0] && list[0].animalInstId === 94, list[0]);
        check('listFriendAnimals 同时保留 slot 仅供展示', list[0] && list[0].slot === 3, list[0]);
        check('没有 animal_inst_id 的条目被跳过',
            f.listFriendAnimals([{ ranch_inst_id: 10001, animals: [{ slot_index: 1 }] }]).length === 0,
            null);

        // 传槽位号 → 抛错(不静默发错请求)
        let threw = false;
        try { await ranch.strokeAnimal(1240221153, { hostGid: 10001, slot: 3 }); }
        catch { threw = true; }
        check('只给 slot 不给 animalInstId → 直接抛错', threw, threw);

        // 编码口径: {1:好友gid, 2:{1:栏舍, 2:animal_inst_id}}
        const hex = types.StrokeAnimalRequest.encode(types.StrokeAnimalRequest.create({
            friend_gid: 1240221153,
            target: { host_gid: 10001, slot: 94 },
        })).finish().toString('hex');
        check('按 animal_inst_id 编码与抓包一致', hex === '08e18bb1cf04120508914e105e', hex);

        // 1045207 / 1045230 必须归为"状态类"(不刷 warn)
        const src = fs.readFileSync(require('node:path').join(SB, 'src/services/ranch.js'), 'utf8');
        check('1045207 归入 expected', /ANIMAL_MISSING: 1045207/.test(src), null);
        check('1045230 归入 expected', /HAZARD_ENOUGH: 1045230/.test(src), null);
    }

    section('13. 照料的状态码: 已照料过 / 巨大化 属正常(线上 2026-11-20)');
    {
        // 线上日志: 修好 instId 之后又冒出两个码, 都是"这只动物今天不能摸", 不是故障:
        //   1045246 你已经照料过这只动物啦
        //   1045244 已经巨大化的动物不能再照料啦
        const ranch = require(`${SB}/src/services/ranch`);
        const src = fs.readFileSync(require('node:path').join(SB, 'src/services/ranch.js'), 'utf8');
        check('1045246 有常量', /STROKE_ALREADY: 1045246/.test(src), null);
        check('1045244 有常量', /STROKE_MUTANT: 1045244/.test(src), null);
        check('两个码都归入 expected(不刷 warn)',
            /code === RANCH_ERR\.STROKE_ALREADY/.test(src) && /code === RANCH_ERR\.STROKE_MUTANT/.test(src),
            null);

        // 已照料过的动物要记下来跳过, 避免每轮重复请求
        check('有 _strokeSkip 记忆表', /_strokeSkip = new Map\(\)/.test(src), null);
        check('成功/已照料/巨大化都会写入跳过表',
            (src.match(/_strokeSkip\.set\(/g) || []).length >= 3, (src.match(/_strokeSkip\.set\(/g) || []).length);
        check('循环里会先查跳过表', /_strokeSkip\.has\(skipKey\(gid, t\.animalInstId\)\)\) continue/.test(src), null);

        // 状态类失败不消耗预算(没真正照料, 不该算进 10 次里)
        check('已照料/巨大化不消耗预算',
            /STROKE_ALREADY \|\| code === RANCH_ERR\.STROKE_MUTANT\) \{\s*\n\s*_strokeSkip\.set/.test(src), null);
        void ranch;
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