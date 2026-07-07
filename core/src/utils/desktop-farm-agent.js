const FARM_URL = 'https://h5.qzone.qq.com/qqq/';
const TENCENT_URL = 'tencent://miniapp/?appid=1112386029';
const REPORT_URL = 'http://127.0.0.1:PORT/api/desktop-login/agent-status';
let opened = false;
function report(action, data) {
    try {
        var http = new XMLHttpRequest();
        http.open('POST', REPORT_URL, false);
        http.setRequestHeader('Content-Type', 'application/json');
        http.setRequestHeader('X-Frida-Hook', '1');
        http.send(JSON.stringify({ action: action, farmUrl: FARM_URL, pid: Process.id || 0, processName: Process.name || '', timestamp: Date.now(), ...data }));
    } catch (e) {}
}
function tryShellExecuteW(url) {
    try {
        var ptr = Module.findExportByName('shell32.dll', 'ShellExecuteW');
        if (!ptr) return false;
        var func = new NativeFunction(ptr, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'int']);
        var NULL = ptr(0);
        func(NULL, Memory.allocUtf16String('open'), Memory.allocUtf16String(url), NULL, NULL, 5);
        return true;
    } catch (e) { return false; }
}
function tryCreateProcess(cmdLine) {
    try {
        var ptr = Module.findExportByName('kernel32.dll', 'CreateProcessW');
        if (!ptr) return false;
        var func = new NativeFunction(ptr, 'int', ['pointer', 'pointer', 'pointer', 'pointer', 'int', 'int', 'pointer', 'pointer', 'pointer', 'pointer']);
        var si = Memory.alloc(68);
        si.writeU32(68);
        var pi = Memory.alloc(8);
        var cmd = Memory.allocUtf16String(cmdLine);
        func(NULL, cmd, NULL, NULL, 0, 0x04000000, NULL, NULL, si, pi);
        return true;
    } catch (e) { return false; }
}
function tryInternetOpenUrl() {
    try {
        var ptr = Module.findExportByName('wininet.dll', 'InternetOpenUrlW');
        if (!ptr) return false;
        var internet = Module.findExportByName('wininet.dll', 'InternetOpenW');
        if (!internet) return false;
        var openFunc = new NativeFunction(internet, 'pointer', ['pointer', 'int', 'pointer', 'pointer', 'int']);
        var hInternet = openFunc(Memory.allocUtf16String('FarmOpener'), 0, NULL, NULL, 0);
        if (!hInternet || hInternet.isNull()) return false;
        var urlFunc = new NativeFunction(ptr, 'pointer', ['pointer', 'pointer', 'pointer', 'int', 'int', 'pointer']);
        urlFunc(hInternet, Memory.allocUtf16String(FARM_URL), NULL, 0, 0, NULL);
        return true;
    } catch (e) { return false; }
}
function main() {
    console.log('[FarmOpener] Starting... PID: ' + Process.id);
    // Strategy 1: CreateProcess to launch QQ.exe with --url (sends to existing instance)
    if (tryCreateProcess('cmd /c start "" "https://h5.qzone.qq.com/qqq/"')) { opened = true; report('farm_opened', { method: 'CreateProcess' }); return; }
    // Strategy 2: ShellExecuteW with tencent:// protocol
    if (tryShellExecuteW(TENCENT_URL)) { opened = true; report('farm_opened', { method: 'tencent' }); return; }
    // Strategy 3: ShellExecuteW with https URL
    if (tryShellExecuteW(FARM_URL)) { opened = true; report('farm_opened', { method: 'ShellExecuteW' }); return; }
    // Strategy 4: InternetOpenUrlW to trigger URL in QQ's network stack
    if (tryInternetOpenUrl()) { opened = true; report('farm_opened', { method: 'InternetOpenUrl' }); return; }
    // Strategy 5: WinExec fallback
    try {
        var ptr = Module.findExportByName('kernel32.dll', 'WinExec');
        if (ptr) {
            var func = new NativeFunction(ptr, 'int', ['pointer', 'int']);
            func(Memory.allocUtf16String('start "" "' + FARM_URL + '"'), 5);
            opened = true; report('farm_opened', { method: 'WinExec' }); return;
        }
    } catch (e) {}
    report('farm_error', { error: 'All strategies failed' });
}
setTimeout(main, 1500);
