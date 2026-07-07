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

def inject_cookies(cookies, user_data_dir):
    ls = os.path.join(user_data_dir, 'Local State')
    with open(ls, 'r', encoding='utf-8') as f:
        state = json.load(f)
    ek = state.get('os_crypt', {}).get('encrypted_key', '')
    raw_key = base64.b64decode(ek)
    if raw_key[:5] == b'DPAPI':
        raw_key = raw_key[5:]
    key = dpapi_decrypt(raw_key)
    if not key or len(key) < 32:
        return False
    key = key[:32]
    
    from Cryptodome.Cipher import AES
    
    db = os.path.join(user_data_dir, 'Network', 'Cookies')
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
                print(f'WARN: {e}', file=sys.stderr)
    
    conn.commit()
    conn.close()
    return cnt > 0

def main():
    if len(sys.argv) < 2:
        print('Usage: redirect-login.py <input_json_file>', file=sys.stderr)
        sys.exit(1)
    
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    cookies = data.get('cookies', {})
    jump_url = data.get('jumpUrl', '')
    uin = data.get('uin', '')
    
    ud = os.path.join(os.environ.get('APPDATA', ''), 'QQ')
    
    # 1. Kill QQ
    os.system('taskkill /f /im QQ.exe 2>nul')
    time.sleep(1)
    
    # 2. Inject cookies
    if cookies:
        inject_cookies(cookies, ud)
        print(f'Cookies injected')
    
    # 3. Save jump URL for Frida agent to use
    if jump_url:
        info = {'uin': uin, 'jumpUrl': jump_url, 'cookies': cookies}
        tmp = os.path.join(os.environ.get('TMP', 'C:\\Temp'), 'qq_login_redirect.json')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(info, f)
        print(f'Redirect info saved to {tmp}')
    
    print('OK')
    sys.exit(0)

if __name__ == '__main__':
    main()