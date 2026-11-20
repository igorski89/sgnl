"""The shared Vaultwarden session: one unlock (bin/sgnl-unlock) for every
SGNL tool, terminal and agent session, until bin/sgnl-lock.

The session key lives in ~/.cache/sgnl/bw-session (dir 700, file 600;
SGNL_BW_SESSION_FILE overrides). An explicit BW_SESSION in the
environment wins. The key unlocks the vault only together with the bw
CLI's own data on this Mac; `bw lock` (bin/sgnl-lock) makes it useless.

A forgotten unlock doesn't last: a session file older than
SGNL_BW_SESSION_HOURS (default 12) since bin/sgnl-unlock is treated as
bin/sgnl-lock (vault locked, file removed).
"""
import os, subprocess, sys, time

SESSION_FILE = os.path.expanduser(os.environ.get("SGNL_BW_SESSION_FILE", "~/.cache/sgnl/bw-session"))
MAX_HOURS = float(os.environ.get("SGNL_BW_SESSION_HOURS", "12"))


def ensure():
    """Set BW_SESSION from the shared file if it isn't set already."""
    if not os.environ.get("BW_SESSION") and os.path.isfile(SESSION_FILE):
        if time.time() - os.path.getmtime(SESSION_FILE) > MAX_HOURS * 3600:
            subprocess.run(["bw", "lock"], capture_output=True)
            os.remove(SESSION_FILE)
            print(f"Vaultwarden: the shared session is older than {MAX_HOURS:g} h and was locked; "
                  "bin/sgnl-unlock to go on.", file=sys.stderr)
            return
        key = open(SESSION_FILE).read().strip()
        if key:
            os.environ["BW_SESSION"] = key
