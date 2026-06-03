"""Back-compat shim. The package is now `chromapakz`; prefer `import chromapakz`.

Kept so existing scripts that do `import depthcodec as dc` keep working.
"""
from chromapakz import *          # noqa: F401,F403
from chromapakz import LEVELS_FULL  # noqa: F401
