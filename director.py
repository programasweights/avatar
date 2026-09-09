"""Words → validated motion commands, using small, local PAW functions."""
from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path
from typing import Callable

PROGRAMS = json.loads((Path(__file__).parent / "programs.json").read_text())
Infer = Callable[[str, str], str]
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
EDIT_ALIASES = {f"{prefix}foot": f"{prefix}ankle" for prefix in ("", "left_", "right_", "both_")}
DEXTERITY_SKILLS = {"finger_ripple", "finger_touches", "arm_wave", "coin_roll"}
EDIT_PARTS = set(PARTS) | set(FINGERS) | {f"{finger}_{segment}" for finger in FINGERS for segment in (1, 2, 3)}
EDIT_TARGETS = {"selected", "hips", "spine", "spine_mid", "chest", "neck", "head"} | EDIT_PARTS | {
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
    output = _load_function(program_id)(instruction, temperature=0, max_tokens=80)
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
    lines = raw.strip().splitlines()
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


def direct(instruction: str, infer: Infer | None = None) -> dict:
    """Interpret one direction. Every neural call runs sequentially and locally.

    Every emitted command is validated. The trace records actual model decisions
    and any validated target repair; the director never guesses from user wording.
    Pass an inference callable to test the command graph without loading models.
    """
    if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 400:
        raise ValueError("Provide a direction of 1–400 characters.")
    infer = infer or local_infer
    trace = {}

    def ask(name: str, text: str = instruction) -> str:
        raw = infer(PROGRAMS[name], text)
        if not isinstance(raw, str):
            raise ValueError("PAW returned a non-text response")
        return raw.strip()

    domain = ask("dispatch")
    trace["dispatch"] = domain
    trace["route"] = domain
    if domain == "unsupported":
        return {"output": "unsupported", "trace": trace}
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
                return {"output": "unsupported", "trace": trace}
            trace["edit_target_source"] = "edit_confirmation"
        return {"output": f"{intent} {command.split()[1]}", "trace": trace}
    if domain == "edit":
        return {"output": "unsupported", "trace": trace}
    if domain == "control":
        raw = ask("current_control")
        trace["current_control"] = raw
        return {"output": "unsupported" if raw == "unsupported" else validate_follow_up(raw), "trace": trace}
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
        raw = ask("dexterity")
        trace["dexterity"] = raw
        # A skill specialist can abstain; never reinterpret an unsupported prop
        # or gesture as a related body-part motion.
        output = "unsupported" if raw == "legacy" else validate_dexterity(raw)
        return {"output": output, "trace": trace}

    output = []
    if route in {"body", "mixed"}:
        raw = ask("body")
        trace["body"] = raw
        if route == "body" and raw == "unsupported":
            raw = ask("body_fallback")
            trace["body_fallback"] = raw
        if raw == "unsupported":
            return {"output": "unsupported", "trace": trace}
        output.append(validate_body(raw))
    if route in {"joint", "mixed"}:
        raw = ask("joint_motion")
        trace["joint_motion"] = raw
        if raw == "unsupported":
            return {"output": "unsupported", "trace": trace}
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
    return {"output": "\n".join(output), "trace": trace}
