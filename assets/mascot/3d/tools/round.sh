#!/bin/bash
# one critic round: render the three reference stills, compose, score vs the icons, build critic boards
#   bash tools/round.sh <out_dir>
set -euo pipefail
cd "$(dirname "$0")/.."
O=$1
/opt/homebrew/bin/blender -b --factory-startup -P talos_build.py -- --render stills --out "$O" --super 3 2>&1 | grep -E "\[talos\]|Error|rror" || true
python3 tools/finish.py compose "$O" "$O/stills" --sub stills-raw > /dev/null
for n in pleased beaming worried; do
  python3 tools/score.py "$O/stills/ref-$n/0001.png" ../../brand/talos-$n-source.png "$O/$n" > /dev/null
  python3 -c "import json; d=json.load(open('$O/$n-score.json')); print('$n iou', d['iou'], 'W/H', d['width_over_H'], {k:(v['ref'] and (v['ref']['x'],v['ref']['y'],v['ref']['r']), v['render'] and (v['render']['x'],v['render']['y'],v['render']['r'])) for k,v in d['parts'].items()})"
done
python3 tools/critic_sheet.py "$O/stills" ../../brand "$O/boards" > /dev/null
