// 诊断: 同一账号分别试探「直接 0802」与「0801 → 0802」，确认 1045002 的真实触发条件
const path = require('path');

const network = require('/Users/liufaguang/Desktop/工作/qq-farm-automation-bot/core/src/utils/network');
const protobuf = require('/Users/liufaguang/Desktop/工作/qq-farm-automation-bot/node_modules/protobufjs');
const { toLong } = require('/Users/liufaguang/Desktop/工作/qq-farm-automation-bot/core/src/utils/utils');
const { loadProto } = require('/Users/liufaguang/Desktop/工作/qq-farm-automation-bot/core/src/utils/proto');

const psl = (scene) => {
  const w = protobuf.Writer.create();
  w.uint32((1 << 3) | 0).int64(toLong(scene));
  return w.finish();
};
const tryPsl = async (scene) => {
  try {
    await network.sendMsgAsync('gamepb.globalscenepb.GlobalSceneService', 'PlayerSceneLogin', psl(scene));
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
};

(async () => {
  const code = process.env.FARM_CODE;
  if (!code) { console.error('用法: FARM_CODE=xxx node /tmp/test_scene.js'); process.exit(1); }
  await loadProto();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('登录超时 30s')), 30000);
    network.connect(code, () => { clearTimeout(t); resolve(); });
  });
  console.log('已登录');

  const direct = await tryPsl(2);
  console.log('① 直接 0802:', direct.ok ? '✅ 成功' : `❌ ${direct.msg}`);

  const farm = await tryPsl(1);
  console.log('② 0801:', farm.ok ? '✅ 成功' : `❌ ${farm.msg}`);
  if (farm.ok) {
    const after = await tryPsl(2);
    console.log('③ 0801→0802:', after.ok ? '✅ 成功' : `❌ ${after.msg}`);
  }
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
