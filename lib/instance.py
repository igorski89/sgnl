"""Instance values ($SGNL_INSTANCE_DIR/sgnl.env, default instance/) for
Python scripts, and the {{SGNL_*}} renderer for static config files."""
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def instance_dir():
    d = os.environ.get("SGNL_INSTANCE_DIR", "instance")
    return d if os.path.isabs(d) else os.path.join(ROOT, d)


def path():
    return os.path.join(instance_dir(), "sgnl.env")


def load():
    """KEY=value / KEY="value" lines; the process environment wins."""
    vals = {}
    for line in open(path()):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        vals[k.strip()] = v
    vals.update({k: v for k, v in os.environ.items() if k.startswith("SGNL_")})
    vals.setdefault("SGNL_INSTANCE_DIR", os.environ.get("SGNL_INSTANCE_DIR", "instance"))
    return vals


def render(text, vals=None):
    """Fills {{SGNL_NAME}}; an unknown name is an error."""
    vals = load() if vals is None else vals

    def fill(m):
        if m.group(1) not in vals:
            raise KeyError(f"{m.group(1)} is not set in {path()}")
        return vals[m.group(1)]
    return re.sub(r"\{\{(SGNL_[A-Z0-9_]+)\}\}", fill, text)


def get(key):
    v = load().get(key)
    if v is None:
        raise KeyError(f"{key} is not set in {path()}")
    return v
