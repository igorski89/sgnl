# Sourced by shell scripts: the instance values as exported SGNL_*
# variables. The instance lives in SGNL_INSTANCE_DIR (default: instance/,
# relative to the repo root), its values in $SGNL_INSTANCE_DIR/sgnl.env.
_sgnl_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export SGNL_INSTANCE_DIR=${SGNL_INSTANCE_DIR:-instance}
_sgnl_dir=$SGNL_INSTANCE_DIR
[[ $_sgnl_dir == /* ]] || _sgnl_dir=$_sgnl_root/$_sgnl_dir
set -a
# shellcheck disable=SC1090,SC1091
source "$_sgnl_dir/sgnl.env"
set +a
unset _sgnl_root _sgnl_dir
