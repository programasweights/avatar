"""Words → validated motion commands, using small, local PAW functions."""
from __future__ import annotations

import json
import re
import unicodedata
from functools import cache
from pathlib import Path
from typing import Callable

PROGRAMS = json.loads((Path(__file__).parent / "programs.json").read_text())
Infer = Callable[[str, str], str]


class _InferenceResponseError(ValueError):
    """Provider failures must not be mistaken for invalid motion commands."""


SIDES = ("left", "right")
FINGERS = ("thumb", "index", "middle", "ring", "pinky")
PARTS = ("clavicle", "shoulder", "elbow", "wrist", "hip", "knee", "ankle", "toes")
JOINTS = (
    {"hips", "spine", "spine_mid", "chest", "neck", "head"}
    | {f"{side}_{part}" for side in SIDES for part in PARTS}
    | {f"{side}_{finger}_{i}" for side in SIDES for finger in FINGERS for i in (1, 2, 3)}
)
JOINT_ALIASES = {joint.removesuffix("_1"): joint for joint in JOINTS if joint.endswith("_1")}
JOINT_ALIASES.update({
    f"{side}_mid{suffix}": f"{side}_middle{suffix or '_1'}"
    for side in SIDES for suffix in ("", "_1", "_2", "_3")
})
EDIT_ALIASES = {"arms": "both_arms", "both_arm": "both_arms", "legs": "both_legs", "both_leg": "both_legs"}
EDIT_ALIASES.update({f"{prefix}foot": f"{prefix}ankle" for prefix in ("", "left_", "right_", "both_")})
DEXTERITY_SKILLS = {"finger_ripple", "finger_touches", "arm_wave", "coin_roll"}
BODY_ACTIONS = {"walk", "run", "jump", "bow", "crouch", "sit", "kneel", "lie_down", "sway", "clap", "punch_left", "punch_right", "turn_left", "turn_right", "spin", "kick_left", "kick_right", "side_kick_left", "side_kick_right", "walk_wave", "run_wave"}
EDIT_PARTS = {"arm", "leg"} | set(PARTS) | set(FINGERS) | {f"{finger}_{segment}" for finger in FINGERS for segment in (1, 2, 3)}
EDIT_TARGETS = {"selected", "both_arms", "both_legs", "hips", "spine", "spine_mid", "chest", "neck", "head"} | EDIT_PARTS | {
    f"{side}_{part}" for side in ("left", "right", "both") for part in EDIT_PARTS
}


@cache
def _load_function(program_id: str):
    """Download once, then retain each function in the persistent worker."""
    try:
        import programasweights as paw
    except ImportError as exc:
        raise RuntimeError(
            "Local PAW is not installed. Run: python3 -m venv .venv && "
            ".venv/bin/python -m pip install -r requirements.txt"
        ) from exc
    return paw.function(program_id)


def local_infer(program_id: str, instruction: str) -> str:
    output = _load_function(program_id)(instruction, temperature=0,
                                        max_tokens=256 if program_id in {PROGRAMS.get("sequence"), PROGRAMS.get("motion_language"), PROGRAMS.get("motion_translation")} else 80)
    if not isinstance(output, str):
        raise ValueError("PAW returned a non-text response")
    return output


def transform_command(joint: str, raw: str) -> str:
    """Map anatomical directions to the rig's local axes and side signs."""
    joint = JOINT_ALIASES.get(joint, joint)
    if joint not in JOINTS:
        raise ValueError(f"Unsupported joint selection: {joint}")
    parts = raw.split()
    if (len(parts) != 3 or parts[0] not in {"hold", "wave"}
            or not re.fullmatch(r"-?\d+(\.\d+)?", parts[2])):
        raise ValueError("Invalid joint transform")
    mode, operation, numeric = parts
    # Raising the knee elevates it at the hip; bending still rotates the knee.
    if operation == "raise" and joint.endswith("_knee"):
        joint = joint.removesuffix("_knee") + "_hip"
    angle = float(numeric)
    if abs(angle) > 180:
        raise ValueError("Joint angle exceeds 180 degrees")
    side_sign = 1 if joint.startswith("left") else -1
    if operation == "overhead":
        if mode != "hold" or not joint.endswith("_shoulder") or angle != 180:
            raise ValueError("An overhead reach requires a shoulder held at 180 degrees")
        side = joint.split("_", 1)[0]
        return f"arm {side} still\njoint {joint} z {180 * side_sign}"
    if operation in {"x", "y", "z"}:
        axis = operation
    elif operation in {"left", "right"}:
        axis = "y"
        angle = abs(angle) * (1 if operation == "left" else -1)
    elif operation == "raise":
        if joint.endswith("_hip"):
            axis, angle = "x", -abs(angle)
        elif joint.endswith(("_shoulder", "_clavicle")):
            axis, angle = "z", abs(angle) * side_sign
        else:
            raise ValueError("Raise requires an arm, collarbone, or hip joint")
    elif operation in {"outward", "inward"}:
        if not joint.endswith(("_hip", "_shoulder", "_clavicle")):
            raise ValueError("Sideways limb movement requires a hip or arm joint")
        axis, angle = "z", abs(angle) * side_sign
        if operation == "inward":
            angle = -angle
    elif operation in {"up", "down"}:
        if joint not in {"head", "neck"} and not joint.endswith(("_ankle", "_toes")):
            raise ValueError("Up/down pitch requires a head, neck, ankle, or toe joint")
        axis, angle = "x", abs(angle) * (-1 if operation == "up" else 1)
    elif operation in {"bend", "forward", "backward"}:
        if re.search(r"_(thumb|index|middle|ring|pinky)_", joint):
            axis, angle = "z", abs(angle) * side_sign
        else:
            axis = "x"
            angle = abs(angle) * (-1 if joint.endswith(("_elbow", "_shoulder", "_hip")) else 1)
        if operation == "backward":
            angle = -angle
    else:
        raise ValueError(f"Unknown transform: {operation}")
    command = "wiggle" if mode == "wave" else "joint"
    return f"{command} {joint} {axis} {angle:g}"


def joint_commands(selection: str, transform: str) -> str:
    targets = ([f"{side}_{selection[5:]}" for side in SIDES]
               if selection.startswith("both_") else [selection])
    return "\n".join(transform_command(target, transform) for target in targets)


def validate_body(raw: str) -> str:
    # The bare dance command selects the default salsa study. This normalizes
    # model output only; user wording is interpreted by PAW.
    lines = ["dance salsa" if line == "dance" else line for line in raw.strip().splitlines()]
    if not lines or len(lines) > 6:
        raise ValueError("Empty or oversized body command program")
    for line in lines:
        if re.fullmatch(r"dance (salsa|cha_cha|robot|idle)|arms (natural|robot|wave|still)", line):
            continue
        match = re.fullmatch(r"tempo (\d+)", line)
        if match and 30 <= int(match[1]) <= 240:
            continue
        raise ValueError(f"Unsupported motion command: {line}")
    return "\n".join(lines)


def validate_dexterity(raw: str) -> str:
    parts = raw.split()
    if (len(parts) != 4 or parts[0] != "skill" or parts[1] not in DEXTERITY_SKILLS
            or parts[2] not in SIDES or parts[3] not in {"forward", "reverse"}
            or "\n" in raw or "\r" in raw):
        raise ValueError("Invalid dexterity skill command")
    return " ".join(parts)


def validate_dance_extension(raw: str) -> str:
    """Keep a dance start distinct from a support edit of the current tree."""
    lines = raw.splitlines()
    if not lines or len(lines) > 3:
        raise ValueError("Invalid dance extension command")
    start = lines[0] == "dance gangnam"
    remaining = lines[1:] if start else lines
    if remaining and re.fullmatch(r"support (left|right|both|other)", remaining[0]):
        if start and remaining[0] == "support other":
            raise ValueError("A new dance needs an explicit support foot")
        remaining = remaining[1:]
    elif not start:
        raise ValueError("A dance edit needs a support-foot command")
    if remaining:
        match = re.fullmatch(r"tempo (\d+)", remaining[0])
        if len(remaining) != 1 or not match or not 30 <= int(match[1]) <= 240:
            raise ValueError("Invalid dance extension modifier")
    return "\n".join(lines)


def validate_edit(raw: str) -> str:
    if raw == "none":
        return raw
    parts = raw.split()
    if (len(parts) != 2 or parts[0] not in {"freeze", "restore"}
            or "\n" in raw or "\r" in raw):
        raise ValueError("Invalid motion edit command")
    parts[1] = EDIT_ALIASES.get(parts[1], parts[1])
    if parts[1] not in EDIT_TARGETS:
        raise ValueError("Invalid motion edit command")
    return " ".join(parts)


def validate_follow_up(raw: str) -> str:
    """Validate commands whose meaning is resolved against the current motion."""
    if raw in {"reverse current", "hand left", "hand right", "hand other", "wave left", "wave right"}:
        return raw
    match = re.fullmatch(r"tempo_scale (\d+(?:\.\d+)?)", raw)
    if match and 0.25 <= float(match[1]) <= 4:
        return f"tempo_scale {float(match[1]):g}"
    raise ValueError("Invalid motion route or current-motion control")


def validate_actions(raw: str) -> str:
    """Bound a sequential whole-body program before creating joint curves."""
    lines = raw.splitlines()
    still_arms = lines.count("arms still")
    if still_arms > 1:
        raise ValueError("An action program may specify arms still only once")
    steps = [line for line in lines if line != "arms still"]
    if not 1 <= len(steps) <= 4:
        raise ValueError("An action sequence needs 1–4 steps")
    total = 0
    for line in steps:
        parts = line.split(" ")
        if (len(parts) not in {3, 4} or parts[0] != "action" or parts[1] not in BODY_ACTIONS
                or not re.fullmatch(r"[1-8]", parts[2])):
            raise ValueError("Invalid whole-body action command")
        if len(parts) == 4 and (parts[1] != "jump" or parts[3] not in {"both", "left", "right"}):
            raise ValueError("A support-foot parameter requires a jump and a valid side")
        if still_arms and parts[1] in {"walk_wave", "run_wave"}:
            raise ValueError("A waving gait cannot keep both arms still")
        total += int(parts[2])
    if total > 16:
        raise ValueError("An action sequence is limited to 16 repetitions")
    return "\n".join([*steps, *(["arms still"] if still_arms else [])])


def validate_arm_control(raw: str) -> str:
    """An arm style is either bilateral or explicitly limited to one side."""
    if not re.fullmatch(r"(?:arms|arm (?:left|right)) (?:natural|robot|wave|still)", raw):
        raise ValueError("Invalid arm control command")
    return raw


def validate_sequence(raw: str) -> list[dict]:
    """Parse the bounded splitter format before interpreting any clause."""
    lines = raw.splitlines()
    if not lines or lines[0] != "sequence" or not 3 <= len(lines) <= 5:
        raise ValueError("A motion sequence needs 2–4 complete steps")
    steps = []
    total = 0.0
    for line in lines[1:]:
        fields = line.split("|")
        if len(fields) != 3:
            raise ValueError("Each sequence step needs mode, duration, and instruction")
        mode, duration, clause = fields
        if mode not in {"perform", "continue"}:
            raise ValueError("Invalid sequence step mode")
        if not clause.strip() or len(clause) > 400 or not clause.isprintable():
            raise ValueError("Each sequence instruction needs 1–400 printable characters")
        step = {"instruction": clause.strip(), "mode": mode}
        if duration != "auto":
            if not re.fullmatch(r"\d+(?:\.\d+)?", duration) or not 1 <= float(duration) <= 12:
                raise ValueError("Each sequence duration must be auto or 1–12 seconds")
            step["seconds"] = float(duration)
            total += step["seconds"]
        steps.append(step)
    if total > 48:
        raise ValueError("Explicit sequence durations cannot exceed 48 seconds")
    return steps


def direct(instruction: str, infer: Infer | None = None) -> dict:
    """Interpret an atomic direction or a fully validated ordered motion plan."""
    if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 400:
        raise ValueError("Provide a direction of 1–400 characters.")
    provider = infer or local_infer

    def checked_infer(program_id: str, text: str) -> str:
        try:
            output = provider(program_id, text)
        except ValueError as exc:
            raise _InferenceResponseError(str(exc)) from exc
        if not isinstance(output, str):
            raise _InferenceResponseError("PAW returned a non-text response")
        return output

    infer = checked_infer
    # Classify the original wording before any translation can lose its intent.
    request_intent = infer(PROGRAMS["request_intent"], instruction).strip()
    normalization_trace = {"request_intent": request_intent}
    if request_intent == "other":
        return {"output": "unsupported", "trace": {**normalization_trace, "route": "unsupported"}}
    if request_intent != "command":
        return {"output": "unsupported", "trace": {
            **normalization_trace, "route": "unsupported",
            "validation_error": "Invalid motion request intent",
        }}
    language_scope = infer(PROGRAMS["language_scope"], instruction).strip()
    normalization_trace["language_scope"] = language_scope
    if language_scope not in {"english", "translate"}:
        return {"output": "unsupported", "trace": {
            **normalization_trace, "route": "unsupported",
            "validation_error": "Invalid motion language scope",
        }}

    def valid_english(text: str) -> bool:
        return (bool(text) and len(text) <= 400 and text.isprintable()
                and bool(re.search(r"[A-Za-z]", text))
                and all(not char.isalpha() or unicodedata.name(char, "").startswith("LATIN ")
                        for char in text))

    english_instruction = instruction
    if language_scope == "translate":
        english_instruction = infer(PROGRAMS["motion_translation"], instruction).strip()
        normalization_trace["motion_translation"] = english_instruction
        if english_instruction == "unsupported":
            return {"output": "unsupported", "trace": {**normalization_trace, "route": "unsupported"}}
        if english_instruction == "unchanged" or not valid_english(english_instruction):
            return {"output": "unsupported", "trace": {
                **normalization_trace, "route": "unsupported",
                "validation_error": "Motion translation requires 1–400 printable English characters",
            }}
    # Decide whether anatomical clarification is needed before asking the
    # specialized generator. Unrelated directions preserve their exact text.
    meaning_scope = infer(PROGRAMS["meaning_scope"], english_instruction).strip()
    normalization_trace["meaning_scope"] = meaning_scope
    if meaning_scope not in {"keep", "clarify"}:
        return {"output": "unsupported", "trace": {
            **normalization_trace, "route": "unsupported",
            "validation_error": "Invalid motion meaning scope",
        }}
    normalized = english_instruction
    if meaning_scope == "clarify":
        raw_normalization = infer(PROGRAMS["motion_language"], english_instruction).strip()
        normalized = english_instruction if raw_normalization == "unchanged" else raw_normalization
        normalization_trace["motion_language"] = raw_normalization
    normalization_trace["normalized_instruction"] = normalized
    if meaning_scope == "clarify" and raw_normalization == "unsupported":
        return {"output": "unsupported", "trace": {**normalization_trace, "route": "unsupported"}}
    if not valid_english(normalized):
        return {"output": "unsupported", "trace": {
            **normalization_trace, "route": "unsupported",
            "validation_error": "Motion interpretation requires 1–400 printable English characters",
        }}
    instruction = normalized
    raw = infer(PROGRAMS["sequence"], instruction)
    if not isinstance(raw, str):
        raise ValueError("PAW returned a non-text response")
    raw = raw.strip()
    if raw == "single":
        atomic_trace = {}
        try:
            result = _direct_atomic(instruction, infer, trace=atomic_trace)
        except _InferenceResponseError:
            raise
        except ValueError as exc:
            return {"output": "unsupported", "trace": {
                **normalization_trace, "sequence": raw, **atomic_trace,
                "route": "unsupported", "validation_error": str(exc),
            }}
        return {**result, "trace": {**normalization_trace, "sequence": raw, **result["trace"]}}
    trace = {**normalization_trace, "sequence": raw, "route": "sequence", "steps": []}

    def reject(reason: str) -> dict:
        trace.update(route="unsupported", validation_error=reason)
        return {"output": "unsupported", "trace": trace}

    try:
        steps = validate_sequence(raw)
    except ValueError as exc:
        return reject(str(exc))
    plan = []
    for step in steps:
        atomic_trace = {}
        try:
            result = _direct_atomic(step["instruction"], infer, trace=atomic_trace)
        except _InferenceResponseError:
            raise
        except ValueError as exc:
            trace["steps"].append({"instruction": step["instruction"], "trace": atomic_trace, "validation_error": str(exc)})
            return reject(f"Sequence step {len(plan) + 1}: {exc}")
        trace["steps"].append({"instruction": step["instruction"], "trace": result["trace"]})
        commands = result["output"]
        if commands == "unsupported":
            return reject(f"Sequence step {len(plan) + 1} is unsupported")
        if any(line.split()[0] in {"playback", "freeze", "restore"} for line in commands.splitlines()):
            return reject("Playback and frozen-pose edits cannot be placed inside a sequence")
        plan.append({**step, "commands": commands})
    return {"output": json.dumps({"kind": "sequence", "steps": plan}, separators=(",", ":")), "trace": trace}


def _direct_atomic(instruction: str, infer: Infer | None = None, *, trace: dict | None = None) -> dict:
    """Interpret one direction with sequential calls to the inference provider.

    Every emitted command is validated. The trace records actual model decisions
    and any validated target repair; the director never guesses from user wording.
    Pass an inference callable to test the command graph without loading models.
    """
    if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 400:
        raise ValueError("Provide a direction of 1–400 characters.")
    infer = infer or local_infer
    trace = {} if trace is None else trace

    def finish(output: str, route: str | None = None) -> dict:
        # route names the final handler; per-model fields preserve raw decisions.
        return {"output": output, "trace": {
            **trace, "route": "unsupported" if output == "unsupported" else route or trace["route"],
        }}

    def ask(name: str, text: str = instruction) -> str:
        raw = infer(PROGRAMS[name], text)
        if not isinstance(raw, str):
            raise ValueError("PAW returned a non-text response")
        return raw.strip()

    def finish_actions(raw: str) -> dict:
        if raw == "unsupported":
            return finish(raw)
        try:
            output = validate_actions(raw)
        except ValueError as exc:
            # Never run an invalid or partial program. Keep the model's output
            # and validation reason for inspection, with a usable UI rejection.
            trace["validation_error"] = str(exc)
            return finish("unsupported")
        return finish(output)

    def cached_decision(name: str) -> str:
        # A rejected priority candidate returns to the normal route. Reuse its
        # actual classifier results rather than requesting a second opinion
        # from the same stateless program on the same instruction.
        if name not in trace:
            trace[name] = ask(name)
        return trace[name]

    def classify_activity() -> str:
        label = cached_decision("activity_scope")
        if label not in {"basic", "dance", "other"}:
            raise ValueError("Invalid activity scope")
        return label

    def confirm_activity() -> str:
        label = cached_decision("activity_confirmation")
        if label not in {"basic", "dance", "other"}:
            raise ValueError("Invalid activity confirmation")
        return label

    def current_control() -> str:
        return cached_decision("current_control")

    extension_scope = ask("extension_scope")
    trace["extension_scope"] = extension_scope
    if extension_scope not in {"sway", "gesture", "none"}:
        raise ValueError("Invalid motion extension scope")
    if extension_scope != "none":
        expert = "body_sway" if extension_scope == "sway" else "action_gesture"
        raw = ask(expert)
        trace.update({expert: raw, "route": "action"})
        if raw == "unsupported":
            return finish(raw)
        command = validate_actions(raw)
        pattern = (r"action sway [1-8](?:\narms still)?" if extension_scope == "sway"
                   else r"action (?:clap|punch_left|punch_right) [1-8]")
        if not re.fullmatch(pattern, command):
            raise ValueError("Invalid motion extension command")
        return finish(command)

    playback = ask("playback_control")
    trace["playback_control"] = playback
    if playback != "none":
        if playback not in {"pause", "resume", "restart"}:
            raise ValueError("Invalid playback control")
        return finish(f"playback {playback}", "playback")

    action_intent = ask("action_intent")
    trace["action_intent"] = action_intent
    if action_intent not in {"single", "combined", "none"}:
        raise ValueError("Invalid new-action intent")
    if action_intent != "none":
        activity = classify_activity()
        if activity == "other" and confirm_activity() == "basic":
            control = current_control()
            if control != "unsupported":
                return finish(validate_follow_up(control), "control")
            activity = "basic"
        if activity == "basic":
            raw = ask("action")
            trace.update(action=raw, route="action")
            if raw == "unsupported" and action_intent == "combined":
                raw = ask("action_composition")
                trace["action_composition"] = raw
            return finish_actions(raw)

    arm = ask("arm_control")
    trace["arm_control"] = arm
    if arm != "none":
        return finish(validate_arm_control(arm), "control")

    # Resolve confirmed body actions and arm edits before the narrower leg gate.
    # Its output must not override an already recognized movement elsewhere.
    deferred_leg_restore = None
    leg = ask("leg_control")
    trace["leg_control"] = leg
    if leg != "none":
        if not re.fullmatch(r"(?:freeze|restore) (?:left_leg|right_leg|both_legs|leg)", leg):
            raise ValueError("Invalid leg motion control")
        leg_command = validate_edit(leg)
        leg_scope = ask("leg_scope")
        trace["leg_scope"] = leg_scope
        if leg_scope not in {"yes", "no"}:
            raise ValueError("Invalid leg anatomy scope")
        if leg_scope == "yes":
            if leg.startswith("freeze "):
                return finish(leg_command, "edit")
            # Returning to both feet is a support edit when dance confirms it.
            deferred_leg_restore = leg_command

    dance = ask("dance_extension")
    trace["dance_extension"] = dance
    confirmation = ask("dance_confirmation")
    trace["dance_confirmation"] = confirmation
    if confirmation not in {"yes", "no"}:
        raise ValueError("Invalid dance domain confirmation")
    if dance == "none" and confirmation == "yes":
        dance = ask("dance_fallback")
        trace["dance_fallback"] = dance
    if dance != "none":
        if confirmation == "yes":
            if dance == "unsupported":
                return finish(dance)
            try:
                command = validate_dance_extension(dance)
            except ValueError as exc:
                trace["validation_error"] = str(exc)
                return finish("unsupported")
            return finish(command, "body" if command.startswith("dance ") else "control")

    if deferred_leg_restore is not None:
        return finish(deferred_leg_restore, "edit")

    activity = classify_activity()

    # Preserve the proven dance/joint router. A second opinion can recognize a
    # constrained body action it missed, without overriding a joint edit as dance.
    if activity == "other" and confirm_activity() == "basic":
        # A relative edit can mention an action name or repetition word.
        # Confirm it is not an existing-motion control before starting an action.
        control = current_control()
        if control != "unsupported":
            return finish(validate_follow_up(control), "control")
        activity = "basic"
    if activity == "basic":
        raw = ask("action")
        trace.update(action=raw, route="action")
        if raw != "unsupported":
            return finish_actions(raw)
        # Confirm an abstention before extending to coordinated actions. A coin
        # can "walk" and an animation can "run backward" without locomotion.
        activity = confirm_activity()
        if activity == "basic":
            raw = ask("action_composition")
            trace["action_composition"] = raw
            return finish_actions(raw)
    if activity == "dance":
        raw = ask("body_fallback")
        trace.update(body_fallback=raw, route="body")
        return finish("unsupported" if raw == "unsupported" else validate_body(raw))
    if activity != "other":
        raise ValueError("Invalid activity scope")

    domain = ask("dispatch")
    trace["dispatch"] = domain
    trace["route"] = domain
    if domain == "unsupported":
        return finish("unsupported")
    intent = "none"
    if domain in {"edit", "control", "motion"}:
        intent = ask("edit_intent")
        trace["edit_intent"] = intent
        if domain == "edit" and intent == "none":
            intent = ask("edit_fallback")
            trace["edit_fallback"] = intent
        if intent not in {"freeze", "restore", "none"}:
            raise ValueError("Invalid motion edit intent")
    if intent != "none":
        target = ask("edit_target")
        trace["edit_target"] = target
        try:
            command = validate_edit(target)
            if command == "none":
                raise ValueError("Motion edit did not identify a target")
        except ValueError:
            confirmation = ask("edit_confirmation")
            trace["edit_confirmation"] = confirmation
            command = validate_edit(confirmation)
            if command == "none":
                return finish("unsupported")
            trace["edit_target_source"] = "edit_confirmation"
        return finish(f"{intent} {command.split()[1]}", "edit")
    if domain == "edit":
        return finish("unsupported")
    if domain == "control":
        raw = current_control()
        return finish("unsupported" if raw == "unsupported" else validate_follow_up(raw))
    if domain == "motion":
        route = ask("motion_scope")
        trace["motion_scope"] = route
        trace["route"] = route
        if route not in {"body", "joint", "mixed"}:
            raise ValueError("Invalid motion scope")
    elif domain == "dexterity":
        route = domain
    else:
        raise ValueError("Invalid motion route")
    if route == "dexterity":
        # Naming a skill may identify the CURRENT motion during a speed edit.
        # Let the narrow control interpreter check before creating a new skill.
        control = current_control()
        if control != "unsupported":
            return finish(validate_follow_up(control), "control")
        raw = ask("dexterity")
        trace["dexterity"] = raw
        # A skill specialist can abstain; never reinterpret an unsupported prop
        # or gesture as a related body-part motion.
        output = "unsupported" if raw == "legacy" else validate_dexterity(raw)
        return finish(output)

    output = []
    if route in {"body", "mixed"}:
        raw = ask("body")
        trace["body"] = raw
        if route == "body" and raw == "unsupported":
            raw = ask("body_fallback")
            trace["body_fallback"] = raw
        if raw == "unsupported":
            return finish("unsupported")
        output.append(validate_body(raw))
    if route in {"joint", "mixed"}:
        raw = ask("joint_motion")
        trace["joint_motion"] = raw
        if raw == "unsupported":
            return finish("unsupported")
        parts = raw.split()
        if len(parts) != 4 or "\n" in raw or "\r" in raw:
            raise ValueError("Invalid joint motion command")
        joint, transform = parts[0], " ".join(parts[1:])
        # Shoulder raises and collarbone shrugs have different rig joints.
        # Keep that anatomical ambiguity in the target specialist's small domain.
        if joint.endswith(("_shoulder", "_clavicle")) and parts[2] == "raise":
            refined = ask("joint")
            trace["joint_target"] = refined
            side = joint.split("_", 1)[0]
            if refined not in {f"{side}_shoulder", f"{side}_clavicle"}:
                raise ValueError("Shoulder refinement changed the side or returned an invalid joint")
            joint = refined
        trace.update(joint=joint, transform=transform)
        output.append(joint_commands(joint, transform))
    return finish("\n".join(output))
