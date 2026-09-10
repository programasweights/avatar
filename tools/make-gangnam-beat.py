#!/usr/bin/env python3
"""Synthesize an original electronic groove for the avatar launch clip.

Requires Python 3 and NumPy. No samples, recorded music, downloaded assets,
neural models, or melodies from the referenced dance are used. All sound is
generated from oscillators and deterministically seeded filtered noise.

    python3 tools/make-gangnam-beat.py --output /tmp/avatar-beat.wav

The default is 20 beats at 132 BPM (9.0909 seconds), stereo 48 kHz PCM WAV.
It starts 0.3 beat into the groove to match the launch choreography; the next
whole beat lands at 0.31818 seconds. Use --phase-beats 0 for a downbeat start.
The companion JSON records timing, levels, and provenance. This is optional
accompaniment; the animation and commands remain understandable without it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import wave
from pathlib import Path

import numpy as np


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--bpm', type=float, default=132.0)
    parser.add_argument('--beats', type=int, default=20)
    parser.add_argument('--phase-beats', type=float, default=.3)
    parser.add_argument('--sample-rate', type=int, default=48000)
    parser.add_argument('--seed', type=int, default=132)
    args = parser.parse_args()
    if not 40 <= args.bpm <= 240 or not 4 <= args.beats <= 128:
        parser.error('Use 40–240 BPM and 4–128 beats.')
    if args.sample_rate not in (44100, 48000):
        parser.error('Use a sample rate of 44100 or 48000 Hz.')
    if not 0 <= args.phase_beats < 4:
        parser.error('Use a phase offset from 0 up to, but not including, 4 beats.')
    return args


class Groove:
    def __init__(self, sample_rate, bpm, beats, seed, phase_beats):
        self.sample_rate = sample_rate
        self.beat = 60.0 / bpm
        self.beats = beats
        self.phase_beats = phase_beats
        self.source_beats = math.ceil(beats + phase_beats)
        self.random = np.random.default_rng(seed)
        # Render a lead-in and complete decay tails before taking the excerpt.
        self.mix = np.zeros((round((self.source_beats + 1) * self.beat * sample_rate), 2))
        self.events = []

    def clock(self, duration):
        return np.arange(round(duration * self.sample_rate)) / self.sample_rate

    def noise(self, duration, low, high):
        count = round(duration * self.sample_rate)
        noise = self.random.normal(0, 1, count)
        frequencies = np.fft.rfftfreq(count, 1 / self.sample_rate)
        high_pass = frequencies**2 / (frequencies**2 + low**2)
        low_pass = 1 / np.sqrt(1 + (frequencies / high)**8)
        noise = np.fft.irfft(np.fft.rfft(noise) * high_pass * low_pass, count)
        return noise / max(float(np.sqrt(np.mean(noise**2))), 1e-12)

    def add(self, sound, beat, level, pan=0, label=None):
        start = round(beat * self.beat * self.sample_rate)
        count = min(len(sound), len(self.mix) - start)
        if start < 0 or count <= 0:
            return
        angle = (pan + 1) * math.pi / 4
        gains = np.array([math.cos(angle), math.sin(angle)])
        self.mix[start:start + count] += sound[:count, None] * level * gains
        if label:
            relative_beat = beat - self.phase_beats
            time = relative_beat * self.beat
            duration = len(sound) / self.sample_rate
            if time + duration > 0 and time < self.beats * self.beat:
                self.events.append({
                    'source_beat': beat,
                    'beat': round(relative_beat, 6),
                    'time': round(time, 6),
                    'duration': round(duration, 6),
                    'sound': label,
                })

    def kick(self):
        t = self.clock(.32)
        frequency = 51 + 105 * np.exp(-t / .013) + 12 * np.exp(-t / .07)
        phase = 2 * math.pi * np.cumsum(frequency) / self.sample_rate
        body = np.sin(phase) * np.exp(-t / .081)
        click = self.noise(.32, 1600, 7200) * np.exp(-t / .0035) * .022
        attack = 1 - np.exp(-t / .0007)
        return (body + click) * attack

    def clap(self):
        t = self.clock(.22)
        envelope = np.zeros_like(t)
        for delay, amplitude in ((0, .7), (.010, .9), (.021, 1)):
            age = np.maximum(0, t - delay)
            envelope += amplitude * np.exp(-age / .008) * (t >= delay)
        envelope += .36 * np.exp(-np.maximum(0, t - .021) / .045) * (t >= .021)
        air = self.noise(.22, 950, 7500) * envelope * .22
        body = .11 * np.sin(2 * math.pi * 182 * t) * np.exp(-t / .030)
        return (air + body) * np.minimum(1, t / .0007)

    def hat(self, opened=False):
        duration = .17 if opened else .065
        t = self.clock(duration)
        metal = sum(np.sin(2 * math.pi * f * t) for f in (6100, 8137, 10303)) / 3
        texture = .86 * self.noise(duration, 5600, 14500) + .14 * metal
        envelope = np.exp(-t / (.042 if opened else .013))
        return texture * envelope * np.minimum(1, t / .0004) * .25

    def bass(self, frequency=55, duration=.16):
        t = self.clock(duration)
        phase = 2 * math.pi * frequency * t
        # One pitch class with occasional octave emphasis; no melodic quotation.
        oscillator = np.sin(phase) + .16 * np.sin(2 * phase) + .04 * np.sin(3 * phase)
        attack = 1 - np.exp(-t / .005)
        release = np.minimum(1, np.maximum(0, duration - t) / .035)
        return oscillator * attack * np.exp(-t / .13) * release * .43

    def make(self):
        kick = self.kick()
        clap = self.clap()
        for beat in range(self.source_beats):
            self.add(kick, beat, .90 if beat % 4 == 0 else .83, label='kick')
            if beat % 2:
                self.add(clap, beat, .60, label='clap')
                # Quiet room-like echoes provide width without a reverb sample.
                self.add(clap, beat + .036 / self.beat, .041, pan=-.45)
                self.add(clap, beat + .059 / self.beat, .025, pan=.5)
            if beat < self.source_beats - 1:
                self.add(self.hat(opened=beat % 4 == 3), beat + .5, .38, pan=.13, label='offbeat hat')
                self.add(self.hat(), beat + .25, .075, pan=-.23)
                self.add(self.hat(), beat + .75, .10, pan=-.13)
                self.add(self.bass(), beat + .52, .45 if beat % 4 != 2 else .36, label='bass pulse')
            # A restrained variation every second bar; still anchored to the grid.
            if beat % 8 == 6 and beat < self.source_beats - 2:
                self.add(self.bass(110, .11), beat + .82, .16, label='octave bass accent')

        # Crop on the source beat phase, then master/fade the exact requested
        # duration. An onset just before zero can have an audible decaying tail;
        # its negative event timestamp explicitly records that relationship.
        start = round(self.phase_beats * self.beat * self.sample_rate)
        count = round(self.beats * self.beat * self.sample_rate)
        self.mix = self.mix[start:start + count].copy()
        self.mix -= np.mean(self.mix, axis=0)
        self.mix = np.tanh(self.mix * 1.25) / 1.25
        rms = float(np.sqrt(np.mean(self.mix**2)))
        peak = float(np.max(np.abs(self.mix)))
        gain = min(10**(-17 / 20) / rms, 10**(-1.1 / 20) / peak)
        self.mix *= gain
        fade_in = round(.002 * self.sample_rate)
        fade_out = round(.045 * self.sample_rate)
        self.mix[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
        self.mix[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
        return self.mix


def main():
    args = arguments()
    groove = Groove(args.sample_rate, args.bpm, args.beats, args.seed, args.phase_beats)
    samples = groove.make()
    pcm = np.round(samples * 32767).astype('<i2')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), 'wb') as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(args.sample_rate)
        output.writeframes(pcm.tobytes())
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples**2)))
    report = {
        'file': args.output.name,
        'bpm': args.bpm,
        'beats': args.beats,
        'phase_beats': args.phase_beats,
        'first_full_kick_seconds': next(event['time'] for event in groove.events if event['sound'] == 'kick' and event['time'] >= 0),
        'duration_seconds': len(samples) / args.sample_rate,
        'sample_rate': args.sample_rate,
        'channels': 2,
        'bits_per_sample': 16,
        'seed': args.seed,
        'peak_dbfs': round(20 * math.log10(peak), 3),
        'rms_dbfs': round(20 * math.log10(rms), 3),
        'clipped_samples': int(np.count_nonzero(np.abs(samples) >= 1)),
        'edge_samples': [pcm[0].tolist(), pcm[-1].tolist()],
        'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
        'provenance': 'Original procedural synthesis: oscillators and seeded filtered noise only. No samples, recorded audio, source melody, downloaded assets or neural inference.',
        'license': 'Original script and generated composition offered under the repository MIT license.',
        'events': groove.events,
    }
    args.output.with_suffix('.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'events'}, indent=2))


if __name__ == '__main__':
    main()
