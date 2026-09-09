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
“Restore the ring finger.” An omitted side uses the active hand. “This joint”
uses the current tree selection. Pauses hold local joint rotations; contact
choreography and leg IK need their own trajectory controls.

Try “Roll a coin,” “Could you move just your left thumb?”, or “Wave hello with
your left hand.” Unsupported tricks, such as rolling a coin on the head, are
declined rather than approximated with unrelated joint movements. Language
interpretation can still make mistakes; **Start over** begins a fresh scene.

Try “Run,” “Jump twice, then take a bow,” “Sit down,” or “Kick with your left
leg.” Whole-body actions start a new scene and switch to the full-body view.
Walking and running happen in place. A single walk or run loops; counted
actions and sequences play once and stop. Sitting holds a floor-seated pose.
These motions use editable joint curves and foot targets, just like the hand
sequence. Short action sequences support up to four steps and sixteen total
repetitions, with one to eight repetitions per step.

Add constraints such as “Kick without moving arms” or “Jump on your left foot
twice, then hop on your right foot.” Still arms remove arm swing while following
the torso. A support-foot parameter keeps the opposite foot tucked between hops.
Bilateral hand grasps and finger snaps are not implemented; those require
additional reach and contact choreography.

“Stop” or “Pause” holds the current pose. “Resume” continues the animation;
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

The built `dist/` can serve the examples and editor as a static site. Language
input also needs a backend at `/api/direct`; `npm run dev` and `npm run preview`
provide the included local Python bridge. A hosted site can connect that route
to its own PAW inference provider.

## Character and license

Code: [MIT](LICENSE). Bundled character: Quaternius, [CC0](ASSETS.md), styled as a
matte jade mannequin. The character ships with the app; Blender is optional.
[ASSETS.md](ASSETS.md) explains how to rebuild it or import your own Mixamo Y Bot
for local use with `?character=mixamo`.
