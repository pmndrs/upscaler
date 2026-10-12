from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import argparse
import json

parser = argparse.ArgumentParser(description='Compare matching baseline and extracted-core RGBA captures.')
parser.add_argument('baseline', type=Path, help='Directory containing upstream baseline PNG captures')
parser.add_argument('candidate', type=Path, help='Directory containing the corresponding candidate PNG captures')
args = parser.parse_args()
upstream, fork = args.baseline, args.candidate
baseline_names = {capture.name for capture in upstream.glob('*.png')}
candidate_names = {capture.name for capture in fork.glob('*.png')}
if not baseline_names:
    raise RuntimeError('No baseline PNG captures found')
if baseline_names != candidate_names:
    missing = sorted(baseline_names - candidate_names)
    unexpected = sorted(candidate_names - baseline_names)
    raise RuntimeError(f'Capture sets differ: missing={missing}, unexpected={unexpected}')
results = []
for original in sorted(upstream.glob('*.png')):
    candidate = fork / original.name
    a, b = Image.open(original).convert('RGBA'), Image.open(candidate).convert('RGBA')
    if a.size != b.size:
        raise RuntimeError('Different viewport dimensions')
    difference = ImageChops.difference(a, b)
    statistics = ImageStat.Stat(difference)
    maximum = max(high for low, high in difference.getextrema())
    rms = max(statistics.rms)
    results.append({'capture': original.name, 'maxChannelDifference': maximum, 'maxChannelRms': rms, 'pass': maximum <= 1 and rms <= 0.25})
output = fork / 'upstream-comparison.json'
output.write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results, indent=2))
if not results or not all(r['pass'] for r in results):
    raise RuntimeError('Upstream comparison failed')
