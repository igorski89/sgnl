# Sourced by shell scripts (at the top, before they read their arguments): the instance values as exported SGNL_*
# variables. The instance must be chosen, never a default (lib/instance.py): a leading --instance <name> (removed
# from the script's arguments here), or SGNL_INSTANCE / SGNL_INSTANCE_DIR from the environment.
_sgnl_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
_sgnl_name=
if [[ ${1:-} == --instance=* ]]; then _sgnl_name=${1#--instance=}; shift
elif [[ ${1:-} == --instance ]]; then
  [[ $# -ge 2 ]] || { echo "sgnl: --instance needs a name" >&2; exit 1; }
  _sgnl_name=$2; shift 2
fi
_sgnl_exports=$(python3 "$_sgnl_root/lib/instance.py" --resolve "$_sgnl_name") || exit 1
eval "$_sgnl_exports"
_sgnl_dir=$SGNL_INSTANCE_DIR
[[ $_sgnl_dir == /* ]] || _sgnl_dir=$_sgnl_root/$_sgnl_dir
set -a
# shellcheck disable=SC1090,SC1091
source "$_sgnl_dir/sgnl.env"
set +a
unset _sgnl_root _sgnl_name _sgnl_exports _sgnl_dir
