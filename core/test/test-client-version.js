/**
 * 客户端版本号自动跟进 回归测试
 *
 * 背景(抓包实测):
 *   版本号形如 1.16.3.8_20261028 = 主.次.补丁_资源日期。
 *   服务端 LoginReply/HeartbeatReply 的 version_info **不给完整版本号**
 *   (version_recommend 恒为占位 0.2.0.0), 但会给 res_version —— 真实的资源日期,
 *   随游戏更新变化(20260826 → 20260922 → 20261001 → 20261028)。
 *   所以能自动跟进的只有日期段; 三段号变了必须人工更新。
 *
 * 覆盖:
 *   · 版本号解析 / 日期替换
 *   · 落后判定: 远端更新才算落后, 相同/更旧都不算
 *   · 格式不认识时不瞎猜(返回空建议, 不改配置)
 *   · 观察 version_info 会记录状态, 并且同一结论只告警一次
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'client-version-test';
isolateDataDir(SB, 'client-version-test');

const cv = require(`${SB}/src/utils/client-version`);

section('1. 解析版本号里的资源日期 / 替换日期段');
{
    const parse = (v) => cv.resolveVersionSuggestion(v, { res_version: '20991231' });
    check('1.16.3.8_20261028 → localDate 20261028', parse('1.16.3.8_20261028').localDate === '20261028', parse('1.16.3.8_20261028'));
    check('带空格也能解析', parse('  1.14.2.15_20260922 ').localDate === '20260922', parse('  1.14.2.15_20260922 '));
    check('空串 → localDate 空', parse('').localDate === '');
    check('格式不对 → localDate 空', parse('1.16.3').localDate === '');
    check('undefined 不抛异常', parse(undefined).localDate === '');
    check('替换日期段: 保留三段号, 只换日期',
        parse('1.16.3.8_20261028').suggested === '1.16.3.8_20991231',
        parse('1.16.3.8_20261028').suggested);
}

section('2. 远端资源日期格式不对时不替换');
{
    const r = cv.resolveVersionSuggestion('1.16.3.8_20261028', { res_version: '2099' });
    check('非 8 位日期 → 不落后、不给建议', r.outdated === false && r.suggested === '', r);
    const badLocal = cv.resolveVersionSuggestion('abc', { res_version: '20991231' });
    check('原版本号格式不对 → 不替换', badLocal.outdated === false && badLocal.suggested === '', badLocal);
}

section('3. 落后判定');
{
    const outdated = cv.resolveVersionSuggestion('1.14.2.15_20260922', { res_version: '20261028' });
    check('远端更新 → 落后', outdated.outdated === true, outdated);
    check('给出建议版本号', outdated.suggested === '1.14.2.15_20261028', outdated);
    check('记录本地/远端日期', outdated.localDate === '20260922' && outdated.remoteDate === '20261028', outdated);

    const same = cv.resolveVersionSuggestion('1.16.3.8_20261028', { res_version: '20261028' });
    check('日期相同 → 不落后', same.outdated === false, same);
    check('不落后时不给建议', same.suggested === '', same);

    const older = cv.resolveVersionSuggestion('1.16.3.8_20261028', { res_version: '20261001' });
    check('远端更旧 → 不落后(不回退)', older.outdated === false, older);

    const noInfo = cv.resolveVersionSuggestion('1.16.3.8_20261028', null);
    check('没有 version_info → 不落后', noInfo.outdated === false, noInfo);

    const badRemote = cv.resolveVersionSuggestion('1.16.3.8_20261028', { res_version: '0.2.0.0' });
    check('远端是占位值(非日期) → 不落后, 不瞎猜', badRemote.outdated === false, badRemote);

    const badLocal = cv.resolveVersionSuggestion('abc', { res_version: '20261028' });
    check('本地格式不认识 → 不落后(不去破坏用户配置)', badLocal.outdated === false, badLocal);
}

section('4. 观察 version_info 会记录状态');
{
    cv.clearVersionState('acc-1');
    const r = cv.observeVersionInfo({ status: 0, res_version: '20261028' }, '1.14.2.15_20260922', 'acc-1');
    check('返回落后结论', r && r.outdated === true, r);

    const state = cv.getVersionState('acc-1');
    check('状态被记录', !!state, state);
    check('状态里有建议版本号', state && state.suggested === '1.14.2.15_20261028', state);
    check('状态里有当前版本', state && state.currentVersion === '1.14.2.15_20260922', state);
    check('状态里有检查时间', !!(state && state.checkedAt), state);

    // 不同账号互不影响
    check('其它账号没有状态', cv.getVersionState('acc-2') === null, cv.getVersionState('acc-2'));

    cv.clearVersionState('acc-1');
    check('清理后状态为空', cv.getVersionState('acc-1') === null);
}

section('5. 版本已最新时也记录, 但不给建议');
{
    cv.clearVersionState('acc-3');
    const r = cv.observeVersionInfo({ status: 0, res_version: '20261028' }, '1.16.3.8_20261028', 'acc-3');
    check('不落后', r && r.outdated === false, r);
    const state = cv.getVersionState('acc-3');
    check('仍然记录了检查结果', !!state && state.outdated === false, state);
    check('没有建议', state && state.suggested === '', state);
    cv.clearVersionState('acc-3');
}

section('6. 空 version_info 不产生状态');
{
    cv.clearVersionState('acc-4');
    const r = cv.observeVersionInfo(null, '1.16.3.8_20261028', 'acc-4');
    check('返回 null', r === null, r);
    check('没有写入状态', cv.getVersionState('acc-4') === null, cv.getVersionState('acc-4'));
}

finish();
