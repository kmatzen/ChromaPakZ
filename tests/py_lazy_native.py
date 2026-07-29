"""The package must import — and its pure-Python helpers must work — with no compiled `_core`.

`ctypes.CDLL` used to run at import time, so `import chromapakz` failed outright without a built
native library and none of the validation/spec helpers could be unit-tested. The load is now lazy;
this test locks that in (and is the reason it can run before/without `cmake --build`).

Run: python tests/py_lazy_native.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import chromapakz as cz

failed = 0


def ok(cond, msg):
    global failed
    if not cond:
        print("FAIL:", msg)
        failed += 1


def raises(exc, fn, *a, **kw):
    try:
        fn(*a, **kw)
    except exc:
        return True
    except Exception as e:                                   # noqa: BLE001 — wrong type is a failure
        print(f"  (raised {type(e).__name__}: {e})")
    return False


ok(cz._lib is None, "importing chromapakz must not load the native core")
ok(isinstance(cz.__version__, str) and cz.__version__, "__version__ must be a non-empty string")

# spec + validation helpers are pure Python and must not touch the library
ok(cz.inverse_depth_spec(0.3, 9.0) ==
   {"inverse_depth": True, "near": 0.3, "far": 9.0, "levels": cz.LEVELS_FULL},
   "inverse_depth_spec defaults to full 16-bit levels")
ok(cz.inverse_depth_spec(0.5, 4.0, 1024)["levels"] == 1024, "inverse_depth_spec honours levels")

ok(raises(ValueError, cz.inverse_depth_spec, 0.0, 4.0), "near must be > 0")
ok(raises(ValueError, cz.inverse_depth_spec, -1.0, 4.0), "negative near rejected")
ok(raises(ValueError, cz.inverse_depth_spec, 4.0, 4.0), "far must exceed near")
ok(raises(ValueError, cz.inverse_depth_spec, 5.0, 4.0), "far < near rejected")
ok(raises(ValueError, cz.inverse_depth_spec, 0.3, 9.0, 2), "levels must be >= 3")

# encode's own argument validation rejects bad input before any native call
ok(raises(ValueError, cz.encode), "encode with neither signals nor rgb")
ok(raises(ValueError, cz.encode, {}, None, None), "encode with empty signals and no rgb")

ok(cz._lib is None, "pure-Python helpers must not have loaded the native core")

# the loader itself still reports a usable error when the library genuinely isn't there
real_find = cz._find_lib
cz._find_lib = lambda: (_ for _ in ()).throw(OSError("native library not found — build it"))
try:
    ok(raises(OSError, cz._load), "_load surfaces OSError when _core is missing")
finally:
    cz._find_lib = real_find
    cz._lib = None

print(f"\n{failed} failed" if failed else "\nall passed")
sys.exit(1 if failed else 0)
