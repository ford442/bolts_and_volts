#!/usr/bin/env python3
"""Synthesize the ability sound effects: public/ground_pound.mp3, hover.mp3 and switch.mp3.

Names match what the simulation emits (Game::dispatchEvents in cpp/src/Game.cpp). The sounds are generated
from scratch (sine sweeps and filtered noise, fixed seed), so there is nothing third-party to license and a
re-run reproduces them. Edit the recipes below and re-run to retune.

    python3 scripts/gen_sfx.py

Requires numpy and an ffmpeg with libmp3lame on PATH.
"""
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public"
RATE = 44100
PEAK = 0.8  # about -2 dBFS, in line with jump.mp3 / land.mp3 (both peak near -1 dBFS)
rng = np.random.default_rng(1234)


def t_axis(seconds):
    return np.arange(int(RATE * seconds)) / RATE


def sweep(t, f0, f1):
    """Sine whose frequency glides exponentially f0 -> f1 over the length of `t`."""
    k = np.log(f1 / f0) / t[-1]
    phase = 2 * np.pi * f0 * (np.exp(k * t) - 1) / k
    return np.sin(phase)


def lowpass(x, cutoff):
    """One-pole low-pass; cheap and plenty for noise shaping."""
    a = 1 - np.exp(-2 * np.pi * cutoff / RATE)
    out = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += a * (v - acc)
        out[i] = acc
    return out


def env(t, attack, decay):
    """Linear attack then exponential decay (time constant `decay`)."""
    return np.minimum(t / attack, 1.0) * np.exp(-t / decay)


def ground_pound():
    """Heavy thump: a fast low sine drop plus a short noise crack on the hit."""
    t = t_axis(0.5)
    body = sweep(t, 150, 42) * env(t, 0.004, 0.11)
    crack = lowpass(rng.uniform(-1, 1, t.size), 1800) * env(t, 0.001, 0.03)
    return 0.9 * body + 0.5 * crack


def hover():
    """Rising electric hum: a gliding tone with a fast tremolo under a soft whoosh of noise."""
    t = t_axis(0.55)
    tone = sweep(t, 220, 440) * (0.75 + 0.25 * np.sin(2 * np.pi * 28 * t))
    whoosh = lowpass(rng.uniform(-1, 1, t.size), 900) * 2.0
    swell = np.sin(np.pi * np.clip(t / t[-1], 0, 1)) ** 1.5  # fade in and out, no click
    return (0.6 * tone + 0.35 * whoosh) * swell


def switch():
    """Two quick rising blips (a 'zap-zap'), the second a fourth higher."""
    gap = np.zeros(int(RATE * 0.03))
    blips = []
    for f0, f1 in ((520, 880), (700, 1180)):
        t = t_axis(0.09)
        square = np.sign(np.sin(2 * np.pi * np.cumsum(np.linspace(f0, f1, t.size)) / RATE))  # bright, 8-bit
        tone = lowpass(square, 3500)  # a raw square rings and overshoots when mp3-encoded
        blips += [0.5 * tone * env(t, 0.002, 0.05), gap]
    return np.concatenate(blips)


def write_mp3(name, samples):
    samples = samples / np.max(np.abs(samples)) * PEAK
    fade = min(int(RATE * 0.005), samples.size)
    samples[-fade:] *= np.linspace(1, 0, fade)  # never end mid-wave
    pcm = (samples * 32767).astype("<i2")
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / f"{name}.wav"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(pcm.tobytes())
        mp3 = OUT / f"{name}.mp3"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame", "-b:a", "96k", str(mp3)],
            check=True,
        )
    print(f"{mp3.relative_to(ROOT)}  {samples.size / RATE:.2f}s  {mp3.stat().st_size} bytes")


if __name__ == "__main__":
    write_mp3("ground_pound", ground_pound())
    write_mp3("hover", hover())
    write_mp3("switch", switch())
