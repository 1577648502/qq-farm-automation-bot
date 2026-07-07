const path = require('node:path');

const FARM_HOST = 'gate-obt.nqf.qq.com';
const FARM_CODE_RE = /[?&]code=([A-Za-z0-9_-]{16,})/i;

function parseFarmCodeFromText(text) {
  const source = String(text || '');
  if (!source.includes(FARM_HOST)) return '';

  const match = source.match(FARM_CODE_RE);
  return match && match[1] ? decodeURIComponent(match[1]) : '';
}

function rememberCapturedCode({ sessionsDb, uin, code, capturedAt = Date.now() }) {
  const sessionUin = String(uin || '').trim();
  const farmCode = String(code || '').trim();
  if (!sessionUin || !farmCode) {
    return { ok: false, reason: 'missing_uin_or_code' };
  }

  sessionsDb.update(sessionUin, {
    farmCode,
    lastCapturedAt: capturedAt,
  });

  return { ok: true, code: farmCode, capturedAt };
}

function createDesktopFarmCapture(options = {}) {
  const fs = options.fs || require('node:fs');
  const sessionsDb = options.sessionsDb;
  const log = typeof options.log === 'function' ? options.log : function() {};
  const dataDir = options.dataDir || path.join(process.cwd(), 'data');
  const captureFile = options.captureFile || path.join(dataDir, 'fiddler-code.json');
  const pendingByUin = new Map();
  let lastCapture = null;

  function setCode({ uin, code, url = '', pid = 0, capturedAt = Date.now() }) {
    const farmCode = String(code || '').trim() || parseFarmCodeFromText(url);
    if (!farmCode) return { ok: false, reason: 'missing_code' };

    const sessionUin = String(uin || '').trim();
    if (sessionUin && sessionsDb) {
      rememberCapturedCode({ sessionsDb, uin: sessionUin, code: farmCode, capturedAt });
    }

    const payload = { code: farmCode, url, pid, capturedAt };
    if (sessionUin) pendingByUin.set(sessionUin, payload);
    lastCapture = payload;
    log(`捕获到农场 code: ${farmCode.substring(0, 8)}...`);
    return { ok: true, ...payload };
  }

  function readCaptureFile() {
    if (!fs.existsSync(captureFile)) return null;
    const raw = fs.readFileSync(captureFile, 'utf-8');
    try {
      const data = JSON.parse(raw);
      const code = String(data.code || '').trim() || parseFarmCodeFromText(data.url || raw);
      return code ? { code, url: data.url || '', capturedAt: Number(data.capturedAt || data.time || Date.now()) } : null;
    } catch {
      const code = parseFarmCodeFromText(raw);
      return code ? { code, url: raw, capturedAt: Date.now() } : null;
    }
  }

  async function waitForCode(uin, timeoutMs = 30000, intervalMs = 500) {
    const sessionUin = String(uin || '').trim();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const pending = pendingByUin.get(sessionUin);
      if (pending && pending.code) return pending;
      if (lastCapture && lastCapture.code) return lastCapture;

      const fileCapture = readCaptureFile();
      if (fileCapture && fileCapture.code) {
        if (sessionUin && sessionsDb) {
          rememberCapturedCode({
            sessionsDb,
            uin: sessionUin,
            code: fileCapture.code,
            capturedAt: fileCapture.capturedAt,
          });
        }
        pendingByUin.set(sessionUin, fileCapture);
        return fileCapture;
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    return null;
  }

  function clear(uin) {
    const sessionUin = String(uin || '').trim();
    if (sessionUin) pendingByUin.delete(sessionUin);
    lastCapture = null;
    try {
      if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile);
    } catch {
      // best effort cleanup
    }
  }

  return {
    setCode,
    waitForCode,
    clear,
    captureFile,
  };
}

module.exports = {
  FARM_HOST,
  parseFarmCodeFromText,
  rememberCapturedCode,
  createDesktopFarmCapture,
};
