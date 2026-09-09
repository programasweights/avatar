# Motion trees

A motion is ordinary JSON. Open **Edit motion JSON** in the studio to import
[one-finger.json](examples/one-finger.json), or export the current sequence as a
starting point. The complete types are in [types.ts](src/motion/types.ts).

Groups compose recursively:

- `sequence`: play children in order.
- `parallel`: start children together; the longest child sets the duration.
- `repeat`: repeat the child sequence `count` times.

The visible motion tree links each selected branch to its joints on the avatar.
Its activity dots follow changing rotation/position values, including replacement
overlays. **Full tree** shows every authored node, including static poses and
camera tracks.

Pausing a joint adds a constant `blend: "replace"` rotation overlay at the sampled
pose. Original curves remain in the program. Restoring removes the overlay;
unrelated edits stay intact. Pause controls work on independent rotations and
are disabled where a contact solver or foot IK also controls the selection.
The curl slider scales a leaf's angle values while retaining its timing, phase,
interpolation and mirrored sign. See [editing.ts](src/motion/editing.ts).

A `curve` addresses one joint, axis and channel. Durations are seconds; rotations
are degrees; positions are metres. A curve can be constant, sinusoidal, or a
list of keyframes whose times run from 0 to 1. Keyframes support smooth, linear
and hold interpolation. Overlapping curves add by default; `blend: "replace"`
overrides the accumulated value on that channel.

Joint IDs describe anatomy, such as `left_index_1`, `left_elbow`, or `right_hip`.
The 52 supported IDs are in [rigDefinition.ts](src/motion/rigDefinition.ts).
Finger Z is curl, with positive angles on the left and negative on the right.
Larger joints use body axes. `root` moves the entire character;
`left_foot_ik` and `right_foot_ik` specify foot offsets for the leg solver.

A `contact` either brings a thumb tip to another fingertip or moves a procedural
coin between knuckles. Contact weights, transfer progress and visibility are
curves too. The solver recomputes each pose from its reference, so seeking and
exporting do not depend on playback history.

The hand sequence is built in [dexteritySequence.ts](src/motion/dexteritySequence.ts).
Its ripple, touches and coin motions are reusable tree builders. To add another
skill, build and validate a tree, expose its command in
[director.ts](src/motion/director.ts), then update and recompile the relevant
PAW specification if you want language to select it. Normal app use loads the
published functions listed in `programs.json`; it never recompiles them.
