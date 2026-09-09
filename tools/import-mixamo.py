#!/usr/bin/env python3
"""Import your own Mixamo Y Bot and Breathing Idle downloads for local use.

Run with Blender's bundled Python:
  blender --background --python tools/import-mixamo.py -- ybot.fbx idle.fbx

Or with a Python environment that has bpy installed:
  python tools/import-mixamo.py ybot.fbx idle.fbx

The default output is local-assets/character.glb, which is excluded from Git.
Add --blend to save an editable local-assets/character.blend alongside it.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def import_character(character: Path, idle: Path, output: Path, save_blend: bool) -> None:
    try:
        import bpy
    except ImportError as exc:
        raise RuntimeError("Run this script with Blender's background Python; see ASSETS.md.") from exc

    for path in (character, idle):
        if not path.is_file() or path.suffix.lower() != ".fbx":
            raise ValueError(f"Expected an existing FBX file: {path}")

    bpy.ops.wm.read_factory_settings(use_empty=True)

    def load(path: Path):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.fbx(
            filepath=str(path), automatic_bone_orientation=True, ignore_leaf_bones=False,
        )
        imported = set(bpy.data.objects) - before
        armatures = [obj for obj in imported if obj.type == "ARMATURE"]
        if len(armatures) != 1:
            raise ValueError(f"Expected exactly one character armature in {path.name}")
        return armatures[0], imported

    character_armature, character_objects = load(character)
    if not any(obj.type == "MESH" for obj in character_objects):
        raise ValueError("The character FBX must be downloaded With Skin.")
    names = {bone.name.removeprefix("mixamorig:").removeprefix("mixamorig"): bone
             for bone in character_armature.data.bones}
    required = {"Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"}
    for side in ("Left", "Right"):
        required.update(side + name for name in (
            "Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase"
        ))
        for finger in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
            required.update(f"{side}Hand{finger}{segment}" for segment in (1, 2, 3))
    if missing := required - names.keys():
        raise ValueError("Y Bot is missing required joints: " + ", ".join(sorted(missing)))
    for side in ("Left", "Right"):
        for finger in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
            third = names[f"{side}Hand{finger}3"]
            if not third.children:
                raise ValueError(f"Missing terminal fingertip after {third.name}")

    idle_armature, idle_objects = load(idle)
    animation = idle_armature.animation_data
    if animation is None or animation.action is None:
        raise ValueError("The idle FBX does not contain an active animation action.")
    action = animation.action
    action.use_fake_user = True
    target = character_armature.animation_data_create()
    target.action = action
    if hasattr(animation, "action_slot") and animation.action_slot is not None:
        target.action_slot = animation.action_slot
    for obj in idle_objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    for other in list(bpy.data.actions):
        if other != action:
            bpy.data.actions.remove(other)
    action.name = "idle"
    bpy.context.scene.frame_start = int(action.frame_range[0])
    bpy.context.scene.frame_end = int(action.frame_range[1])
    bpy.context.scene.frame_set(bpy.context.scene.frame_start)
    bpy.context.view_layer.update()

    bpy.ops.object.select_all(action="DESELECT")
    for obj in character_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = character_armature
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", use_selection=True,
        export_animations=True, export_animation_mode="ACTIONS",
        export_nla_strips=False, export_apply=True, export_yup=True,
    )
    if save_blend:
        bpy.ops.file.pack_all()
        bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix(".blend")))
    print(f"Saved {output}: {len(required)} articulated joints, fingertip endpoints and idle reference.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("character", type=Path, help="Y Bot, T-pose, With Skin, FBX Binary")
    parser.add_argument("idle", type=Path, help="Same Y Bot, Breathing Idle, Without Skin, FBX Binary")
    parser.add_argument("--output", type=Path, default=ROOT / "local-assets/character.glb")
    parser.add_argument("--blend", action="store_true", help="Also save an editable .blend beside the GLB")
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(argv)
    import_character(args.character.resolve(), args.idle.resolve(), args.output.resolve(), args.blend)


if __name__ == "__main__":
    main()
