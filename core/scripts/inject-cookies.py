import sys, json, os, sqlite3, ctypes, time, base64
from ctypes import wintypes

crypt32 = ctypes.windll.crypt32
kernel32 = ctypes.windll.kernel32
CF = 0x01

class BLOB(ctypes.Structure):
    _fields_ = [('s', wintypes.DWORD), ('p', ctypes.POINTER(ctypes.c_char))]

def dpapi_decrypt(data):
    b = BLOB(len(data), ctypes.cast(data, ctypes.POINTER(ctypes.c_char)))
    o = BLOB(0, None)
    if crypt32.CryptUnprotectData(ctypes.byref(b), None, None, None, None, CF, ctypes.byref(o)):
        r = bytes(o.p[:o.s])
        kernel32.LocalFree(o.p)
        return r
    return None

def main():
    if len(sys.argv) < 2:
        print('ERROR: Usage: inject-cookies.py <cookies_json_file>', file=sys.stderr)
        sys.exit(1)
    
    fp = sys.argv[1]
    with open(fp, 'r', encoding='utf-8') as f:
        cookies = json.load(f)
    
    ud = os.path.join(os.environ.get('APPDATA', ''), 'QQ')
    
    ls = os.path.join(ud, 'Local State')
    with open(ls, 'r', encoding='utf-8') as f:
        state = json.load(f)
    ek = state.get('os_crypt', {}).get('encrypted_key', '')
    raw_key = base64.b64decode(ek)
    if raw_key[:5] == b'DPAPI':
        raw_key = raw_key[5:]
    key = dpapi_decrypt(raw_key)
    if not key or len(key) < 32:
        print('ERROR: Failed to decrypt key', file=sys.stderr)
        sys.exit(1)
    key = key[:32]
    
    from Cryptodome.Cipher import AES
    
    db = os.path.join(ud, 'Network', 'Cookies')
    conn = sqlite3.connect(db)
    c = conn.cursor()
    
    now = int((time.time() * 1000000) + 11644473600000000)
    exp = now + 86400 * 1000000
    
    cnt = 0
    for name, value in cookies.items():
        val = str(value)
        nonce = os.urandom(11)
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        ct, tag = cipher.encrypt_and_digest(val.encode('utf-8'))
        ev = b'v10' + nonce + ct + tag
        
        for domain in ['.qq.com', 'ptlogin2.qq.com']:
            try:
                c.execute('''INSERT OR REPLACE INTO cookies
                    (creation_utc,host_key,top_frame_site_key,name,value,encrypted_value,
                    path,expires_utc,is_secure,is_httponly,last_access_utc,
                    has_expires,is_persistent,priority,samesite,source_scheme,
                    source_port,last_update_utc,source_type,has_cross_site_ancestor)
                    VALUES(?,?,'',?,?,?, '/',?,1,1,?,1,1,1,2,1,443,?,0,0)''',
                    (now, domain, name, val, ev, exp, now, now))
                cnt += 1
            except Exception as e:
                print(f'WARN: {domain}/{name}: {e}', file=sys.stderr)
    
    conn.commit()
    conn.close()
    print(f'OK: {cnt} cookies written')
    sys.exit(0 if cnt > 0 else 1)

if __name__ == '__main__':
    main()