/**
 * Cross-platform helpers for Windows and macOS.
 * Provides platform-specific paths, clipboard access, URL opening, and process lookup.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, execSync } = require('node:child_process');

/** @type {boolean} Whether the current platform is macOS. */
const IS_MAC = os.platform() === 'darwin';
/** @type {boolean} Whether the current platform is Windows. */
const IS_WIN = os.platform() === 'win32';

/**
 * Get the QQEX root directory.
 * - Windows: %APPDATA%\QQEX
 * - macOS: ~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX
 */
function getQqexRoot() {
  const home = os.homedir();
  if (IS_WIN) {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appdata, 'QQEX');
  }
  return path.join(
    home, 'Library', 'Containers',
    'com.tencent.qqexminiprogram', 'Data',
    'Library', 'Application Support', 'QQEX'
  );
}

/**
 * Get the miniapp cache root directory.
 */
function getMiniAppRoot() {
  return path.join(getQqexRoot(), 'miniapp', 'temps', 'miniapp_src');
}

/**
 * Find game.js below a target miniapp folder.
 * - Windows: folder/game.js
 * - macOS: folder/cocos-js/assets/game.js, or another nested structure.
 *
 * @param {string} folder Target folder path.
 * @returns {string} Found game.js path, or the default folder/game.js path.
 */
function findGameJsInFolder(folder) {
  const candidates = [
    path.join(folder, 'game.js'),
    path.join(folder, 'cocos-js', 'assets', 'game.js'),
  ];
  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
    } catch {}
  }
  // Fallback shallow search.
  try {
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(folder, entry.name);
      const deeper = [
        path.join(subDir, 'game.js'),
        path.join(subDir, 'assets', 'game.js'),
      ];
      for (const fp of deeper) {
        try {
          if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
        } catch {}
      }
    }
  } catch {}
  return path.join(folder, 'game.js');
}

/**
 * Open a URL.
 * - Windows: rundll32 url.dll,FileProtocolHandler / cmd /c start
 * - macOS: open
 *
 * @param {string} url URL to open.
 */
function openUrl(url) {
  if (IS_WIN) {
    try {
      execSync('rundll32 url.dll,FileProtocolHandler "' + url + '"', { windowsHide: true, timeout: 10000 });
    } catch {
      try {
        execSync('cmd.exe /c start "" "' + url + '"', { windowsHide: true, timeout: 10000, shell: true });
      } catch {}
    }
    return;
  }
  try {
    execFileSync('open', [url], { timeout: 10000 });
  } catch {}
}

/**
 * Read system clipboard content.
 * - Windows: powershell Get-Clipboard -Raw
 * - macOS: pbpaste
 *
 * @returns {string} Clipboard content.
 */
function readClipboard() {
  if (IS_WIN) {
    try {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', 'Get-Clipboard -Raw',
      ], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 });
      return out.toString('utf8').replace(/\r?\n$/, '');
    } catch { return ''; }
  }
  try {
    const out = execFileSync('pbpaste', [], { timeout: 3000, encoding: 'utf8' });
    return (out || '').trim();
  } catch { return ''; }
}

/**
 * Clear system clipboard content.
 * - Windows: powershell $null | Set-Clipboard
 * - macOS: osascript -e 'set the clipboard to ""'
 */
function clearClipboard() {
  if (IS_WIN) {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', '$null | Set-Clipboard',
      ], { windowsHide: true, timeout: 3000 });
    } catch {}
    return;
  }
  try {
    execFileSync('osascript', ['-e', 'set the clipboard to ""'], { timeout: 3000 });
  } catch {}
}

/**
 * Get process tree rows.
 * - Windows: powershell Get-CimInstance Win32_Process
 * - macOS: ps -eo pid,ppid,comm
 */
function getProcessTree() {
  if (IS_WIN) return getProcessTreeWin();
  return getProcessTreeMac();
}

function getProcessTreeWin() {
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"
    ], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(out.toString("utf8").trim());
    const items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    return items.map(function(r) { return { pid: Number(r.ProcessId), parentPid: Number(r.ParentProcessId), commandLine: String(r.CommandLine || "") }; });
  } catch { return []; }
}

function getProcessTreeMac() {
  try {
    const out = execFileSync("ps", ["-eo", "pid,ppid,comm"], { timeout: 3000, maxBuffer: 1024 * 1024, encoding: "utf8" });
    const lines = out.trim().split("\n").slice(1);
    return lines.map(function(line) {
      const parts = line.trim().split(/\s+/);
      return { pid: Number(parts[0]), parentPid: Number(parts[1]), commandLine: parts.slice(2).join(" ") || "" };
    }).filter(function(r) { return r.pid > 0; });
  } catch { return []; }
}

/**
 * Get QQ process IDs.
 * - Windows: query QQ.exe.
 * - macOS: query with pgrep -x QQ.
 */
function getQQPids() {
  if (IS_WIN) return getQQPidsWin();
  return getQQPidsMac();
}

function getQQPidsWin() {
  return new Promise(function(resolve) {
    var cp = require("node:child_process");
    var ps = cp.spawn("powershell", [
      "-NoProfile", "-Command",
      "(Get-Process -Name QQ -ErrorAction SilentlyContinue).Id | ConvertTo-Json"
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    var out = "";
    ps.stdout.on("data", function(d) { out += d.toString(); });
    ps.on("close", function() {
      try {
        var parsed = JSON.parse(out.trim());
        resolve(Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []));
      } catch(e) { resolve([]); }
    });
    setTimeout(function() { resolve([]); }, 3000);
  });
}

function getQQPidsMac() {
  return new Promise(function(resolve) {
    var cp = require("node:child_process");
    var ps = cp.spawn("pgrep", ["-x", "QQ"], { stdio: ["ignore", "pipe", "pipe"] });
    var out = "";
    ps.stdout.on("data", function(d) { out += d.toString(); });
    ps.on("close", function() {
      var pids = out.trim().split("\n").filter(Boolean).map(Number);
      resolve(pids);
    });
    setTimeout(function() { resolve([]); }, 3000);
  });
}

module.exports = {
  IS_MAC,
  IS_WIN,
  getQqexRoot,
  getMiniAppRoot,
  findGameJsInFolder,
  openUrl,
  readClipboard,
  clearClipboard,
  getProcessTree,
  getQQPids,
};
