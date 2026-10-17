const path = require('node:path');
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const sandbox = setupSandbox();
isolateDataDir(sandbox, 'runtime-log-filter');

const { createRuntimeState } = require(path.join(sandbox, 'src/runtime/runtime-state'));
const state = createRuntimeState({ store: {}, operationKeys: [] });
const checker = createChecker();

const logs = [
    { msg: 'activity info', tag: '\u6D3B\u52A8', meta: { module: 'activity', result: 'info' } },
    { msg: 'activity warn', tag: '\u6D3B\u52A8', meta: { module: 'activity', result: 'warn' } },
    { msg: 'activity error', tag: '\u6D3B\u52A8', meta: { module: 'activity', result: 'error' } },
    { msg: 'activity skip', tag: '\u6D3B\u52A8', meta: { module: 'activity', result: 'skip' } },
    { msg: 'legacy system', tag: '\u7CFB\u7EDF', meta: {} },
    { msg: 'legacy warn', tag: '\u8B66\u544A', isWarn: true, meta: {} },
    { msg: 'legacy error', tag: '\u9519\u8BEF', meta: {} },
    { msg: 'mystery modern', tag: '\u795E\u79D8\u5546\u5E97', meta: { module: 'mystery_shop' } },
    { msg: 'mystery legacy', tag: '\u795E\u79D8\u5546\u5E97', meta: { module: 'mysteryshop' } },
];

const messages = filters => state.filterLogs(logs, filters).map(entry => entry.msg);

checker.section('level filter');
checker.check('info only', JSON.stringify(messages({ level: 'info' })) === JSON.stringify([
    'activity info',
    'legacy system',
    'mystery modern',
    'mystery legacy',
]));
checker.check('warn only', JSON.stringify(messages({ level: 'warn' })) === JSON.stringify([
    'activity warn',
    'legacy warn',
]));
checker.check('error only', JSON.stringify(messages({ level: 'error' })) === JSON.stringify([
    'activity error',
    'legacy error',
]));
checker.check('skip only', JSON.stringify(messages({ level: 'skip' })) === JSON.stringify([
    'activity skip',
]));

checker.section('module compatibility');
checker.check('system includes historical tags', JSON.stringify(messages({ module: 'system' })) === JSON.stringify([
    'legacy system',
    'legacy warn',
    'legacy error',
]));
checker.check('mystery shop includes legacy module', JSON.stringify(messages({ module: 'mystery_shop' })) === JSON.stringify([
    'mystery modern',
    'mystery legacy',
]));
checker.check('module and level combine', JSON.stringify(messages({ module: 'activity', level: 'warn' })) === JSON.stringify([
    'activity warn',
]));

checker.finish();
