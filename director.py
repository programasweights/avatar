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
DEXTERITY_SKILLS = {"finger_ripple", "finger_touches", "arm_wave", "coin_roll"}


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


def paired_finger(selection: str) -> str | None:
    if not selection.startswith("both_"):
        return None
    target = "left_" + selection[5:]
    target = JOINT_ALIASES.get(target, target)
    match = re.fullmatch(r"left_(thumb|index|middle|ring|pinky)_[123]", target)
    return match[1] if match else None


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


def direct(instruction: str, infer: Infer | None = None) -> dict:
    """Interpret one direction. Every neural call runs sequentially and locally.

    The returned trace records the actual model decisions. Validation failures
    remain errors; the director never guesses an action from the user's words.
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

    dexterity = ask("dexterity")
    trace["dexterity"] = dexterity
    if dexterity != "legacy":
        return {"output": validate_dexterity(dexterity), "trace": {**trace, "route": "dexterity"}}

    route = ask("router")
    trace["route"] = route
    if route == "unsupported":
        return {"output": "unsupported", "trace": trace}
    if route not in {"body", "joint", "mixed"}:
        raise ValueError("Invalid motion route")

    output = []
    if route == "body":
        raw = ask("body")
        trace["body"] = raw
        # Consult specialists only after explicit abstention, not invalid output.
        if not raw or raw == "unsupported":
            raw = ask("body_fallback")
            trace["body_fallback"] = raw
        if not raw or raw == "unsupported":
            refined = ask("router_fallback")
            trace["route_fallback"] = refined
            if refined not in {"joint", "mixed"}:
                return {"output": "unsupported", "trace": trace}
            trace["route_initial"] = route
            route = refined
            trace["route"] = route
        else:
            output.append(validate_body(raw))
    if route == "mixed":
        raw = ask("mixed_body")
        trace["body"] = raw
        if not raw or raw == "unsupported":
            return {"output": "unsupported", "trace": trace}
        output.append(validate_body(raw))
    if route in {"joint", "mixed"}:
        # Scope the transform so "stop dancing" does not zero a joint movement.
        transform_input = f"Joint movement only: {instruction}" if route == "mixed" else instruction
        joint = ask("joint")
        transform = ask("transform", transform_input)
        trace.update(joint=joint, transform=transform)
        if joint == "unsupported" or transform == "unsupported":
            return {"output": "unsupported", "trace": trace}
        finger = paired_finger(joint)
        if finger:
            refined = ask("paired_joint")
            trace.update(joint_initial=joint, paired_joint=refined)
            if paired_finger(refined) != finger:
                raise ValueError("Paired-finger refinement changed the target or returned an invalid segment")
            joint = refined
            trace["joint"] = joint
        output.append(joint_commands(joint, transform))
    return {"output": "\n".join(output), "trace": trace}
