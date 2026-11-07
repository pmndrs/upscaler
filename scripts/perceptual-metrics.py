"""Offline perceptual metrics for a measure-reference-quality.mjs run.

Local only: not in CI and not behind any pnpm script. Scores the PNG
sequences written by `--export-png` (8-bit sRGB, the presented frame) with
LPIPS (per frame, AlexNet) and, per measured window as one video,
ColorVideoVDP and FovVideoVDP (JOD; 10 = indistinguishable from the
reference). Setup and how to read the numbers: bench/docs/REFERENCE-QUALITY.md.

    python3 -m venv .venv-metrics
    .venv-metrics/bin/pip install torch lpips cvvdp pyfvvdp pillow
    .venv-metrics/bin/python scripts/perceptual-metrics.py \
        bench/results/raw/reference-quality/baseline-Q19-2x [--display standard_fhd] [--fps 60]

Writes perceptual.json next to the run's summary.json.
"""

import argparse
import json
import os

import numpy as np
import torch
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("run", help="a reference-quality output directory written with --export-png")
parser.add_argument("--display", default="standard_fhd", help="ColorVideoVDP/FovVideoVDP display model")
parser.add_argument("--fps", type=float, default=60, help="playback rate (the bench steps at 60 Hz)")
args = parser.parse_args()

import lpips  # noqa: E402  (imported after argparse so --help stays fast)
import pycvvdp  # noqa: E402
import pyfvvdp  # noqa: E402

with open(os.path.join(args.run, "summary.json")) as handle:
    summary = json.load(handle)
modes = list(summary["results"])


def load(folder, frames):
    """F×H×W×3 uint8 frames of one window."""
    return np.stack([np.asarray(Image.open(os.path.join(args.run, "png", folder, f"f{f:04d}.png")).convert("RGB")) for f in frames])


def to_lpips(frame):
    """H×W×3 uint8 → 1×3×H×W in [-1, 1], LPIPS's input range."""
    return torch.from_numpy(frame).permute(2, 0, 1)[None].float() / 127.5 - 1


lpips_net = lpips.LPIPS(net="alex", verbose=False)
cvvdp = pycvvdp.cvvdp(display_name=args.display)
fvvdp = pyfvvdp.fvvdp(display_name=args.display, heatmap=None)

results = {}
for window in summary["windows"]:
    frames = range(window["start"], window["end"] + 1)
    reference = load("reference", frames)
    for mode in modes:
        test = load(mode, frames)
        with torch.no_grad():
            per_frame = [lpips_net(to_lpips(t), to_lpips(r)).item() for t, r in zip(test, reference)]
        cv_jod, _ = cvvdp.predict(test, reference, dim_order="FHWC", frames_per_second=args.fps)
        fv_jod, _ = fvvdp.predict(test, reference, dim_order="FHWC", frames_per_second=args.fps)
        row = {"lpips": float(np.mean(per_frame)), "cvvdp": float(cv_jod), "fvvdp": float(fv_jod), "lpipsPerFrame": per_frame}
        results.setdefault(window["name"], {})[mode] = row
        print(f"{window['name']:<16} {mode:<9} LPIPS {row['lpips']:.4f}  ColorVideoVDP {row['cvvdp']:.3f} JOD  FovVideoVDP {row['fvvdp']:.3f} JOD")

with open(os.path.join(args.run, "perceptual.json"), "w") as handle:
    json.dump({"display": args.display, "fps": args.fps, "results": results}, handle, indent=2)
