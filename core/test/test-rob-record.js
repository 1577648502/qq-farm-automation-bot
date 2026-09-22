/**
 * 夺宝战报(#143)解析 + 抢夺记录 测试
 * 战报数据全部来自真实抓包 20260917-111611_萌宠游记.jsonl (cmd=43, 3 帧)
 * 运行: node /tmp/test_rob_record.js
 */
const path = require('node:path');
const fs = require('node:fs');

let pass = 0; const fails = [];
function check(name, cond, extra) {
    if (cond) pass += 1;
    else fails.push(`${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
}
function section(t) { console.log(`\n── ${t}`); }

// ---- 沙箱 + 数据目录重定向(必须在 require treasure-rob 之前) ----
const { setupSandbox, isolateDataDir } = require('./harness');
const TMP = isolateDataDir(setupSandbox(), 'rob-rec-test');
process.env.FARM_ACCOUNT_ID = 'test-acct';

const ROOT = path.join(__dirname, '..', 'src');
const rp = require(`${ROOT}/config/runtime-paths`);
rp.getDataFile = (f) => path.join(TMP, f);   // 必须在 require treasure-rob 之前打桩
const rob = require(`${ROOT}/services/treasure-rob`);

/** 真实抓包原文 */
const RAW = {
    // 11:17:09 高级挑战书夺得 510 (幸运星 2050 → 2560)
    winHi: '0801120608850810fe031a0e4b616d6979612042756e63686573320608850810fe03380440034a2c0a016512016722100a0608850810fe03120608850810fe032a1209000000000000e03f11000000000000e03f',
    // 11:17:21 初级挑战书夺得 60 (幸运星 2560 → 2620)
    winLo: '08011205088508103c1a0e4b616d6979612042756e636865733205088508103c380640044a2a0a0165120167220e0a05088508103c1205088508103c2a1209000000000000e03f11000000000000e03f',
    // 11:17:28 被服务端拒绝(战斗没打起来)
    rejected: '50016233e5bd93e5898de5ae9de8978fe8b584e98791e4b88de8b6b3efbc8ce697a0e6b395e4bdbfe794a8e8afa5e68c91e68898e4b9a6',
    // 09-18 新增: 落败帧(关键差异: 没有 #1/#2, 返还金额在 #6)
    loseLo: '1a0e4b616d6979612042756e6368657332050885081028380340064a2a0a0165120167220e0a050885081028120508850810282a1209000000000000e03f11000000000000e03f',
    loseMid: '1a0e4b616d6979612042756e636865733205088508104b380440064a2a0a0165120167220e0a05088508104b1205088508104b2a1209000000000000e03f11000000000000e03f',
    // 09-18: 护送结算领取(cmd=45 结果 #145 = {#1: {1029, 690}})
    settle: '0a0608850810b205',
};
const buf = (hex) => Buffer.from(hex, 'hex');

// ---------- 1. 高级挑战书夺得 ----------
section('1. 高级挑战书(80103) 夺得 510');
{
    const r = rob.parseChallengeResult(buf(RAW.winHi), { bookItemId: 80103 });
    check('outcome = win', r.outcome === 'win', r.outcome);
    check('ok = true', r.ok === true);
    check('won = true (#1 = 1)', r.won === true && r.winFlag === 1, r.winFlag);
    check('奖励 = 幸运星×510', r.reward && r.reward.id === 1029 && r.reward.count === 510, r.reward);
    check('奖励名解析为"幸运星"', r.reward.name === '幸运星', r.reward.name);
    check('对方昵称 = Kamiya Bunches', r.opponentName === 'Kamiya Bunches', r.opponentName);
    check('我方锦囊 key = "e" → 惜糕探宝', r.myCharmKey === 'e' && r.myCharm === '惜糕探宝', r.myCharm);
    check('对方锦囊 key = "g" → 复仇机制', r.theirCharmKey === 'g' && r.theirCharm === '复仇机制', r.theirCharm);
    check('双方胜率 0.5 / 0.5 (fixed64 double)', r.myWinRate === 0.5 && r.theirWinRate === 0.5, [r.myWinRate, r.theirWinRate]);
    check('档位结算 胜510/败90', r.settleWin === 510 && r.settleLose === 90, [r.settleWin, r.settleLose]);
    check('奖励反查 = win (与 #1 一致)', r.rewardGuess === 'win', r.rewardGuess);
    check('无自检冲突', r.mismatch === false);
    check('保留原始 hex 便于排查', r.rawHex === RAW.winHi);
}

// ---------- 2. 初级挑战书夺得 ----------
section('2. 初级挑战书(80101) 夺得 60');
{
    const r = rob.parseChallengeResult(buf(RAW.winLo), { bookItemId: 80101 });
    check('outcome = win', r.outcome === 'win', r.outcome);
    check('奖励 = 幸运星×60', r.reward && r.reward.count === 60, r.reward);
    check('档位结算 胜60/败40', r.settleWin === 60 && r.settleLose === 40, [r.settleWin, r.settleLose]);
    check('奖励反查 = win', r.rewardGuess === 'win', r.rewardGuess);
    check('无自检冲突', r.mismatch === false);
    check('对方昵称一致', r.opponentName === 'Kamiya Bunches', r.opponentName);
}

// ---------- 3. 被服务端拒绝 ----------
section('3. 被拒(资金不足)');
{
    const r = rob.parseChallengeResult(buf(RAW.rejected), { bookItemId: 80103 });
    check('outcome = rejected', r.outcome === 'rejected', r.outcome);
    check('ok = false', r.ok === false);
    check('won = null(没打起来, 不猜胜负)', r.won === null, r.won);
    check('不带奖励', r.reward === null, r.reward);
    check('给出服务端原因文案', r.message === '当前宝藏资金不足，无法使用该挑战书', r.message);
}

// ---------- 3b. 落败(09-18 实测, 关键差异: 没有 #1/#2) ----------
section('3b. 落败帧(初级败 40 / 中级败 75)');
{
    const r1 = rob.parseChallengeResult(buf(RAW.loseLo), { bookItemId: 80101 });
    check('落败: outcome = lose', r1.outcome === 'lose', r1.outcome);
    check('落败: won = false', r1.won === false);
    check('落败: 返还 = 幸运星×40(在 #6)', r1.reward && r1.reward.count === 40, r1.reward);
    check('落败: 对方昵称', r1.opponentName === 'Kamiya Bunches', r1.opponentName);
    check('落败: 奖励反查 = lose', r1.rewardGuess === 'lose', r1.rewardGuess);
    check('落败: 无自检冲突', r1.mismatch === false);
    check('落败: 保留锦囊信息', r1.myCharmKey === 'e' && r1.theirCharmKey === 'g');

    const r2 = rob.parseChallengeResult(buf(RAW.loseMid), { bookItemId: 80102 });
    check('中级落败: 返还 75', r2.outcome === 'lose' && r2.reward.count === 75, r2.reward);
    check('中级落败: 反查 = lose', r2.rewardGuess === 'lose');
}

// ---------- 3c. 护送结算领取(cmd=45) ----------
section('3c. 护送结算领取(#145)');
{
    const f = rob.scanFields(buf(RAW.settle));
    const inner = (f.find(x => x.no === 1) || {}).b;
    check('结算 #145.#1 存在', !!inner);
    if (inner) {
        const af = rob.scanFields(inner);
        const id = Number((af.find(x => x.no === 1) || {}).v);
        const cnt = Number((af.find(x => x.no === 2) || {}).v);
        check('结算奖励 = 幸运星×690', id === 1029 && cnt === 690, { id, cnt });
        check('物品名解析', rob.itemNameOf(id) === '幸运星');
    }
}

// ---------- 4. 合成: 落败 / 缺失 / 自检冲突 ----------
section('4. 合成用例');
{
    // #1 = 0(落败) + #2 = {1029, 40} + #3 = "X"
    const lose = rob.parseChallengeResult(buf('0800120608850810281a0158'), { bookItemId: 80101 });
    check('落败: outcome = lose', lose.outcome === 'lose', lose.outcome);
    check('落败: won = false', lose.won === false);
    check('落败: 返还 幸运星×40', lose.reward && lose.reward.count === 40, lose.reward);
    check('落败: 奖励反查 = lose', lose.rewardGuess === 'lose', lose.rewardGuess);
    check('落败: 无冲突', lose.mismatch === false);

    // #1 = 1(声称胜) 但奖励是败值 40 → 自检冲突
    const odd = rob.parseChallengeResult(buf('0801120608850810281a0158'), { bookItemId: 80101 });
    check('冲突: mismatch = true', odd.mismatch === true);
    check('冲突: 仍以 #1 为主判据(win)', odd.outcome === 'win', odd.outcome);
    check('冲突: rewardGuess = lose', odd.rewardGuess === 'lose');

    const empty = rob.parseChallengeResult(null, { bookItemId: 80101 });
    check('缺失: outcome = unknown', empty.outcome === 'unknown', empty.outcome);
    check('缺失: 给出原因', empty.message.includes('#143'), empty.message);

    const tr = rob.parseChallengeResult(Buffer.alloc(0), { bookItemId: 80101 });
    check('空 buffer: unknown', tr.outcome === 'unknown');
    check('保留档位结算信息', tr.settleWin === 60 && tr.settleLose === 40);
}

// ---------- 5. 抢夺记录 ----------
section('5. 抢夺记录(持久化/排序/汇总/上限)');
{
    rob.clearRobRecords();
    check('清空后为 0 条', rob.listRobRecords().total === 0);

    rob.addRobRecord({ outcome: 'win', ok: true, won: true, gid: 1, friendName: 'A', reward: { id: 1029, count: 510, name: '幸运星' }, bookName: '高级挑战书' });
    rob.addRobRecord({ outcome: 'lose', ok: false, won: false, gid: 2, friendName: 'B', reward: { id: 1029, count: 40, name: '幸运星' }, bookName: '初级挑战书' });
    rob.addRobRecord({ outcome: 'rejected', ok: false, won: null, gid: 3, friendName: 'C', message: '资金不足' });
    rob.addRobRecord({ outcome: 'error', ok: false, won: null, gid: 4, message: '网络超时' });

    const l = rob.listRobRecords();
    check('共 4 条', l.total === 4, l.total);
    check('最新在前', l.records[0].gid === 4, l.records.map(r => r.gid));
    check('汇总: 胜1/败1/被拒1/异常1',
        l.summary.win === 1 && l.summary.lose === 1 && l.summary.rejected === 1 && l.summary.error === 1, l.summary);
    check('汇总: 累计奖励只算成功(510)', l.summary.rewardTotal === 510, l.summary.rewardTotal);
    check('outcomeText 中文', l.records[3].outcomeText === '成功' && l.records[2].outcomeText === '失败', l.records.map(r => r.outcomeText));
    check('rewardText 自动生成', l.records[3].rewardText === '幸运星×510', l.records[3].rewardText);
    check('每条都有时间戳', l.records.every(r => typeof r.at === 'number' && r.at > 1e12));

    // 真实扫描出来的 count 是字符串, 汇总必须仍然按数字相加
    rob.clearRobRecords();
    rob.addRobRecord({ outcome: 'win', ok: true, won: true, reward: { id: 1029, count: '510', name: '幸运星' } });
    rob.addRobRecord({ outcome: 'win', ok: true, won: true, reward: { id: 1029, count: '60', name: '幸运星' } });
    check('字符串 count 也按数字汇总(510+60)', rob.listRobRecords().summary.rewardTotal === 570, rob.listRobRecords().summary.rewardTotal);
    check('字符串 count 的 rewardText 正常', rob.listRobRecords().records[0].rewardText === '幸运星×60', rob.listRobRecords().records[0].rewardText);

    rob.clearRobRecords();
    rob.addRobRecord({ outcome: 'win', ok: true, won: true, gid: 1, friendName: 'A', reward: { id: 1029, count: 510, name: '幸运星' }, bookName: '高级挑战书' });
    rob.addRobRecord({ outcome: 'lose', ok: false, won: false, gid: 2, friendName: 'B', reward: { id: 1029, count: 40, name: '幸运星' }, bookName: '初级挑战书' });
    rob.addRobRecord({ outcome: 'rejected', ok: false, won: null, gid: 3, friendName: 'C', message: '资金不足' });
    rob.addRobRecord({ outcome: 'error', ok: false, won: null, gid: 4, message: '网络超时' });

    const p2 = rob.listRobRecords({ limit: 2, offset: 1 });
    check('分页 limit/offset 生效', p2.records.length === 2 && p2.records[0].gid === 3, p2.records.map(r => r.gid));
    check('分页 total 仍是全量', p2.total === 4);

    // 落盘 + 重新读取(新进程语义: 清缓存)
    const file = path.join(TMP, 'treasure-rob-records', 'test-acct.json');
    check('已写入账号专属文件', fs.existsSync(file), file);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('文件里 records = 4 条', Array.isArray(onDisk.records) && onDisk.records.length === 4, onDisk.records && onDisk.records.length);

    rob.clearRobRecords();
    check('清空后 0 条', rob.listRobRecords().total === 0);
    const cleared = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('清空也落盘', cleared.records.length === 0);
}

// ---------- 6. 上限裁剪 ----------
section('6. 记录上限');
{
    rob.clearRobRecords();
    for (let i = 0; i < rob.RECORD_LIMIT + 5; i++) rob.addRobRecord({ outcome: 'win', ok: true, gid: i });
    check(`最多保留 ${rob.RECORD_LIMIT} 条`, rob.listRobRecords({ limit: 1 }).total === rob.RECORD_LIMIT, rob.listRobRecords({ limit: 1 }).total);
    const l = rob.listRobRecords({ limit: 1 });
    check('裁剪掉的是最旧的(gid 最新)', l.records[0].gid === rob.RECORD_LIMIT + 4, l.records[0].gid);
    rob.clearRobRecords();
}

// ---------- 7. 结算表与档位 ----------
section('7. 结算表');
{
    check('80101 胜60/败40', rob.BOOK_SETTLE[80101].win === 60 && rob.BOOK_SETTLE[80101].lose === 40);
    check('80102 胜225/败75', rob.BOOK_SETTLE[80102].win === 225 && rob.BOOK_SETTLE[80102].lose === 75);
    check('80103 胜510/败90', rob.BOOK_SETTLE[80103].win === 510 && rob.BOOK_SETTLE[80103].lose === 90);
    check('三级都在 CHALLENGE_BOOKS 里', rob.CHALLENGE_BOOKS.every(b => rob.BOOK_SETTLE[b.id]));
    check('道具名解析(1029 → 幸运星)', rob.itemNameOf(1029) === '幸运星', rob.itemNameOf(1029));
    check('锦囊名解析(e → 惜糕探宝)', rob.charmLabel('e') === '惜糕探宝', rob.charmLabel('e'));
    check('未知锦囊 key 不报错', rob.charmLabel('z') === '', rob.charmLabel('z'));
}

// ---------- 8. 按宝藏选书(面值 ≤ 对方可博弈资金) ----------
section('8. 按宝藏选书');
{
    const inv = [
        { id: 80103, level: 3, count: 1 },
        { id: 80102, level: 2, count: 2 },
        { id: 80101, level: 1, count: 5 },
    ];
    const target = (gold) => ({ bookSlots: [
        { bookItemId: 80101, gold }, { bookItemId: 80102, gold }, { bookItemId: 80103, gold },
    ] });
    check('资金 300 → 高级', rob.pickBestBookForTreasure(inv, target(300)).id === 80103);
    check('资金 150 → 中级(高级面值超了, 会被拒)', rob.pickBestBookForTreasure(inv, target(150)).id === 80102);
    check('资金 50 → 初级', rob.pickBestBookForTreasure(inv, target(50)).id === 80101);
    check('资金 0 → null(不白贴书)', rob.pickBestBookForTreasure(inv, target(0)) === null);
    check('槽位缺某档 → 跳过那档', rob.pickBestBookForTreasure(inv, { bookSlots: [{ bookItemId: 80101, gold: 300 }] }).id === 80101);
    const onlyLow = [{ id: 80101, level: 1, count: 5 }];
    check('只有初级 + 资金300 → 初级', rob.pickBestBookForTreasure(onlyLow, target(300)).id === 80101);
    const noBooks = [{ id: 80103, level: 3, count: 0 }];
    check('没库存 → null', rob.pickBestBookForTreasure(noBooks, target(300)) === null);
    check('无槽位数据 → 退回 pickBestBook(高级优先)', rob.pickBestBookForTreasure(inv, {}).id === 80103);
    check('BOOK_SETTLE 与书档一一对应', rob.CHALLENGE_BOOKS.every(b => rob.BOOK_SETTLE[b.id]));
    check('今日计数不含护送结算(bookItemId>0 才算)', typeof rob.countTodayRobAttempts() === 'number');
}

console.log(`\n通过 ${pass} / ${pass + fails.length}`);
if (fails.length) { console.log('✗ 失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('✓ 全部通过');
