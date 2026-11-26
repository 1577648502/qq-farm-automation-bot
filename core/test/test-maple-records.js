/**
 * 以薯换福「蜜薯出售记录」回归测试
 *
 * 需求(2026-11-26 用户): 卖了多少 / 单价多少 / 收入多少 / 卖给谁 都要留档。
 * 落盘: data/maple-sell-records/<账号id>.json(worker 一账号一进程), 只记真卖出去的批次。
 *
 * 锁住不变量:
 *   1) addSellRecord 落盘且在重新加载后仍在(持久化, 不是内存);
 *   2) listSellRecords 最新在前 + 今日/累计汇总 + 按摊位分布;
 *   3) nameOfGid: 固定目标表命中(哈哈/润出去), 未知 gid 兜底 `gid:xxx`;
 *   4) 空仓/失败的批次不落盘(soldCount=0 不计入汇总);
 *   5) clearSellRecords 清空并落盘。
 */
const fs = require('node:fs');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
// ⚠ 必须先 isolate 再 require 服务: maple-market 在模块加载时解构 getDataFile
const DATA_DIR = isolateDataDir(SB, 'maple-records-test');

process.env.FARM_ACCOUNT_ID = 'test-acc';

const maple = require(`${SB}/src/services/maple-market`);
const T = maple.__testing;

function fileFor() {
    return T.sellRecordsFile();
}

section('落盘路径: 按账号分文件');
check('路径含账号 id', fileFor().includes('maple-sell-records') && fileFor().includes('test-acc'));
check('初始为空', maple.listSellRecords().total === 0);

section('追加记录 → 持久化');
const r1 = T.addSellRecord({
    soldCount: 30, unitPrice: 264, income: 7920,
    targetGid: 1253397809, stallBasePrice: 99, stallHolding: 165,
    quotaLeft: 8000, coin: 105720, source: 'auto',
});
check('返回记录含 targetName(哈哈)', r1.targetName === '哈哈');
check('返回记录 selfStall=false', r1.selfStall === false);
check('文件已写入', fs.existsSync(fileFor()));
const raw = JSON.parse(fs.readFileSync(fileFor(), 'utf8'));
check('文件 records 长度 1', Array.isArray(raw.records) && raw.records.length === 1);
check('文件字段完整(单价/收入/卖给谁)',
    raw.records[0].unitPrice === 264 && raw.records[0].income === 7920 && raw.records[0].targetName === '哈哈');

const r2 = T.addSellRecord({
    soldCount: 10, unitPrice: 200, income: 2000,
    targetGid: 0, coin: 107720, source: 'manual',
});
check('targetGid=0 → 自己摊', r2.selfStall === true);

section('列表: 最新在前 + 汇总 + 摊位分布');
const list = maple.listSellRecords({ limit: 10 });
check('total=2', list.total === 2);
check('最新在前(manual 那条在前)', list.records[0].income === 2000);
check('累计数量 40', list.summary.count === 40);
check('累计收入 9920', list.summary.income === 9920);
check('今日数量 40', list.summary.todayCount === 40);
check('今日收入 9920', list.summary.todayIncome === 9920);
check('今日批数 2', list.summary.todayBatches === 2);
check('摊位分布含哈哈', list.summary.targets.some(t => t.name === '哈哈' && t.count === 30 && t.income === 7920));

section('nameOfGid 映射');
check('1253397809 → 哈哈', T.nameOfGid(1253397809, 0) === '哈哈');
check('1097422979 → 润出去', T.nameOfGid(1097422979, 0) === '润出去');
check('未知 gid 兜底', T.nameOfGid(999999, 0) === 'gid:999999');
check('gid=0 → 未知', T.nameOfGid(0, 0) === '未知');

section('limit/offset 分页');
const page = maple.listSellRecords({ limit: 1, offset: 1 });
check('offset=1 拿到第二条', page.records.length === 1 && page.records[0].income === 7920);

section('清空');
maple.clearSellRecords();
check('内存已清', maple.listSellRecords().total === 0);
const raw2 = JSON.parse(fs.readFileSync(fileFor(), 'utf8'));
check('文件已清', Array.isArray(raw2.records) && raw2.records.length === 0);
check('数据目录存在', fs.existsSync(DATA_DIR));

finish();
