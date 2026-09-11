# Avatar

Direct a 3D character with words. Edit the motion down to individual finger joints.

[Try the demo](https://programasweights.com/avatar) · [Watch the sequence](https://programasweights.com/avatar/showcase.mp4)

[![Finger ripple, fingertip touches and a coin rolling across the avatar’s knuckles](public/demo.gif)](https://programasweights.com/avatar)

> “Make a wave from pinky to thumb on your left hand.”\
> “Reverse the finger ripple on your left hand.”\
> “Touch your left thumb to each fingertip, index first.”\
> “Roll a coin across your left knuckles.”

The studio includes a complete hand sequence, dance studies, 52 articulated
joints, editable motion trees and video export. Small [PAW](https://programasweights.com)
functions turn language into validated commands; the motion engine animates the character.

[Try Gangnam Style](https://programasweights.com/gangnam) with the
blue-tux character. Apply “Dance Gangnam Style.”, then “Now on one foot.” and
“Switch to the opposite foot.” The foot changes preserve the upper-body
choreography and joint edits. The dance is an authored 16-beat motion tree with
separate footwork, balance, torso, arm and finger branches. It is a stylized
recreation, with an original Blender costume and face on the same articulated rig.
[Watch both foot edits](https://programasweights.com/avatar/gangnam-director.mp4?v=b20a7662).

## Run

Requires Node.js 22.12 or newer.

```sh
git clone https://github.com/programasweights/avatar.git
cd avatar
npm ci
npm run dev
```

Open the local URL printed by Vite. The hand sequence runs immediately as an
editable example, matching the showcase video.
The bundled character, examples, joint controls and JSON editor work without
Python or model downloads.

## Direct with words

For language input, install Python 3.10 or newer and the local PAW runtime:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev
```

On Windows, use `.venv\Scripts\python.exe` instead of `.venv/bin/python`.
The app discovers `.venv` automatically; `AVATAR_PYTHON` can select another
Python executable.

The first direction downloads the pretrained models. Subsequent inference runs
locally, with models retained in one worker and requests processed sequentially.
No API key or recompilation is required. The example buttons play authored
motions; **Apply direction** interprets your text with PAW and edits the motion
currently on screen. **Start over** clears the choreography, props and joint
edits and returns the character to a neutral pose.

**Play**, **Replay current motion** and **Record current motion** all use that
same creation. To reload the original example, open **More motions → Load hand
demo**. New directions resume playback; Replay starts the current motion from
the beginning without replacing it.

To reproduce the showcase through language, open **More motions → Recreate
demo from prompts**. It sends the four quoted directions sequentially and uses
their validated outputs to build the same timed sequence. You can also press
**Start over** and apply each phrase yourself; each direction runs its gesture
until you give the next one.

Follow up with “Use the other hand,” “Reverse it,” or “Make it twice as fast.”
You can name the current motion: “Make the coin roll faster.”
These edit the actual motion tree, including the default hand sequence. Hand
changes retain compatible joint edits and footwork; reversal plays the whole
creation backwards. Speed changes multiply the current tempo within 30–240 BPM.
The **Hand** and **Reverse** controls under **More motions** perform the same
edits. An ambiguous hand or incompatible imported tree produces a clear error
and leaves your creation intact.

Try **Finger ripple**, select **Ring finger** in the motion tree, and press
**Pause finger**. Its three joints stay fixed while the other fingers continue.
**Restore motion** brings it back. Expand a finger to select one joint and
change its curl with the slider; **Undo** restores the previous edit.

[Watch the joint-control recording](https://programasweights.com/avatar/joint-control.mp4).

You can also type “Keep the wave going. Stop just the ring finger,” then
“Restore the ring finger.” “Freeze your left arm” holds the shoulder, elbow,
wrist and collarbone together; “Unfreeze both arms” restores their movement.
An omitted side uses the active hand. “This joint”
uses the current tree selection. “Stop leg movements” pauses both legs while
the arms keep moving; “Resume the footwork” restores them. Whole-leg pauses
also hold the foot targets and shared body position. Individual joint pauses
hold local rotations; contact choreography remains controlled by its trajectories.

“Fully lift up your left arm” straightens that arm and reaches overhead.
An explicit angle, such as “Lift your left arm 45 degrees,” keeps precise joint control.

Try “Roll a coin,” “Could you move just your left thumb?”, or “Wave hello with
your left hand.” Unsupported tricks, such as rolling a coin on the head, are
declined rather than approximated with unrelated joint movements. Language
interpretation can still make mistakes; **Start over** begins a fresh scene.

Try “Run,” “Jump twice, then take a bow,” “Sit down,” or “Kick with your left
leg.” Whole-body actions start a new scene and switch to the full-body view.
“Turn around 180 degrees” makes a whole-body half turn. “Lift left leg” or
“Balance on one foot” adds a balanced pose to the current avatar scene. “Switch
to the opposite foot” changes sides; “Both feet again” restores its footwork.
During Gangnam, these same commands keep the dance going while changing its
supporting foot. Walking and running happen in place. A single walk or run loops; counted actions and sequences play once and stop.
“Kneel down” rests on both knees, “Lie down” reclines onto the floor, and
“Side kick with your left leg” kicks sideways. Sitting, kneeling and lying down
hold their final poses.
These motions use editable joint curves and foot targets, just like the hand
sequence. Short action sequences support up to four steps and sixteen total
repetitions, with one to eight repetitions per step.

Add constraints such as “Kick without moving arms” or “Jump on your left foot
twice, then hop on your right foot.” Still arms remove arm swing while following
the torso. A support-foot parameter keeps the opposite foot tucked between hops.
Bilateral hand grasps and finger snaps are not implemented; those require
additional reach and contact choreography.

Edit either arm while the rest keeps moving: “Keep Gangnam footwork but make
the arms robotic,” “Lower both arms,” or “Relax only the left arm.” A new arm
direction replaces that arm’s earlier pose or freeze and keeps the other parts.

Put different motions in one direction: “Wave your right hand, then bow,” or
“First raise your left arm, then raise your right arm.” The planner interprets
each step and builds one editable timeline with a caption for each phase.
“Dance Gangnam for three seconds, then dance salsa for three seconds” sets
explicit timing. “Dance Gangnam, then go on one foot, then switch to the opposite
foot” keeps the dance running through the foot edits. Ordered plans support
two to four steps; explicit step durations are 1–12 seconds, with 48 seconds
for the complete plan. They play once. An unsupported step leaves the current
creation intact.

“Stop” or “Pause” holds the current pose. “Resume” or “Resume dancing” continues the animation;
“Replay” plays it from the beginning. These keep your motion and edits.
To pause only one part, name it: “Stop just the ring finger.”

**More motions** contains the other studies and hand selection. **Edit motion**
contains detailed curves, joint axes, skeleton inspection and JSON import/export.
**Full tree** reveals the pose and camera branches folded out of the compact view.

Use **Recording view** for a large stage, or record while editing in the normal
view. The video includes the current instruction, selected branch and angle or
pause state. Recording starts from the current playhead and downloads a square
video in a format supported by your browser.

## Render an MP4

Install FFmpeg and Playwright’s Chromium once:

```sh
npx playwright install chromium
npm run render
```

This writes `exports/showcase.mp4`: the full hand sequence at 1080 × 1080,
24 fps. Rendering starts its own local server and does not require PAW.
Set `FFMPEG` if the executable is not on your PATH.

To render an exported motion:

```sh
npm run render -- --input motion.json --output exports/my-motion.mp4
```

Use `--side right` for the default right-hand showcase, or `--preview` to
inspect still frames before encoding a video.

Render the full-body Gangnam study, including its camera orbit:

```sh
npm run render -- --dance --output exports/gangnam.mp4
```

These exports use the same character and curves as the studio.
Use `--variation one-foot` to render just that variation, or `--input motion.json`
with `--dance` for your own full-body motion on the blue-tux character.

The eight-second director clip starts dancing, changes to one foot at 1.82 seconds,
and switches support at 4.55 seconds. Its arm choreography and beat stay continuous.
To reproduce it, record the three directions through the public form, then render
the returned motion programs with their actual input and Apply frames:

```sh
node tools/record-gangnam-inputs.mjs --out exports/gangnam-inputs
npm run render -- --dance --variation sequence \
  --interaction exports/gangnam-inputs/manifest.json \
  --fps 60 --duration 8.05 --fixed-camera \
  --output exports/gangnam-director.mp4
```

The recording calls the hosted language interface sequentially. The export
condenses typing and retimes response waits.
For the optional original percussion track, install NumPy and run
`python3 tools/make-gangnam-beat.py --output exports/gangnam-beat.wav`, then add
`--audio exports/gangnam-beat.wav` to the render command. No music samples are used;
the interactions are also readable with sound off.

For reference comparisons, `--fps 25 --fixed-camera --clean` renders the full-body
motion at 25 fps with a stationary frontal camera and no captions. The optional
[reference fitting tool](tools/REFERENCE.md) converts timestamped joint
measurements into the same editable motion-tree format.

## How it works

- `director.py`, `programs.json`, `specs/`: small pretrained language functions
  and strict command validation.
- `src/motion/`: `sequence`, `parallel` and `repeat` trees containing continuous
  curves and contacts; choreography builders, joint control and contact solvers.
- `src/App.tsx`: the studio, timeline and tree editor.

A new skill is an ordinary motion-tree builder. Add its command to the director
and extend the relevant PAW specification when it needs language support.
The language vocabulary covers the supplied skills and joint edits; new complex
actions need choreography. Contacts and coin motion are kinematic, not a physics
simulation.

See [MOTION.md](MOTION.md) for the tree format and a minimal finger example.

Run `npm test` for browser and motion regressions, `npm run test:director` and
`npm run test:worker` for language/worker checks, and `npm run build` for a production build.
For programasweights.com, use `npm run build:website`; it sets the `/avatar/`
asset path and the hosted `/api/v1/avatar/direct` endpoint for both demo URLs.
These tests use mocked neural outputs; `AVATAR_LIVE_PAW=1 npm test` also runs
the opt-in local inference checks.
For a broader language check, run this against your running app (adjust the
port to match Vite):

```sh
python3 tools/evaluate-launch.py --url http://127.0.0.1:5173/api/direct --output /tmp/avatar-language-results.json
```

This opt-in suite processes real requests sequentially and saves the model traces. It checks
ordinary directions, follow-up edits, and honest rejection of unsupported
tricks; the rig tests separately verify the resulting joint and prop motion.
Add `--cases tests/posture-language-cases.json` to check body poses, overhead
reaches, side kicks, and leg pauses.

The built `dist/` can serve the examples and editor as a static site. Language
input also needs a backend at `/api/direct`; `npm run dev` and `npm run preview`
provide the included local Python bridge. A hosted site can connect that route
to its own PAW inference provider.

## Character and license

Code: [MIT](LICENSE). Bundled character: Quaternius, [CC0](ASSETS.md), styled as a
matte jade mannequin. The character ships with the app; Blender is optional.
[ASSETS.md](ASSETS.md) explains how to rebuild it or import your own Mixamo Y Bot
for local use with `?character=mixamo`.
