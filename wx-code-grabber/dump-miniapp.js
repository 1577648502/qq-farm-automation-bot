#!/usr/bin/env node
/**
 * 一键反编译/侦察 QQ 农场小程序 —— 动态 dump 法
 *
 * 背景: game.js 里业务代码经双层混淆
 *   1) System.js 打包(define 模块) + 字符串表(48555 条密文) + 索引重映射(O[9171] 形态)
 *   2) 关键函数走 JSVMP(_Аce_7716, Ace 字节码 VM) —— 静态还原成本极高
 * 动态方案: 注入探针到缓存 game.js, 运行时直接拿**明文**:
 *   a) hook qq.connectSocket → 拿网关 URL + 收发帧(GateMessage protobuf,
 *      meta 里有 service_name/method_name —— 这就是接口清单本体)
 *   b) hook System registry → dump 模块清单(活动模块名 = 功能清单)
 *   c) dump 字符串表(运行时解码后的明文表, 活动名/字段名全在里面)
 *
 * 产物写到 captures/dump-<ts>/:
 *   gateway.jsonl    每行一帧: {m:'__FARM_GATE__', dir, url, hex(b64), ts}
 *                    hex 是整帧 GateMessage protobuf; type=3 推送帧的 body 是
 *                    EventMessage{message_type=推送全名, body=负载}
 *   interfaces.md    汇总接口清单(serviceName/methodName 计数 + 推送名 + 错误码)
 *   modules.txt      System 注册的模块清单(活动模块名 = 功能清单)
 *   sockets.jsonl    socket 建立记录; probe.json 心跳; summary.json 摘要
 *
 * ⚠ 实现要点(线上实测踩坑, 改动前先读):
 *   1) INJECT_PAYLOAD 是模板串: 内部 JS 字符串里的换行必须写 \\n, 裸 \n 会被
 *      外层模板吃掉变成真实换行 → 注入的 game.js SyntaxError, 整个探针不执行。
 *   2) QQ 小程序 FileSystemManager 没有 appendFileSync → af() 用内存缓冲,
 *      定时 flush; flush 必须读旧文件拼接再 writeFileSync(覆盖写会丢历史帧)。
 *   3) 原生 SocketTask 上属性赋值静默失败(sloppy 无报错) → wrapSocketTask 返回
 *      包装对象转发, 不改 task 本身。
 *
 * 用法:
 *   node dump-miniapp.js                # 注入 + 唤起 + 等待采集(默认 90s)
 *   node dump-miniapp.js --timeout 120  # 采集窗口时长
 *   node dump-miniapp.js --no-reopen    # 不自动唤起, 手动打开农场
 *   node dump-miniapp.js --analyze      # 不注入, 只分析已 dump 的 gateway.jsonl
 *
 * 原理: 与 grab-code.js 相同的注入通道 —— 改缓存 game.js 头部, 小程序启动即执行,
 *       探针把数据写到 USER_DATA_PATH/_farmdump/ 下, 本脚本轮询读取。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile, spawn } = require('child_process');

const MINIAPP_URL = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';

const MINIAPP_ROOT = path.join(os.homedir(),
    'Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src');
const OUT_DIR = path.join(__dirname, 'captures');
const INJECT_MARKER = '__FARM_DUMP_INJECTED__';
const DUMP_DIR_IN_MINIAPP = '_farmdump';

// ---------- args ----------
const args = process.argv.slice(2);
const getArg = (name, dft) => {
    const i = args.indexOf(name);
    if (i === -1 || i + 1 >= args.length) return dft;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : dft;
};
const hasFlag = (name) => args.includes(name);
const TIMEOUT = getArg('--timeout', 90);
const NO_REOPEN = hasFlag('--no-reopen');
const ANALYZE_ONLY = hasFlag('--analyze');

// ---------- 注入探针(在 $PWD 农场小程序里执行) ----------
// ⚠ 这段代码会被 prepend 到 game.js 顶部, 必须无外部依赖、吞掉所有异常。
const INJECT_PAYLOAD = `
;;/*${INJECT_MARKER}*/(function(){try{
  var api=(typeof qq!=='undefined')?qq:((typeof wx!=='undefined')?wx:null);
  if(!api) return;
  var fm=api.getFileSystemManager&&api.getFileSystemManager();
  if(!fm) return;
  var base=(api.env&&api.env.USER_DATA_PATH)||'';
  if(!base) return;
  var DIR=base+'/${DUMP_DIR_IN_MINIAPP}';
  try{fm.mkdirSync(DIR,true)}catch(e){}
  function wf(name,data,enc){try{fm.writeFileSync(DIR+'/'+name,data,enc||'utf8')}catch(e){}}
  // QQ 小程序 FileSystemManager 可能没有 appendFileSync → 用内存缓冲+定时 writeFileSync
  var ACC={}; var FRAME_COUNT=0;
  function af(name,data){ try{ ACC[name]=(ACC[name]||'')+data; }catch(e){} }
  function flushAll(){
    try{
      for(var n in ACC){
        if(ACC[n]&&ACC[n].length){
          // writeFileSync 是覆盖写 → 先读旧内容拼上, 否则旧帧丢失
          var old='';
          try{ old=fm.readFileSync(DIR+'/'+n,'utf8'); }catch(e){}
          wf(n, old+ACC[n]);
          ACC[n]='';
        }
      }
    }catch(e){}
  }
  var t0=Date.now();
  wf('probe.json',JSON.stringify({started:t0,env:base,hasQQ:typeof qq,hasWX:typeof wx,same:typeof wx!=='undefined'&&wx===qq}));

  // ---- 1. System registry dump(模块清单) ----
  setTimeout(function(){
    try{
      var names=[];
      try{
        var reg=(window.System&&window.System.registry)||(globalThis.System&&globalThis.System.registry);
        if(reg){ for(var k in reg) names.push(k); }
      }catch(e){}
      if(!names.length){
        try{
          var S=(window.System||globalThis.System);
          if(S&&S.entries){ var it=S.entries(); var r; while(!(r=it.next()).done) names.push(String(r.value[0])); }
        }catch(e){}
      }
      wf('modules.txt',names.sort().join('\\n'));
    }catch(e){ wf('modules_error.txt',String(e&&e.message||e)); }
  },3000);

  // ---- 2. connectSocket / WebSocket 帧 dump ----
  // ⚠ 客户端 cocos adapter 写死 wx.connectSocket(game.js 源码可见), QQ 容器里 wx/qq 是两个
  //   不同全局对象 → 必须两个都 hook。hook 放在函数属性上(调用时解引用, 时序安全)。
  var FRAME_MAGIC='__FARM_GATE__';
  function flushFrame(line){ FRAME_COUNT++; af('gateway.jsonl', line+'\\n'); }
  function b64(buf){
    try{
      var u8=new Uint8Array(buf); var CH='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      var out='',n=u8.length;
      for(var i=0;i<n;i+=3){
        var a=u8[i],b=u8[i+1],c=u8[i+2];
        out+=CH[a>>2]+CH[((a&3)<<4)|(b||0)>>4]+(b===undefined?'=':CH[((b&15)<<2)|(c||0)>>6])+(c===undefined?'=':CH[c&63]);
      }
      return out;
    }catch(e){return ''}
  }
  function bytesOf(data){
    try{
      if(data instanceof ArrayBuffer) return new Uint8Array(data);
      if(data&&data.buffer instanceof ArrayBuffer){
        return new Uint8Array(data.buffer, data.byteOffset||0, data.byteLength||data.buffer.byteLength);
      }
      if(typeof data==='string'){ /* 忽略文本帧 */ }
    }catch(e){}
    return null;
  }
  function wrapSocketTask(task, url){
    // 原生 SocketTask 的属性赋值会静默失败 → 不改 task, 返回包装对象
    // (adapter 只把 connectSocket 返回值存 WeakMap 然后调方法, 包装对象全量转发)
    if(!task) return task;
    var wrapper={};
    try{ for(var k in task){ try{ wrapper[k]=task[k]; }catch(e){} } }catch(e){}
    try{
      var origSend=task.send.bind(task);
      wrapper.send=function(opt){
        try{
          var b=bytesOf(opt&&opt.data);
          if(b&&b.length) flushFrame(JSON.stringify({m:FRAME_MAGIC,dir:'C',url:String(url||''),hex:b64(b.buffer),ts:Date.now()-t0}));
        }catch(e){}
        return origSend(opt);
      };
    }catch(e){ try{ wrapper.send=task.send.bind(task); }catch(e2){} }
    try{
      var origOM=task.onMessage.bind(task);
      wrapper.onMessage=function(cb){
        return origOM(function(res){
          try{
            var b=bytesOf(res&&res.data);
            if(b&&b.length) flushFrame(JSON.stringify({m:FRAME_MAGIC,dir:'S',url:String(url||''),hex:b64(b.buffer),ts:Date.now()-t0}));
          }catch(e){}
          return cb(res);
        });
      };
    }catch(e){ try{ wrapper.onMessage=task.onMessage.bind(task); }catch(e2){} }
    try{
      ['onClose','onOpen','onError','close'].forEach(function(m){
        if(typeof task[m]==='function'&&!wrapper[m]) wrapper[m]=task[m].bind(task);
      });
    }catch(e){}
    af('sockets.jsonl',JSON.stringify({via:'wrap',url:String(url||''),hasSend:typeof wrapper.send,hasOM:typeof wrapper.onMessage,ts:Date.now()-t0})+'\\n');
    return wrapper;
  }
  function hookApi(apiObj, label){
    if(!apiObj||typeof apiObj.connectSocket!=='function') return;
    try{
      var orig=apiObj.connectSocket;
      function hooked(opt){
        var task=null;
        try{ task=orig.call(apiObj,opt); }catch(e){ throw e; }
        try{ af('sockets.jsonl',JSON.stringify({via:label,url:opt&&opt.url,ts:Date.now()-t0})+'\\n'); }catch(e){}
        return wrapSocketTask(task, opt&&opt.url);
      }
      apiObj.connectSocket=hooked;
    }catch(e){ af('hook_error.txt',label+':'+String(e&&e.message||e)+'\\n'); }
  }
  hookApi(api,'primary');
  try{ if(typeof wx!=='undefined'&&wx!==api) hookApi(wx,'wx'); }catch(e){}
  try{ if(typeof qq!=='undefined'&&qq!==api) hookApi(qq,'qq'); }catch(e){}

  // ---- 2b. 游戏直接 new 全局 WebSocket(不走 connectSocket) → 原型补丁 ----
  // 裸标识符 WebSocket 可能不走 globalThis 属性查找 → 不换类, 改给 RealWS.prototype
  // 的 send/addEventListener 打补丁: 任何 new WebSocket(...) 出来的实例都经过原型。
  try{
    var ProtoWS=null;
    try{ ProtoWS=WebSocket; }catch(e){}
    if(!ProtoWS){ try{ ProtoWS=globalThis.WebSocket; }catch(e){} }
    if(!ProtoWS){ try{ ProtoWS=window.WebSocket; }catch(e){} }
    af('wsdebug.jsonl',JSON.stringify({found:typeof ProtoWS,ts:Date.now()-t0})+'\\n');
    if(typeof ProtoWS==='function'&&ProtoWS.prototype){
      var proto=ProtoWS.prototype;
      if(typeof proto.send==='function'&&!proto.__farmdump){
        var origSend=proto.send;
        proto.send=function(data){
          try{
            {
              var b=bytesOf(data);
              if(b&&b.length) flushFrame(JSON.stringify({m:FRAME_MAGIC,dir:'C',url:'',hex:b64(b.buffer),ts:Date.now()-t0}));
            }
          }catch(e){}
          return origSend.apply(this,arguments);
        };
      }
      if(typeof proto.addEventListener==='function'&&!proto.__farmdump){
        var origAEL=proto.addEventListener;
        proto.addEventListener=function(type,listener){
          try{
            if(String(type)==='message'&&this.__farmdumpURL!==undefined){
              var orig=listener;
              listener=function(ev){
                try{
                  var b=bytesOf(ev&&ev.data);
                  if(b&&b.length) flushFrame(JSON.stringify({m:FRAME_MAGIC,dir:'S',url:'',hex:b64(b.buffer),ts:Date.now()-t0}));
                }catch(e){}
                return orig.apply(this,arguments);
              };
            }
          }catch(e){}
          return origAEL.call(this,type,listener);
        };
      }
      // 构造期记录 URL: 补丁 constructor 不可行(可能只读) → 周期扫描没法做, 改 hook open?
      // 简单可靠方案: 给实例标记做不了就放弃 URL, 用空串。靠原型 send/AEL 抓帧。
      try{ proto.__farmdump=true; }catch(e){}
      af('wsdebug.jsonl',JSON.stringify({patched:true,hasSend:typeof proto.send,hasAEL:typeof proto.addEventListener,ts:Date.now()-t0})+'\\n');
    }else{
      af('wsdebug.jsonl',JSON.stringify({found:'missing',ts:Date.now()-t0})+'\\n');
    }
  }catch(e){ try{ af('hook_error.txt','WSG:'+String(e&&e.message||e)+'\\n'); }catch(e2){} }

  // ---- 2c. 实例标记: 每次 new 之后无法插桩 → 直接在原型补丁里不带 URL 也能抓帧 ----
  try{
    // 补 chrome 风格 onmessage 属性赋值通道: defineProperty on prototype 不拦截实例赋值,
    // 但游戏用 addEventListener(上一轮已在 bundle 源码确认) → 不需要。
    af('wsdebug.jsonl',JSON.stringify({stage:'ready',ts:Date.now()-t0})+'\\n');
  }catch(e){}

  // ---- 3. 周期心跳 ----
  setInterval(function(){ flushAll(); },1500);
  setInterval(function(){ wf('probe.json',JSON.stringify({alive:Date.now(),started:t0,hasQQ:typeof qq,hasWX:typeof wx,same:typeof wx!=='undefined'&&wx===qq,frames:FRAME_COUNT})); },5000);
}catch(e){}})();
`;

// ---------- 注入(复用 grab-code 的 patch 机制) ----------
function findGameJsFiles() {
    if (!fs.existsSync(MINIAPP_ROOT)) return [];
    const out = [];
    for (const name of fs.readdirSync(MINIAPP_ROOT)) {
        if (!/^1112386029_3_.+$/.test(name)) continue;
        const f = path.join(MINIAPP_ROOT, name, 'game.js');
        if (fs.existsSync(f)) out.push(f);
    }
    return out;
}

function stripOld(content) {
    const i = content.indexOf(`/*${INJECT_MARKER}*/`);
    if (i === -1) return content;
    const end = content.indexOf('(function(){try{', i);
    if (end === -1) return content;
    // 找探针 IIFE 结束: '}catch(e){}})();'
    const marker = '}catch(e){}})();';
    const e2 = content.indexOf(marker, end);
    if (e2 === -1) return content;
    return (content.slice(0, i) + content.slice(e2 + marker.length)).trim();
}

function injectAll() {
    const files = findGameJsFiles();
    const patched = [];
    for (const f of files) {
        let content = fs.readFileSync(f, 'utf8');
        const bak = f + '.dumpbak';
        if (!fs.existsSync(bak)) fs.writeFileSync(bak, content, 'utf8');
        if (content.includes(`/*${INJECT_MARKER}*/`)) content = stripOld(content);
        fs.writeFileSync(f, INJECT_PAYLOAD.trimStart() + '\n' + content, 'utf8');
        patched.push(f);
    }
    return patched;
}

function restoreAll() {
    const files = findGameJsFiles();
    for (const f of files) {
        const bak = f + '.dumpbak';
        if (fs.existsSync(bak)) {
            fs.copyFileSync(bak, f);
        }
    }
}

// ---------- 小程序数据目录(写入端) → 本地读取 ----------
// USER_DATA_PATH 在 QQ 小程序容器里的宿主路径, 与 fs/1577648502/1112386029/usr 对应
const MINIAPP_USR = path.join(os.homedir(),
    'Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/fs/1577648502/1112386029/usr');
const DUMP_HOST_DIR = path.join(MINIAPP_USR, DUMP_DIR_IN_MINIAPP);

function readDumpFiles() {
    if (!fs.existsSync(DUMP_HOST_DIR)) return {};
    const out = {};
    for (const name of ['gateway.jsonl', 'modules.txt', 'probe.json', 'sockets.jsonl', 'hook_error.txt', 'modules_error.txt']) {
        const f = path.join(DUMP_HOST_DIR, name);
        if (fs.existsSync(f)) out[name] = fs.readFileSync(f, 'utf8');
    }
    return out;
}

function openMiniProgram() {
    // 与 grab-code 同款: tencent:// 让 QQ 自己拉起农场(零权限)
    try {
        execFileSync('open', [MINIAPP_URL], { stdio: 'ignore' });
        return true;
    } catch {
        try { execFileSync('open', ['-a', 'QQ'], { stdio: 'ignore' }); return true; } catch { return false; }
    }
}

function hasRunningFarm() {
    try {
        const out = execFileSync('ps', ['-Ao', 'command='], { timeout: 5000, encoding: 'utf8' });
        return /QQEXMiniProgram/.test(out);
    } catch { return false; }
}

function closeRunningFarm() {
    try { execFileSync('pkill', ['-f', 'QQEXMiniProgram'], { timeout: 5000 }); } catch { /* 无匹配 */ }
}

// ---------- 分析: 解 GateMessage → 接口清单 ----------
async function analyze(dumpDir) {
    const gatewayFile = path.join(dumpDir, 'gateway.jsonl');
    if (!fs.existsSync(gatewayFile)) {
        console.log('[analyze] 没有 gateway.jsonl');
        return null;
    }
    // 用项目的 proto 定义解帧
    process.chdir(path.join(__dirname, '..', 'core'));
    const protobuf = require(path.join(__dirname, '..', 'core', 'node_modules', 'protobufjs'));
    const root = new protobuf.Root();
    root.loadSync(path.join(__dirname, '..', 'core', 'src', 'proto', 'game.proto'), { keepCase: false });
    const GateMessage = root.lookupType('gatepb.Message');
    const EventMessage = root.lookupType('gatepb.EventMessage');

    const cryptoWasm = require(path.join(__dirname, '..', 'core', 'src', 'utils', 'crypto-wasm'));
    const lines = fs.readFileSync(gatewayFile, 'utf8').split('\n').filter(Boolean);
    const stats = new Map();   // service.method -> {req, resp, err, bodies:[]}
    let okFrames = 0, skip = 0;
    for (const line of lines) {
        let j; try { j = JSON.parse(line); } catch { skip++; continue; }
        if (j.m !== '__FARM_GATE__' || !j.hex) { skip++; continue; }
        let buf;
        try { buf = Buffer.from(j.hex, 'base64'); } catch { skip++; continue; }
        let msg;
        try { msg = GateMessage.decode(buf); } catch { skip++; continue; }
        const meta = msg.meta || {};
        let key = `${meta.serviceName || '?'}/${meta.methodName || '?'}`;
        // type=3 推送帧: body 是 EventMessage{message_type=推送全名, body=负载}
        let notifyBody = null;
        if (Number(meta.messageType) === 3 && msg.body && msg.body.length) {
            try {
                const ev = EventMessage.decode(msg.body);
                if (ev.messageType) key = ev.messageType;
                notifyBody = ev.body;
            } catch { /* 保底用 ?/? */ }
        }
        if (!stats.has(key)) stats.set(key, { req: 0, resp: 0, notify: 0, err: 0, errCodes: new Map(), bodies: [] });
        const s = stats.get(key);
        const type = Number(meta.messageType);
        let body = notifyBody || msg.body;
        if (body && body.length) {
            try { body = await cryptoWasm.decryptBuffer(body); } catch { /* 密文保底 */ }
        }
        if (type === 1) s.req++;
        else if (type === 2) s.resp++;
        else s.notify++;
        const errCode = Number(meta.errorCode && meta.errorCode.valueOf ? meta.errorCode.valueOf() : meta.errorCode) || 0;
        if (errCode) {
            s.err++;
            s.errCodes.set(String(errCode), String(meta.errorMessage || ''));
        }
        if (body && body.length) {
            s.bodies.push({
                dir: type === 1 ? 'C->S' : 'S->C',
                bodyHex: Buffer.from(body).toString('hex').slice(0, 4000),
                err: errCode,
            });
            if (s.bodies.length > 200) s.bodies.shift();
        }
        okFrames++;
    }
    return { stats, okFrames, skip };
}

function writeInterfacesMd(stats, outDir) {
    const rows = [...stats.entries()].sort((a, b) => (b[1].req + b[1].resp) - (a[1].req + a[1].resp));
    const md = [];
    md.push('# 农场小程序接口清单(动态 dump)');
    md.push('');
    md.push('| 接口 | 请求 | 响应 | 推送 | 错误 | 错误码样本 |');
    md.push('|---|---:|---:|---:|---:|---|');
    for (const [k, v] of rows) {
        const errs = [...v.errCodes.entries()].map(([c, m]) => `${c}:${m}`).slice(0, 3).join('<br>');
        md.push(`| ${k} | ${v.req} | ${v.resp} | ${v.notify} | ${v.err} | ${errs || '-'} |`);
    }
    md.push('');
    for (const [k, v] of rows) {
        md.push(`## ${k}`);
        for (const b of v.bodies.slice(0, 8)) {
            md.push(`- ${b.dir} err=${b.err} body: \`${b.bodyHex.slice(0, 160)}${b.bodyHex.length > 160 ? '…' : ''}\``);
        }
        md.push('');
    }
    fs.writeFileSync(path.join(outDir, 'interfaces.md'), md.join('\n'));
}

// ---------- main ----------
async function main() {
    if (ANALYZE_ONLY) {
        const dirs = fs.readdirSync(OUT_DIR).filter(n => n.startsWith('dump-')).sort();
        const latest = dirs[dirs.length - 1];
        if (!latest) { console.log('[analyze] 没有历史 dump'); process.exit(1); }
        const dumpDir = path.join(OUT_DIR, latest);
        console.log('[analyze] 分析', dumpDir);
        const r = await analyze(dumpDir);
        if (r) {
            writeInterfacesMd(r.stats, dumpDir);
            const summary = { frames: r.okFrames, skipped: r.skip, interfaces: [...r.stats.keys()] };
            fs.writeFileSync(path.join(dumpDir, 'summary.json'), JSON.stringify(summary, null, 2));
            console.log(`[analyze] 帧 ${r.okFrames} 跳过 ${r.skip}, 接口 ${r.stats.size} 个 → interfaces.md`);
        }
        return;
    }

    // 清旧数据
    try { fs.rmSync(DUMP_HOST_DIR, { recursive: true, force: true }); } catch { }

    // ⚠ 时序必须是: 先关实例 → 再注入 → 再唤起。
    //   先注入后关的话, 正在跑的 farm 退出时可能回写缓存目录, 覆盖掉注入(线上实测踩过)。
    if (!NO_REOPEN && hasRunningFarm()) {
        console.log('[dump] 关掉已在跑的农场实例...');
        closeRunningFarm();
        await new Promise(r => setTimeout(r, 3000));
    }

    console.log('[dump] 注入探针...');
    let patched = injectAll();
    console.log('[dump] 已注入', patched.length, '个缓存目录');

    if (!NO_REOPEN) {
        console.log('[dump] 唤起农场小程序...');
        openMiniProgram();
    } else {
        console.log('[dump] 请手动打开 QQ 农场');
    }

    console.log(`[dump] 采集 ${TIMEOUT}s (探针写 ${DUMP_HOST_DIR})...`);
    const t0 = Date.now();
    let lastSizes = '';
    let knownDirs = new Set(findGameJsFiles());
    // farm 启动瞬间可能下新版本到新缓存目录并改用它 → 注入白打。
    // 对策(grab-code 同款): 周期盯新目录, 出现就补注入(已关实例则重启一轮)
    let nextDirCheck = Date.now() + 6000;
    while (Date.now() - t0 < TIMEOUT * 1000) {
        await new Promise(r => setTimeout(r, 5000));
        if (Date.now() >= nextDirCheck) {
            nextDirCheck = Date.now() + 6000;
            const now = new Set(findGameJsFiles());
            const fresh = [...now].filter(f => !knownDirs.has(f));
            if (fresh.length) {
                console.log('[dump] 检测到', fresh.length, '个新缓存目录(农场更新), 补注入...');
                for (const f of fresh) {
                    let content = fs.readFileSync(f, 'utf8');
                    const bak = f + '.dumpbak';
                    if (!fs.existsSync(bak)) fs.writeFileSync(bak, content, 'utf8');
                    if (!content.includes(`/*${INJECT_MARKER}*/`)) {
                        fs.writeFileSync(f, INJECT_PAYLOAD.trimStart() + '\n' + content, 'utf8');
                    }
                    knownDirs.add(f);
                }
                // 新目录要重启实例才加载
                if (!NO_REOPEN && hasRunningFarm()) {
                    closeRunningFarm();
                    await new Promise(r => setTimeout(r, 1500));
                    openMiniProgram();
                }
            }
        }
        const d = readDumpFiles();
        const gw = d['gateway.jsonl'] || '';
        const sig = `${gw.length}`;
        if (sig !== lastSizes) {
            lastSizes = sig;
            const lines = gw ? gw.split('\n').filter(Boolean).length : 0;
            console.log(`[dump] ${(Date.now() - t0) / 1000 | 0}s: frames=${lines} modules=${(d['modules.txt'] || '').split('\n').filter(Boolean).length}`);
        }
        if (lines0() > 0 && Date.now() - t0 > 25000) {
            // 已有帧落盘, 采够了就提前收
            break;
        }
    }
    function lines0() {
        const f = path.join(DUMP_HOST_DIR, 'gateway.jsonl');
        try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
    }

    console.log('[dump] 还原 game.js...');
    restoreAll();

    // 收集产物
    const outDir = path.join(OUT_DIR, `dump-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
    fs.mkdirSync(outDir, { recursive: true });
    const d = readDumpFiles();
    for (const [name, content] of Object.entries(d)) {
        fs.writeFileSync(path.join(outDir, name), content);
    }
    console.log('[dump] 产物:', outDir);

    console.log('[dump] 解帧 → 接口清单...');
    try {
        const r = await analyze(outDir);
        if (r) {
            writeInterfacesMd(r.stats, outDir);
            fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
                frames: r.okFrames, skipped: r.skip, interfaces: [...r.stats.keys()],
            }, null, 2));
            console.log(`[dump] ✓ 帧 ${r.okFrames}, 跳过 ${r.skip}, 接口 ${r.stats.size} 个`);
        }
    } catch (e) {
        console.log('[dump] 解析失败(稍后可 --analyze 重跑):', e.message);
    }

    console.log('完成。接口清单:', path.join(outDir, 'interfaces.md'));
}

main().catch(e => { console.error(e); process.exit(1); });
