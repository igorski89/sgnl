"""Instance values ($SGNL_INSTANCE_DIR/sgnl.env) for Python scripts, the {{SGNL_*}} renderer for static config
files, and the choice of instance, which is MANDATORY: no tool ever falls back to one.

Choosing (one of; they must agree if several are given):
  --instance <name>      first argument of any tool (removed before the tool reads its arguments)
  SGNL_INSTANCE=<name>   environment
  SGNL_INSTANCE_DIR=<d>  environment (what wrappers, CI and child processes pass on)
<name> is the instance's SGNL_ORG_SLUG; the instances are the instance/ and instance.*/ dirs of the repo.

A dev instance (SGNL_ENV=dev, docs/DEV.md) also gets its environment's secrets file, CA bundle and its own bw CLI
data dir, never the real vault's (the same as bin/sgnl-dev sets)."""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _fail(msg):
    sys.exit("sgnl: " + msg)


def _read(env_path):
    vals = {}
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        vals[k.strip()] = v
    return vals


def instances():
    """{name: dir relative to the repo} for every instance dir with a sgnl.env."""
    out = {}
    for d in sorted(os.listdir(ROOT)):
        if (d == "instance" or d.startswith("instance.")) and os.path.isfile(os.path.join(ROOT, d, "sgnl.env")):
            name = _read(os.path.join(ROOT, d, "sgnl.env")).get("SGNL_ORG_SLUG")
            if name:
                out[name] = d
    return out


def _abs(d):
    return os.path.realpath(d if os.path.isabs(d) else os.path.join(ROOT, d))


def _choose(name):
    """Sets SGNL_INSTANCE_DIR and SGNL_INSTANCE in os.environ (so child processes inherit the choice), plus a dev
    instance's environment. Returns the exports as (key, value or None for unset)."""
    known = instances()
    env_name, env_dir = os.environ.get("SGNL_INSTANCE"), os.environ.get("SGNL_INSTANCE_DIR")
    names = ", ".join(known) or "none found"
    for n in (name, env_name):
        if n and n not in known:
            _fail(f"no instance {n!r} (instances: {names})")
    if name and env_name and name != env_name:
        _fail(f"--instance {name} disagrees with SGNL_INSTANCE={env_name}")
    want = name or env_name
    if want and env_dir and _abs(known[want]) != _abs(env_dir):
        _fail(f"--instance {want} disagrees with SGNL_INSTANCE_DIR={env_dir} (already chosen by a wrapper?)")
    if not want and not env_dir:
        _fail(f"which instance? Add --instance <name> as the first argument (instances: {names})")
    d = known[want] if want else env_dir
    if not os.path.isfile(os.path.join(_abs(d), "sgnl.env")):
        _fail(f"no sgnl.env in {d}")
    vals = _read(os.path.join(_abs(d), "sgnl.env"))
    exports = [("SGNL_INSTANCE_DIR", d), ("SGNL_INSTANCE", vals.get("SGNL_ORG_SLUG", ""))]
    if vals.get("SGNL_ENV") == "dev":
        envdir = os.path.join(os.path.expanduser("~/.sgnl-dev"), os.environ.get("SGNL_DEV_NAME", "sgnl-dev"))
        exports += [("BW_SESSION", None), ("BITWARDENCLI_APPDATA_DIR", os.path.join(envdir, "bw")),
                    ("SGNL_BW_SESSION_FILE", os.path.join(envdir, "bw-session"))]
        if not os.environ.get("SGNL_SECRETS"):
            exports.append(("SGNL_SECRETS", "csv:" + os.path.join(envdir, "secrets.csv")))
        bundle, ca = os.path.expanduser("~/.sgnl-dev/ca-bundle.pem"), os.path.expanduser("~/.sgnl-dev/ca/rootCA.pem")
        if os.path.isfile(bundle) and not os.environ.get("SSL_CERT_FILE"):
            exports += [(k, bundle) for k in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE")]
        if os.path.isfile(ca) and not os.environ.get("NODE_EXTRA_CA_CERTS"):
            exports.append(("NODE_EXTRA_CA_CERTS", ca))
    for k, v in exports:
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    return exports


def _from_argv():
    """A leading --instance <name> / --instance=<name>, removed from sys.argv in place."""
    a = sys.argv
    if len(a) > 1 and a[1].startswith("--instance="):
        name = a[1].split("=", 1)[1]; del a[1]; return name
    if len(a) > 1 and a[1] == "--instance":
        if len(a) < 3:
            _fail("--instance needs a name")
        name = a[2]; del a[1:3]; return name
    return None


def instance_dir():
    return _abs(os.environ["SGNL_INSTANCE_DIR"])


def path():
    return os.path.join(instance_dir(), "sgnl.env")


def load():
    """KEY=value / KEY="value" lines; the process environment wins."""
    vals = _read(path())
    vals.update({k: v for k, v in os.environ.items() if k.startswith("SGNL_")})
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


if __name__ == "__main__" and sys.argv[1:2] == ["--resolve"]:
    # For lib/instance.sh: the choice as shell exports. Usage: instance.py --resolve [name]
    import shlex
    for k, v in _choose(sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None):
        print(f"unset {k}" if v is None else f"export {k}={shlex.quote(v)}")
else:
    # Imported by a tool: choose now, before the tool reads its arguments.
    _choose(_from_argv())
