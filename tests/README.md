# Testing directions and motion

Run the deterministic engine, rendered-rig, editor and worker checks:

```sh
npm test
npm run test:director
npm run test:worker
```

The language suites use actual PAW inference and run sequentially:

```sh
.venv/bin/python tools/evaluate-launch.py --infer-url https://programasweights.com/api/v1/infer \
  --cases tests/common-language-cases.json --output /tmp/common-language.json
```

`common-language-cases.json` covers walking, running, counted jumps, bows,
crouching, sitting, turns, kicks, short sequences, and common dance/greeting
phrases. Expected outputs require the requested action and repetition count.
The separate `action_boundary` category checks deliberate rejection; those
cases do not count as successful action support. The evaluator saves each
model decision, output, latency and failure.
It records a validator's rejection separately from a model returning
`unsupported`, and keeps raw hosted outputs when validation fails.

`launch-language-cases.json`, `launch-language-heldout.json`,
`launch-language-joints.json` and `launch-language-editor.json` cover the hand
showcase, joint angles, relative controls, preservation and unsupported requests.
Some editor cases check only that a direction does not freeze or restore a joint;
they are routing checks, not proof that the requested action is implemented.

`playback-language-cases.json` checks global stop/pause, resume/play/continue,
and replay/restart directions through the complete director. Stop holds the
current pose; resume continues from that point; restart plays the current motion
from the beginning. The suite also verifies that named-joint edits, bare
**Freeze**/**Restore**, explicit **Stop dancing**, new motions, and unsupported
requests keep their existing meanings. Bare **Resume** controls playback;
**Resume the ring finger** restores that finger's motion. Its preservation cases
require exact final commands, rather than merely excluding a mistaken route.

```sh
.venv/bin/python tools/evaluate-launch.py --infer-url https://programasweights.com/api/v1/infer \
  --cases tests/playback-language-cases.json --output /tmp/playback-language.json
```

`parameter-language-cases.json` checks support-foot selection, counted one-foot
hops, still-arm constraints, and combinations across short action sequences.
Conflicting or unsupported constraints must abstain rather than disappear.

```sh
.venv/bin/python tools/evaluate-launch.py --infer-url https://programasweights.com/api/v1/infer \
  --cases tests/parameter-language-cases.json --output /tmp/parameter-language.json
```

Language checks alone cannot establish visual correctness. The browser and
motion tests sample the bundled character's actual bones, feet, contacts and
timelines. They check takeoffs and landings, count repetitions, distinguish
walking from running, verify bows and seated poses, and retain the four exact
showcase directions. UI checks ensure body actions replace the previous scene,
use a full-body camera, and finish counted sequences without looping.
`bodyActionParameters.spec.ts` checks the actual rig's support foot, raised free
foot between consecutive hops, and preserved leg motion when arms are held still.
`loading.spec.ts` interrupts character downloads and checks automatic recovery,
a contained retry state, and preservation of the user's typed direction.

## Where the common requests came from

The old demo put directions in its `?do=` URL. Retained same-origin referrers on
`POST /api/v1/avatar/act` requests from August 26 through September 6, 2026 contained
763 requests and 235 distinct directions. Removing the eight exact built-in
example prompts left 345 requests and 227 distinct directions. The largest broad
families were dance, jumping/flips/inversions, greetings/head/body gestures,
walking/running/turning, and posture/balance/exercise. Short action combinations
appeared in 51 custom requests.

These are observations from retained referrer logs, not verified request bodies,
unique people, or success labels. Replays and shared links can duplicate them;
URL updates can lag a request. Known recent development traffic was excluded,
but other development traffic may remain. Raw logs and visitor identifiers are
not published. The benchmark uses generic motion phrases and marks observed
directions separately from authored variations and user-reported regressions.

This suite targets common reproducible interactions. It does not claim coverage
of every dance style, acrobatic request, facial expression, prop interaction,
or arbitrary simultaneous action found in the long tail of visitor inputs.

## Live release checks

`arm-sequence-language-cases.json` covers complete and one-sided arm styles,
lowering, background-dance preservation, ordered joint/body/dance/hand steps,
explicit timing, unsupported steps, and the original showcase directions.
Ordered expectations compare each command block, mode and duration, so keeping
only the last action cannot pass. Run its real language checks sequentially:

```sh
.venv/bin/python tools/evaluate-launch.py --infer-url https://programasweights.com/api/v1/infer \
  --cases tests/arm-sequence-language-cases.json --output /tmp/arm-sequence-language.json
```

These opt-in tests submit real requests to the hosted demo:

```sh
AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com \
  npx playwright test tests/tweet.spec.ts tests/public.spec.ts tests/public-controls.spec.ts tests/public-gangnam.spec.ts --workers=1
```

They verify the exact showcase phrases and the resulting rendered motion,
including the full sequence created by **Recreate demo from prompts**.
The control test follows real hosted results through stop/resume, still-arm
kicks and running, and counted hops on each support foot.

The Gangnam test starts over with the jade character, types the five showcase
directions sequentially, and verifies the loaded blue tuxedo, actual foot
positions, preserved upper-body branches and tempo, and the final paused pose.
It saves the real API responses, bone samples, screenshots and a browser video.
It uses no inference mocks. Run it by itself after deployment when a focused
release check is sufficient:

```sh
AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com \
  npx playwright test tests/public-gangnam.spec.ts --workers=1
```

Arm and ordered-motion checks verify the real public interface, limb poses,
continuous dance timing, phase captions, and rejection without partial changes:

```sh
AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com \
  npx playwright test tests/public-arm-sequences.spec.ts --workers=1
```

Generic-avatar support checks start on `/avatar`, including its hand showcase, a
fresh neutral scene, and salsa. They verify leg lifts, switching feet, restoring
footwork, and independent finger edits while retaining the character and props:

```sh
AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com \
  npx playwright test tests/public-generic-support.spec.ts --workers=1
```

`genericSupport.spec.ts` checks the support constraints against both bundled
rigs. `genericSupportUI.spec.ts` uses fixed command responses to cover the same
scene transitions without inference.

## Paired language requests and body gestures

`chinese-motion-language-cases.json` checks ordinary arm raises, raised versus
supporting feet, literal joint angles, counts 1–8, ordered and mixed-language
steps, playback, and still-arm constraints. Its boundary cases require rejection
of negated actions, informational questions, and unsupported counts or props.
The remote `request_intent` program checks the original wording first.
`language_scope` then identifies requests that need literal English translation.
English and translated requests both pass through `meaning_scope`. It preserves
ordinary directions exactly and sends anatomical or default-action wording to
`motion_language` only when clarification is needed. Both paths then use the
same motion specialists. Translation and motion interpretation have separate
specifications.
`translated-motion-language-cases.json` pairs each Chinese request with natural
English wording and identical expectations; hand and foot wording stays intact
in those translations. Each case requires an exact final command or every step
of its sequence.

`recent-motion-language-cases.json` adds paired visitor requests for putting a
foot down, raising both hands, clapping, punching, and common body actions.
Handshake, head-touch, splits, and backbend cases remain marked `decline_only`:
rejecting them does not count as successfully performing those motions.

```sh
.venv/bin/python tools/evaluate-launch.py --infer-url https://programasweights.com/api/v1/infer \
  --cases tests/chinese-motion-language-cases.json --output /tmp/chinese-motion-language.json
.venv/bin/python tools/evaluate-launch.py --infer-url https://programasweights.com/api/v1/infer \
  --cases tests/translated-motion-language-cases.json --output /tmp/translated-motion-language.json
.venv/bin/python tools/evaluate-launch.py --infer-url https://programasweights.com/api/v1/infer \
  --cases tests/recent-motion-language-cases.json --output /tmp/recent-motion-language.json
```

Run the corresponding real public inputs sequentially after deployment:

```sh
AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com \
  npx playwright test tests/public-chinese-motion.spec.ts --workers=1
```

The public checks cover both `/avatar` and `/gangnam`, measuring the raised foot,
arm angle, continuing footwork during a wave, jump count, forward bow, sway,
foot lowering, palm contact, and forward fist extension. They record API responses
and rendered poses. The rig tests check both characters' planted feet, lateral
weight transfer, complete repeat cycles, clap contacts, closed fists, and
composition with other actions without inference:

```sh
npx playwright test tests/bodySway.spec.ts tests/gestureBodyActions.spec.ts tests/genericSupport.spec.ts --workers=1
```
