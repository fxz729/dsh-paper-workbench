"""Run a Python driver only while its owning DSH process is alive."""
import os
import runpy
import sys
import threading
import time


def monitor_owner(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.WaitForSingleObject.restype = wintypes.DWORD
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.OpenProcess(0x00100000, False, pid)
        if not handle:
            os._exit(130)
        def watch():
            try:
                # A real process handle avoids treating a reused PID as our owner.
                api.WaitForSingleObject(handle, 0xFFFFFFFF)
                os._exit(130)
            finally:
                api.CloseHandle(handle)
    else:
        def watch():
            while os.getppid() == pid:
                time.sleep(.25)
            os._exit(130)
    threading.Thread(target=watch, name='dpr-owner-watch', daemon=True).start()


if __name__ == '__main__':
    pid = int(os.environ['DPR_PARENT_PID'])
    monitor_owner(pid)
    sys.argv = sys.argv[1:]
    runpy.run_path(sys.argv[0], run_name='__main__')
