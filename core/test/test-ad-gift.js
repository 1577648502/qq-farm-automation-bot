/**
 * 看广告礼包（跳过广告直接领）回归测试 —— 回放真实抓包
 *
 * 抓包: 20260929-102536_商城看广告购买化肥.jsonl
 *   GetAdUnits → RequestAd{10001} → (客户端播广告) → ReportAd{token,0} → 服务端发奖
 *   我们要验证: 三步接口调通 + 发出的 ReportAd 字节与抓包**完全一致**
 *
 * 运行: node test/test-ad-gift.js
 */
const path = require('node:path');
const fs = require('node:fs');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');
const { decodeFrame } = require('../scripts/ws-frame-lib');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'ad-test';
isolateDataDir(SB, 'ad-test');

const CAP = path.join(__dirname, '..', '..', 'wx-code-grabber', 'captures', '20260929-102536_商城看广告购买化肥.jsonl');

function loadFrames(file) {
    const byKey = {};
    const all = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.ev || !j.hex) continue;
        all.push(j);
        if (j.dir !== 'S->C') continue;
        (byKey[j.key] = byKey[j.key] || []).push(j);
    }
    return { byKey, all };
}
const { byKey: F, all: ALL } = loadFrames(CAP);
const AD = 'gamepb.iaapb.IaaService';
const MALL = 'gamepb.mallpb.MallService.GetMallListBySlotType';

(async () => {
    const { types } = require(`${SB}/src/utils/proto`);
    await require(`${SB}/src/utils/proto`).loadProto();
    // ⚠ ws-frame-lib 用的是**真实 core 的** proto 实例(不是沙箱), 所以要单独 loadProto 一次
    await require('../src/utils/proto').loadProto();

    const calls = [];
    let failRequestAd = false;   // 模拟服务端拒绝 RequestAd(code=1031013)
    const bodyOf = (hex) => Buffer.from(types.GateMessage.decode(Buffer.from(hex, 'hex')).body || []);

    const net = require(`${SB}/src/utils/network`);
    net.sendMsgAsync = async (service, method, body) => {
        const key = `${service}.${method}`;
        calls.push({ key, body: Buffer.from(body || []) });
        if (key === `${AD}.GetAdUnits`) {
            const f = (F[`${AD}.GetAdUnits`] || [])[0];
            if (!f) throw new Error('抓包里没有 GetAdUnits 响应');
            return { body: bodyOf(f.hex) };
        }
        if (key === `${AD}.RequestAd`) {
            if (failRequestAd) throw new Error('gamepb.iaapb.IaaService.RequestAd 错误: code=1031013 分享礼包功能还不能使用');
            const f = (F[`${AD}.RequestAd`] || [])[0];
            if (!f) throw new Error('抓包里没有 RequestAd 响应');
            return { body: bodyOf(f.hex) };
        }
        if (key === `${AD}.ReportAd`) {
            const f = (F[`${AD}.ReportAd`] || [])[0];
            if (!f) throw new Error('抓包里没有 ReportAd 响应');
            return { body: bodyOf(f.hex) };
        }
        if (key === MALL) {
            const f = (F[MALL] || [])[0];
            if (!f) throw new Error('抓包里没有商城列表响应');
            return { body: bodyOf(f.hex) };
        }
        throw new Error('未 stub 的接口: ' + key);
    };

    const adGift = require(`${SB}/src/services/ad-gift`);
    const mg = require(`${SB}/src/services/mengchong`);

    section('1. 抓包里的三步请求(上行解密后的真实字节)');
    {
        const capReq = (idx) => ALL.find(x => x.idx === idx && x.dir === 'C->S');
        const reqGet = capReq(30);
        const reqReq = capReq(98);
        const reqRep = capReq(116);
        check('抓包里有三步请求帧', !!reqGet && !!reqReq && !!reqRep);
        // ⚠ 上行要解密: 走 ws-frame-lib.decodeFrame(decrypt), GateMessage.decode 只会得到密文
        const decReq = await decodeFrame(Buffer.from(reqReq.hex, 'hex'), { decrypt: true });
        const decRep = await decodeFrame(Buffer.from(reqRep.hex, 'hex'), { decrypt: true });
        check('RequestAd 请求解密成功', decReq.decrypted === true, decReq.decryptError || decReq.error);
        const reqTxt = (decReq.fields || []).join(' ');
        const repTxt = (decRep.fields || []).join(' ');
        check('抓包 RequestAd = {#1: 10001}', /#1 \(varint\): 10001/.test(reqTxt), reqTxt.slice(0, 120));
        check('抓包 ReportAd 带 32B token + #2=0', /#1 \(message, 32B\)/.test(repTxt) && /#2 \(varint\): 0/.test(repTxt), repTxt.slice(0, 160));
    }

    section('2. 接口封装');
    {
        const units = await adGift.getAdUnits();
        check('GetAdUnits: 拿到广告位 10001', units.length === 1 && units[0].unitId === 10001, units);
        check('广告位 key = adunit-1e518c6aa22122d3', units[0].unitKey === 'adunit-1e518c6aa22122d3', units[0].unitKey);

        const ad = await adGift.requestAd(10001);
        check('RequestAd: token 32 字节', ad.token.length === 32, ad.token.length);
        check('token 与抓包一致', ad.tokenText === 'f983d17c7c0b457eb6d0454dfb1a251d', ad.tokenText);
        check('广告物料 116B', ad.payloadLen === 116, ad.payloadLen);

        const rep = await adGift.reportAd(ad.token, 0);
        check('ReportAd: 上报成功(result=1)', rep.ok === true, rep);

        // 我们发出的 ReportAd 字节: 应与抓包同构(0a20<32B token>1000)
        const sent = calls.filter(c => c.key === `${AD}.ReportAd`).pop();
        const hex = sent.body.toString('hex');
        check('发出的 ReportAd = 0a20 + 32B token + 1000',
            hex.startsWith('0a20') && hex.endsWith('1000') && sent.body.length === 36,
            { hex, len: sent.body.length });
    }

    section('3. 每日额度(以商城接口为准)');
    {
        const q = await adGift.getAdGiftQuota();
        check('识别出看广告礼包 goodsId=1052', q.ok === true && q.goodsName.includes('看广告'), q);
        check('限购信息为每日 1 次', q.limitType === 'daily' && q.limitCount === 1, q);
        check('返回可领状态', typeof q.claimable === 'boolean', q.claimable);
    }

    section('4. 完整流程: 跳过广告直接领');
    {
        calls.length = 0;
        const r = await adGift.claimDailyAdGift(true);       // force: 不受"接口说已领过"限制
        check('流程成功', r.ok === true, r);
        check('走了三步', ['GetAdUnits', 'RequestAd', 'ReportAd'].every(s => (r.steps || []).some(x => x.step === s)),
            (r.steps || []).map(x => x.step));
        check('用的是广告位 10001', r.unitId === 10001, r.unitId);
        check('奖励道具 = 化肥(1小时) 80001', r.itemId === 80001, r.itemId);
        check('没有调用商城购买(Purchase)', calls.filter(c => /MallService\.Purchase/.test(c.key)).length === 0, calls.map(c => c.key));
    }

    section('5. 已领过时跳过(接口说没额度)');
    {
        const mall = require(`${SB}/src/services/mall`);
        const orig = mall.getMallCatalog;
        mall.getMallCatalog = async () => ([{
            goodsId: 1052, name: '看广告礼包', limitType: 'daily', limitCount: 1, boughtNum: 1, remaining: 0,
        }]);
        calls.length = 0;
        const r = await adGift.claimDailyAdGift(false);
        check('跳过且说明原因', r.skipped === true && /今日已领过/.test(r.reason || ''), r);
        check('跳过时不调广告接口', calls.filter(c => /IaaService/.test(c.key)).length === 0, calls.map(c => c.key));

        // force 也不能越过服务端额度(2026-09-29 线上踩过: 硬发请求 → 服务端 1031013)
        calls.length = 0;
        const rf = await adGift.claimDailyAdGift(true);
        check('force 同样跳过(以接口为准)', rf.skipped === true, rf);
        check('force 也不调广告接口', calls.filter(c => /IaaService/.test(c.key)).length === 0, calls.map(c => c.key));

        // 服务端拒绝 1031013 → 按"跳过"而不是报错(桩里模拟, 服务已绑定桩的引用)
        mall.getMallCatalog = async () => ([{ goodsId: 1052, name: '看广告礼包', limitType: 'daily', limitCount: 1, boughtNum: 0, remaining: 1 }]);
        failRequestAd = true;
        const r2 = await adGift.claimDailyAdGift(false).catch(() => null);
        failRequestAd = false;
        check('1031013 视为跳过(不算失败)', !!(r2 && r2.skipped === true), r2);
        check('提示文案友好', /当前不可用/.test((r2 && r2.reason) || ''), r2 && r2.reason);
        mall.getMallCatalog = orig;
    }

    finish();
})().catch(e => { console.log('测试异常:', e && e.message); process.exit(1); });
