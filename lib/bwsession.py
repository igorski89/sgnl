"""The shared Vaultwarden session: one unlock (bin/sgnl-unlock) for every
SGNL tool, terminal and agent session, until bin/sgnl-lock.

The session key lives in ~/.cache/sgnl/bw-session (dir 700, file 600;
SGNL_BW_SESSION_FILE overrides). An explicit BW_SESSION in the
environment wins. The key unlocks the vault only together with the bw
CLI's own data on this Mac; `bw lock` (bin/sgnl-lock) makes it useless.
"""
import os

SESSION_FILE = os.path.expanduser(os.environ.get("SGNL_BW_SESSION_FILE", "~/.cache/sgnl/bw-session"))


def ensure():
    """Set BW_SESSION from the shared file if it isn't set already."""
    if not os.environ.get("BW_SESSION") and os.path.isfile(SESSION_FILE):
        key = open(SESSION_FILE).read().strip()
        if key:
            os.environ["BW_SESSION"] = key
