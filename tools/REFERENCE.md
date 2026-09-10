# Fit a short video reference

## Included study

[gangnam-reference.json](../examples/gangnam-reference.json) reconstructs a 3.6-second
section (1:59.60–2:03.20) of [PSY teaching the dance in The Guardian](https://www.theguardian.com/music/video/2012/nov/18/how-to-dance-gangnam-style-psy-video).
It uses manually located joints, classical optical flow between those measurements,
camera stabilization, and approximate head/torso orientation. The blue-tux character
retains its stylized proportions. Knee height, foot pointing, and depth remain approximate.

[Watch the avatar reconstruction](https://programasweights.com/avatar/gangnam-reference.mp4).
To edit it, open the [studio](https://programasweights.com/avatar?example=gangnam),
expand **Edit motion**, open **Edit motion JSON**, paste the example, and press
**Apply program**. It is a separate imported study; the existing Gangnam example
retains its authored routine and support-foot variations.

Render the included study with the published framing:

```sh
npm run render -- --dance --input examples/gangnam-reference.json \
  --camera examples/gangnam-reference-camera.json --fps 25 --clean \
  --output exports/gangnam-reference.mp4
```

## Fit your measurements

This optional offline tool converts measured image landmarks into the same editable motion tree used by the studio. It does not run a pose model, call PAW, or replace the live dance. The output is a **review candidate**, not recovered motion capture.

```sh
node tools/retarget-reference.mjs \
  --input /path/to/reference.json \
  --stabilization /path/to/camera-stabilization.json \
  --orientation /path/to/orientation.json \
  --output /tmp/reference-motion.json
```

Only `--input` is required. The camera and orientation inputs are optional. Install the project's dependencies and Playwright Chromium first. The tool starts a temporary local Vite server and uses the shipped Three.js rig in a headless browser. No Blender process is needed for fitting.

## Input

Use a wrapper to retain provenance and image dimensions:

```json
{
  "width": 640,
  "height": 360,
  "fps": 25,
  "source": { "url": "https://example.com/reference", "start": 10, "end": 13.6 },
  "manualFrames": [
    {
      "time": 0,
      "points": {
        "nose": [320, 60],
        "left_shoulder": [350, 95],
        "right_shoulder": [290, 95]
      }
    }
  ]
}
```

The example is abbreviated: each frame requires both shoulders, elbows, wrists, hips, knees, and ankles. Use the performer's anatomical left/right. Coordinates are pixels from the image's top left. A nose point is optional but helps preserve above-head gestures across different body proportions. Supply at least two strictly increasing timestamps, and at most 30 seconds per fit. Timestamps determine the output's exact duration; the fitter does not force a dance loop or change the performance tempo.

A bare array of manual frames is also accepted, with default 640 × 360 at 25 fps. Override those defaults with `--width`, `--height`, and `--fps`. For already-extracted MediaPipe-style data, use `frames` instead of `manualFrames`; each frame needs `time`, a 33-element normalized `landmarks` array, and a 33-element `worldLandmarks` array. Missing or low-confidence required points are interpolated only when another reliable observation exists and are listed in the report.

Optional stabilization is `{ "frames": [{ "time": 0, "to_first": [[1,0,0],[0,1,0],[0,0,1]] }] }`. Each 3 × 3 matrix maps that frame's image points into the first frame's pixel coordinates. The tool interpolates adjacent matrices. Use background camera tracking, rather than the performer's motion, to estimate these transforms.

Optional orientation is an array:

```json
[{ "time": 0, "head": { "yaw": 0, "pitch": 0, "roll": 0 }, "torso": { "yaw": 0 } }]
```

Angles are degrees relative to a front-facing camera: positive yaw turns toward the performer's left (screen right), positive pitch lowers the chin, and positive roll tilts toward the left shoulder. These are explicit manual estimates. The head angle is compensated for torso rotation. Keep orientation timestamps in the same time coordinates as the landmark frames.

## Output and review

The output JSON is an ordinary `MotionProgram` with separate feet, balance, torso, arm, and finger branches. Its sibling `.report.json` records source provenance, scale, contact estimates, interpolated observations, fit residuals, optional manual orientation, and a proposed frontal orthographic comparison camera. Camera height/center correspond to the source aspect ratio; reframe for square output. Render the program with `node tools/render.mjs --dance --input /tmp/reference-motion.json --output /tmp/reference.mp4 --fps 25 --fixed-camera --clean` or import it into the studio.

Manual image points constrain projection only. This fitter uses actual avatar limb lengths, weak depth priors, per-foot ground envelopes, a measured hip trajectory, and closed authored finger poses. Depth, occlusion, camera perspective, body proportions, uncertain joints under clothing, and a large stylized head can all affect the result. Small numerical residuals measure agreement with those constructed targets, **not** accuracy to the performer's true 3D joints. Sparse keyframes may miss fast wrist circles and step beats. Review both the original video and the result at matching times before using a fitted program publicly. Support-foot edits require a separate timing-aware integration before a reference clip can replace a supported dance.

`--smooth-radius 0` preserves every measured point; the default radius 1 uses a small symmetric filter. `--max-frames` limits the number of fitted frames (default 240, maximum 250). `--ground-pixel-y` overrides both estimated foot baselines. `--floor-threshold` sets the contact tolerance in meters (default 0.025). `--prepare-only` validates and converts landmarks without solving joint rotations. Keep source footage and private annotations outside the public repository.
