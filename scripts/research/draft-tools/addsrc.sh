#!/bin/bash
# usage: addsrc.sh <url> <kind> <publisher> <title> [published YYYY-MM]
cd "${CANDEF_REPO:-$PWD}"
export CANDEF_AUTHOR="${CANDEF_AUTHOR:-agent:claude-code/claude-sonnet-5-5}"
S="$(cd "$(dirname "$0")" && pwd)"
out=$(npx tsx pipeline/cli/candef.ts source add "$1" --kind "$2" --tier T1 --publisher "$3" --title "$4" ${5:+--published $5} 2>&1 | head -1)
id=$(echo "$out" | grep -o 'src_[0-9a-f]*' | head -1)
python -I -X utf8 $S/setperm.py . $id src_1ba8fa472c79 >/dev/null
cap=$(npx tsx pipeline/cli/candef.ts capture $id 2>&1 | tail -1)
echo "$id | $4 | $cap" | cut -c1-200
