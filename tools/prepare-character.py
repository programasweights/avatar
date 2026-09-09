#!/usr/bin/env python3
"""Package the CC0 Quaternius Superhero Male glTF as a self-contained GLB.

Usage:
    python3 tools/prepare-character.py '/path/to/Superhero_Male_FullBody.gltf'

No Blender or third-party Python packages are needed. Download the free Standard
pack linked in ASSETS.md first. This never downloads assets or changes the source.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]


def prepare(source: Path, output: Path) -> None:
    document = json.loads(source.read_text())
    names = {node.get("name") for node in document.get("nodes", [])}
    required = {"pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head"}
    for side in ("l", "r"):
        required.update(f"{part}_{side}" for part in (
            "clavicle", "upperarm", "lowerarm", "hand", "thigh", "calf", "foot", "ball"
        ))
        for finger in ("thumb", "index", "middle", "ring", "pinky"):
            required.update(f"{finger}_{segment:02}_{side}" for segment in (1, 2, 3))
            required.add(f"{finger}_04_leaf_{side}")
    if missing := required - names:
        raise ValueError("Source is missing required joints: " + ", ".join(sorted(missing)))

    document = copy.deepcopy(document)
    binary = bytearray()

    def append(data: bytes) -> int:
        binary.extend(b"\0" * (-len(binary) % 4))
        offset = len(binary)
        binary.extend(data)
        return offset

    buffer_offsets = []
    for buffer in document["buffers"]:
        data = (source.parent / buffer["uri"]).read_bytes()
        if len(data) != buffer["byteLength"]:
            raise ValueError("Unexpected source buffer length")
        buffer_offsets.append(append(data))
    for view in document["bufferViews"]:
        view["byteOffset"] = view.get("byteOffset", 0) + buffer_offsets[view["buffer"]]
        view["buffer"] = 0

    # A single matte jade material keeps attention on motion. The source geometry,
    # normals, skin weights and bones stay unchanged; no image payload is needed.
    def linear(channel: int) -> float:
        value = channel / 255
        return value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4

    document["materials"] = [{
        "name": "Matte jade",
        "doubleSided": True,
        "pbrMetallicRoughness": {
            "baseColorFactor": [linear(channel) for channel in (173, 207, 193)] + [1],
            "metallicFactor": .18,
            "roughnessFactor": .5,
        },
    }]
    for mesh in document.get("meshes", []):
        for primitive in mesh["primitives"]:
            primitive["material"] = 0
    for key in ("images", "textures", "samplers"):
        document.pop(key, None)

    document["buffers"] = [{"byteLength": len(binary)}]
    document["asset"]["copyright"] = "Quaternius — CC0 1.0 Universal"
    encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    size = 12 + 8 + len(encoded) + 8 + len(binary)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(
        struct.pack("<4sII", b"glTF", 2, size)
        + struct.pack("<I4s", len(encoded), b"JSON") + encoded
        + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    )
    print(f"Saved {output} ({size:,} bytes; {len(required)} required joints verified)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Superhero_Male_FullBody.gltf from the free pack")
    parser.add_argument("--output", type=Path, default=ROOT / "public/assets/character.glb")
    args = parser.parse_args()
    prepare(args.source, args.output)
