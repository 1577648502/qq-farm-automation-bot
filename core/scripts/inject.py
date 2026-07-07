""""
QQ Farm Hook Injector
注入 ws-hook.dll 到 QQ.exe 进程，自动捕获 farm WebSocket code
用法: python inject.py [--pid PID]
"""
import ctypes, ctypes.wintypes, sys, time, os

PROCESS_ALL_ACCESS = 0x1F0FFF
MEM_COMMIT = 0x1000
MEM_RESERVE = 0x2000
PAGE_READWRITE = 0x04

def find_qq():
    """Find QQ.exe process"""
    import subprocess
    result = subprocess.run(
        ['powershell', '-Command', 
         'Get-Process QQ | Where-Object {.SessionId -ne 0} | Select-Object -First 1 -ExpandProperty Id'],
        capture_output=True, text=True
    )
    pid = result.stdout.strip()
    return int(pid) if pid.isdigit() else None

def inject_dll(pid, dll_path):
    """Inject DLL into process by PID using CreateRemoteThread + LoadLibrary"""
    kernel32 = ctypes.windll.kernel32
    
    # Open process
    h_process = kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not h_process:
        err = ctypes.GetLastError()
        print(f"OpenProcess failed: {err}")
        return False
    
    # Allocate memory in target process
    dll_path_bytes = dll_path.encode('utf-8')
    path_len = len(dll_path_bytes) + 1
    h_mem = kernel32.VirtualAllocEx(h_process, None, path_len, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
    if not h_mem:
        err = ctypes.GetLastError()
        print(f"VirtualAllocEx failed: {err}")
        kernel32.CloseHandle(h_process)
        return False
    
    # Write DLL path to target process memory
    written = ctypes.c_size_t()
    result = kernel32.WriteProcessMemory(h_process, h_mem, dll_path_bytes, path_len, ctypes.byref(written))
    if not result:
        err = ctypes.GetLastError()
        print(f"WriteProcessMemory failed: {err}")
        kernel32.VirtualFreeEx(h_process, h_mem, 0, 0x8000)
        kernel32.CloseHandle(h_process)
        return False
    
    # Get LoadLibraryA address in kernel32.dll
    kernel32_module = kernel32.GetModuleHandleW("kernel32.dll")
    load_library_addr = kernel32.GetProcAddress(kernel32_module, b"LoadLibraryA")
    
    # Create remote thread to call LoadLibraryA(dll_path)
    h_thread = kernel32.CreateRemoteThread(h_process, None, 0, load_library_addr, h_mem, 0, None)
    if not h_thread:
        err = ctypes.GetLastError()
        print(f"CreateRemoteThread failed: {err}")
        kernel32.VirtualFreeEx(h_process, h_mem, 0, 0x8000)
        kernel32.CloseHandle(h_process)
        return False
    
    # Wait for thread to finish
    kernel32.WaitForSingleObject(h_thread, 5000)
    
    # Get thread exit code
    exit_code = ctypes.c_ulong()
    kernel32.GetExitCodeThread(h_thread, ctypes.byref(exit_code))
    
    # Clean up
    kernel32.CloseHandle(h_thread)
    kernel32.VirtualFreeEx(h_process, h_mem, 0, 0x8000)
    kernel32.CloseHandle(h_process)
    
    print(f"Injected! Thread exit code: {exit_code.value}")
    return exit_code.value != 0

def main():
    pid = None
    if len(sys.argv) > 1 and sys.argv[1] == '--pid':
        pid = int(sys.argv[2])
    
    if not pid:
        pid = find_qq()
    
    if not pid:
        print("QQ.exe not running. Please start QQ.exe first.")
        sys.exit(1)
    
    dll_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'scripts', 'ws-hook.dll'))
    if not os.path.exists(dll_path):
        print(f"DLL not found: {dll_path}")
        # Try relative path
        dll_path = os.path.abspath('core/scripts/ws-hook.dll')
    
    if not os.path.exists(dll_path):
        print(f"DLL not found at {dll_path}")
        sys.exit(1)
    
    print(f"Target PID: {pid}")
    print(f"DLL: {dll_path}")
    
    success = inject_dll(pid, dll_path)
    if success:
        print("SUCCESS: ws-hook.dll injected into QQ.exe!")
        print("Waiting for farm WebSocket connections...")
    else:
        print("FAILED: injection did not work")
        sys.exit(1)

if __name__ == '__main__':
    main()
