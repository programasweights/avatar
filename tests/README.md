# Testing directions and motion

Run the deterministic engine, rendered-rig, editor and worker checks:

```sh
npm test
npm run test:director
npm run test:worker
```

The language suites use actual PAW inference and run sequentially:

```sh
.venv/bin/python tools/evaluate-launch.py --local \
  --cases tests/common-language-cases.json --output /tmp/common-language.json
```

`common-language-cases.json` covers walking, running, counted jumps, bows,
crouching, sitting, turns, kicks, short sequences, and common dance/greeting
phrases. Expected outputs require the requested action and repetition count.
The separate `action_boundary` category checks deliberate rejection; those
cases do not count as successful action support. The evaluator saves each
model decision, output, latency and failure.

`launch-language-cases.json`, `launch-language-heldout.json`,
`launch-language-joints.json` and `launch-language-editor.json` cover the hand
showcase, joint angles, relative controls, preservation and unsupported requests.
Some editor cases check only that a direction does not freeze or restore a joint;
they are routing checks, not proof that the requested action is implemented.

Language checks alone cannot establish visual correctness. The browser and
motion tests sample the bundled character's actual bones, feet, contacts and
timelines. They check takeoffs and landings, count repetitions, distinguish
walking from running, verify bows and seated poses, and retain the four exact
showcase directions. UI checks ensure body actions replace the previous scene,
use a full-body camera, and finish counted sequences without looping.

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

These opt-in tests submit real requests to the hosted demo:

```sh
AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com \
  npx playwright test tests/tweet.spec.ts tests/public.spec.ts --workers=1
```

They verify the exact showcase phrases and the resulting rendered motion,
including the full sequence created by **Load hand demo through PAW**.
