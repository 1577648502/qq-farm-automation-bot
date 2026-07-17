#!/usr/bin/env python3
import binascii, zlib, struct

d = open("/Users/liufaguang/Downloads/LICENSE/app/qcby-vxcode", "rb").read()

# Extract EXACT prefix/suffix bytes referenced by activationCodeCandidates
def v2f(v):
    if 0xf38000 <= v < 0xf38000 + 0xf0a4ac: return v - 0xf38000 + 0xb38000
    return None

# From disasm: rbx lea @ 0xe5aab7 -> prefix (len 12); r8 lea @ 0xe5aaa5 -> suffix (len 14)
# resolve those two LEAs
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
md = Cs(CS_ARCH_X86, CS_MODE_64); md.detail = True
def lea_target(faddr):
    for ins in md.disasm(d[faddr:faddr+7], faddr + 0x400000):
        return ins.address + ins.size + ins.disp
pre_v = lea_target(0xa5aab7); suf_v = lea_target(0xa5aaa5)
pre = d[v2f(pre_v):v2f(pre_v)+12]
suf = d[v2f(suf_v):v2f(suf_v)+14]
print("prefix(12) =", pre)
print("suffix(14) =", suf)

def candidates(mc: str):
    s = pre + mc.encode() + suf
    n = zlib.crc32(s) & 0xffffffff      # crc32 IEEE == zlib.crc32
    signed = struct.unpack("<i", struct.pack("<I", n))[0]
    cands = {
        "%d (uint32)": str(n),
        "%d (int32) ": str(signed),
        "%08x       ": "%08x" % n,
        "%08X       ": "%08X" % n,
        "0x%08x     ": "0x%08x" % n,
        "0x%08X     ": "0x%08X" % n,
    }
    return s, n, cands

for mc in ["HW-F5CB2332"]:
    s, n, cands = candidates(mc)
    print("\n=== machine code: %s ===" % mc)
    print("canonical string:", s.decode())
    print("crc32 IEEE = %u (0x%08x)" % (n, n))
    print("--- ANY of these Codes will activate ---")
    for k, v in cands.items():
        print("  %s : %s" % (k, v))
