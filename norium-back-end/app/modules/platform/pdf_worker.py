"""Worker standalone: nenhum bootstrap, segredo, arquivo do usuário ou rede.

O pai envia o PDF por stdin e recebe somente JSON por stdout. Os limites do
sistema operacional são instalados antes de importar pypdf ou ler o documento.
"""

from __future__ import annotations

import json
import sys
from io import BytesIO


def _windows_limits(memory_bytes: int, cpu_seconds: int) -> int:
    """Limites de memória comprometida e CPU via Job Object nativo do Windows."""
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
            ("flags", wintypes.DWORD), ("min_working_set", ctypes.c_size_t),
            ("max_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
            ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
            ("scheduling", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "read_operations", "write_operations", "other_operations",
            "read_bytes", "write_bytes", "other_bytes",
        )]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("basic", BasicLimits), ("io", IoCounters),
            ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
            ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
    ]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    # PROCESS_TIME | ACTIVE_PROCESS | PROCESS_MEMORY | KILL_ON_JOB_CLOSE.
    limits.basic.flags = 0x2 | 0x8 | 0x100 | 0x2000
    limits.basic.process_time = cpu_seconds * 10_000_000
    limits.basic.active_processes = 1
    limits.process_memory = memory_bytes
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        error = ctypes.get_last_error()
        kernel.CloseHandle(job)
        raise ctypes.WinError(error)
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        error = ctypes.get_last_error()
        kernel.CloseHandle(job)
        raise ctypes.WinError(error)
    # Manter o handle aberto até a saída do worker; fechá-lo encerraria o processo.
    return job


def apply_resource_limits(memory_bytes: int, cpu_seconds: int) -> int | None:
    if sys.platform == "win32":
        return _windows_limits(memory_bytes, cpu_seconds)
    if sys.platform != "linux":
        raise OSError("Unsupported PDF resource limits")
    import resource

    # Nunca elevar um limite herdado mais restritivo.
    for kind, requested in (
        (resource.RLIMIT_AS, memory_bytes), (resource.RLIMIT_CPU, cpu_seconds),
        (resource.RLIMIT_CORE, 0),
    ):
        _soft, hard = resource.getrlimit(kind)
        limit = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
        resource.setrlimit(kind, (limit, limit))
    return None


def main() -> None:
    memory, cpu, max_pages, max_chars, min_chars, max_bytes = map(int, sys.argv[1:])
    try:
        job_handle = apply_resource_limits(memory, cpu)
    except (OSError, ValueError, ImportError):
        print('{"error":"limits"}')
        return
    try:
        from pypdf import PdfReader
    except ImportError:
        print('{"error":"unavailable"}')
        return
    try:
        raw = sys.stdin.buffer.read(max_bytes + 1)
        if len(raw) > max_bytes:
            result = {"error": "size"}
        elif not raw.startswith(b"%PDF"):
            result = {"error": "invalid"}
        else:
            reader = PdfReader(BytesIO(raw))
            if len(reader.pages) > max_pages:
                result = {"error": "pages"}
            else:
                pages: list[str] = []
                characters = 0
                for page in reader.pages:
                    text = (page.extract_text() or "").strip()
                    characters += len(text)
                    if characters > max_chars:
                        print('{"error":"text"}')
                        return
                    pages.append(text)
                result = (
                    {"pages": pages} if len("\n\n".join(pages).strip()) >= min_chars
                    else {"error": "no_text"}
                )
        output = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
        sys.stdout.write(output)
        sys.stdout.flush()
    except MemoryError:
        print('{"error":"resources"}')
    except Exception:
        print('{"error":"read"}')
    # job_handle permanece vivo até aqui; seu valor não é enviado ao pai.


if __name__ == "__main__":
    main()
