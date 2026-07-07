const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');
const platform = require('../utils/platform');

const MINIAPP_ROOT = platform.getMiniAppRoot();
const CODE_FILE_ROOT = platform.getQqexRoot();
const MINIAPP_URL = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';
const INJECT_MARKER = '/*__CODE_SNIFFER_INJECTED__*/';
const WAIT_TIMEOUT_MS = 90 * 1000;
const POLL_MS = 800;

const INJECT_PAYLOAD = `
;${INJECT_MARKER}(function(){try{
  function __csTryClose(){
    var api=(typeof qq!=='undefined'?qq:wx);
    if(!api) return;
    var funcs=['exitMiniProgram','exitMiniApp','exitProgram','navigateBack','switchTab'];
    for(var i=0;i<funcs.length;i++){
      try{
        if(typeof api[funcs[i]]==='function'){ api[funcs[i]](); return; }
      }catch(e){}
    }
  }
  function __csGo(){
    var api=(typeof qq!=='undefined'&&qq.login)?qq:((typeof wx!=='undefined'&&wx.login)?wx:null);
    if(!api) return setTimeout(__csGo,500);
    api.login({success:function(res){
      if(!(res&&res.code)) return;
      try{var cb=(qq.setClipboardData||wx.setClipboardData); cb({data:String(res.code)});}catch(e){}
      try{(qq.showModal||wx.showModal)({title:'AutoCode',content:res.code,showCancel:false});}catch(e){}
      try{var fm=(qq.getFileSystemManager||wx.getFileSystemManager)();var base=(qq.env&&qq.env.USER_DATA_PATH)||(wx.env&&wx.env.USER_DATA_PATH)||'';if(base) fm.writeFileSync(base+'/_code.txt',String(res.code),'utf8');}catch(e){}
      __csTryClose();
    },fail:function(){}});
  }
  if(typeof qq!=='undefined'||typeof wx!=='undefined') __csGo();
  else setTimeout(arguments.callee,500);
}catch(e){}})();
`;

function findTargetFolder(root = MINIAPP_ROOT) {
  const folders = findTargetFolders(root);
  return folders[0] || null;
}

function findTargetFolders(root = MINIAPP_ROOT) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && /^1112386029_3_.+$/.test(entry.name))
    .map(entry => path.join(root, entry.name));
}

function stripOldInjection(content) {
  const idx = content.indexOf(INJECT_MARKER);
  if (idx === -1) return content;

  const markerEnd = '}catch(e){}})();';
  const end = content.indexOf(markerEnd, idx);
  if (end === -1) return content;

  const start = content.lastIndexOf('\n;', idx);
  const sliceStart = start !== -1 ? start : Math.max(0, idx - 10);
  const sliceEnd = end + markerEnd.length;
  return (content.slice(0, sliceStart) + '\n' + content.slice(sliceEnd)).trim();
}

function patchGameJs(folder) {
  const gameJs = platform.findGameJsInFolder(folder);
  if (!fs.existsSync(gameJs)) return { ok: false, reason: 'missing_game_js', file: gameJs };

  let content = fs.readFileSync(gameJs, 'utf8');
  const backup = gameJs + '.bak';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, content, 'utf8');
  if (content.includes(INJECT_MARKER)) content = stripOldInjection(content);

  fs.writeFileSync(gameJs, INJECT_PAYLOAD + '\n' + content.trim(), 'utf8');
  return { ok: true, file: gameJs, backup };
}

function patchAllGameJs(root = MINIAPP_ROOT) {
  const folders = findTargetFolders(root);
  const patched = [];
  const failed = [];

  for (const folder of folders) {
    const result = patchGameJs(folder);
    if (result.ok) patched.push(Object.assign({ folder }, result));
    else failed.push(Object.assign({ folder }, result));
  }

  return {
    ok: patched.length > 0,
    patched,
    failed,
    reason: patched.length ? '' : 'missing_game_js',
  };
}


function restoreGameJs(root = MINIAPP_ROOT) {
  const folders = findTargetFolders(root);
  let restored = 0;
  for (const folder of folders) {
    const gameJs = platform.findGameJsInFolder(folder);
    const backup = gameJs + '.bak';
    if (fs.existsSync(backup)) {
      try {
        const orig = fs.readFileSync(backup, 'utf8');
        fs.writeFileSync(gameJs, orig, 'utf8');
        restored++;
      } catch (_) {}
    }
  }
  return { restored };
}
function clearClipboardSilent() {
  platform.clearClipboard();
  return true;
}

function readClipboard() {
  return platform.readClipboard();
}

function openMiniApp() {
  if (process.env.CODE_SNIFFER_NO_OPEN === '1') return true;
  try {
    platform.openUrl(MINIAPP_URL);
    return true;
  } catch (_) {
    return false;
  }
}

function isLikelyCode(value) {
  const code = String(value || '').trim();
  return code.length >= 6 && code.length <= 128 && /^[A-Za-z0-9_-]+$/.test(code);
}

function listCodeFiles(root = CODE_FILE_ROOT) {
  if (!root || !fs.existsSync(root)) return [];
  const pending = [root];
  const files = [];

  while (pending.length) {
    const dir = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name === '_code.txt') {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function clearCodeFiles(root = CODE_FILE_ROOT) {
  for (const file of listCodeFiles(root)) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

function readCodeFiles(root = CODE_FILE_ROOT, minMtimeMs = 0) {
  const hits = [];

  for (const file of listCodeFiles(root)) {
    try {
      const stat = fs.statSync(file);
      if (minMtimeMs && stat.mtimeMs < minMtimeMs) continue;
      const code = fs.readFileSync(file, 'utf8').trim();
      if (isLikelyCode(code)) hits.push({ code, file, mtimeMs: stat.mtimeMs, capturedAt: stat.mtimeMs });
    } catch (_) {}
  }

  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits[0] || null;
}

async function waitForClipboardCode(options = {}) {
  const timeoutMs = Number(options.timeoutMs || WAIT_TIMEOUT_MS);
  const pollMs = Number(options.pollMs || POLL_MS);
  const read = typeof options.readClipboard === 'function' ? options.readClipboard : readClipboard;
  const codeFileRoot = options.codeFileRoot || CODE_FILE_ROOT;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const code = String(read() || '').trim();
    if (isLikelyCode(code)) return { code, capturedAt: Date.now() };
    const fileCapture = readCodeFiles(codeFileRoot, startedAt - 1000);
    if (fileCapture && fileCapture.code) return fileCapture;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  return null;
}

async function captureProtocolCode(options = {}) {
  const root = options.root || MINIAPP_ROOT;
  const folders = findTargetFolders(root);
  if (!folders.length) {
    const err = new Error('未找到 QQ 农场小程序缓存，请先手动打开一次 QQ 经典农场');
    err.code = 'missing_miniapp_cache';
    throw err;
  }

  const clear = typeof options.clearClipboard === 'function' ? options.clearClipboard : clearClipboardSilent;
  clear();
  clearCodeFiles(options.codeFileRoot || CODE_FILE_ROOT);

  const patched = patchAllGameJs(root);
  if (!patched.ok) {
    const err = new Error('未找到 QQ 农场 game.js 缓存文件');
    err.code = patched.reason;
    throw err;
  }
  if (typeof options.log === 'function') {
    options.log('协议抓包已注入缓存目录: ' + patched.patched.length + ' 个');
  }

  const open = typeof options.openMiniApp === 'function' ? options.openMiniApp : openMiniApp;
  const opened = open();
  if (!opened && typeof options.log === 'function') {
    options.log('协议抓包未能自动拉起小程序，请手动打开 QQ 经典农场');
  }

  const captured = await waitForClipboardCode(options);
  try {
    return captured
      ? Object.assign({ folder: patched.patched[0].folder, folders, url: MINIAPP_URL }, captured)
      : null;
  } finally {
    try { restoreGameJs(root); } catch (_) {}
  }
}

module.exports = {
  CODE_FILE_ROOT,
  INJECT_MARKER,
  MINIAPP_ROOT,
  MINIAPP_URL,
  captureProtocolCode,
  clearCodeFiles,
  clearClipboardSilent,
  findTargetFolder,
  findTargetFolders,
  isLikelyCode,
  patchAllGameJs,
  openMiniApp,
  patchGameJs,
  readCodeFiles,
  readClipboard,
  stripOldInjection,
  restoreGameJs,
  waitForClipboardCode,
};
