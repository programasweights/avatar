"""Keep character appearance changes compatible with existing joint controls."""
import collections
import itertools
import json
import math
from pathlib import Path
import struct
import unittest


ASSETS = Path(__file__).resolve().parents[1] / "public" / "assets"
COMPONENTS = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
              5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Asset:
    def __init__(self, path):
        raw = path.read_bytes()
        assert struct.unpack_from("<III", raw) == (0x46546C67, 2, len(raw))
        chunks, offset = {}, 12
        while offset < len(raw):
            size, kind = struct.unpack_from("<II", raw, offset)
            chunks[kind] = raw[offset + 8:offset + 8 + size]
            offset += 8 + size
        self.data = json.loads(chunks[0x4E4F534A])
        self.binary = chunks[0x004E4942]
        self.nodes = self.data["nodes"]
        self.parents = {child: parent for parent, node in enumerate(self.nodes)
                        for child in node.get("children", [])}

    def accessor(self, index):
        accessor = self.data["accessors"][index]
        assert "sparse" not in accessor
        view = self.data["bufferViews"][accessor["bufferView"]]
        assert view.get("buffer", 0) == 0
        code, size = COMPONENTS[accessor["componentType"]]
        count = WIDTHS[accessor["type"]]
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = view.get("byteStride", count * size)
        return [struct.unpack_from("<" + code * count, self.binary, offset + i * stride)
                for i in range(accessor["count"])]

    def rig(self, skin):
        names = [self.nodes[index]["name"] for index in skin["joints"]]
        assert len(names) == len(set(names))
        nodes = {}
        for index in skin["joints"]:
            # Include the armature/scene ancestors: changing their transform
            # would move every joint despite identical bone-local transforms.
            while index is not None:
                node = self.nodes[index]
                parent = self.parents.get(index)
                nodes[node["name"]] = {
                    "parent": self.nodes[parent]["name"] if parent is not None else None,
                    **{key: node[key] for key in ("translation", "rotation", "scale", "matrix") if key in node},
                }
                index = parent
        accessor = self.data["accessors"][skin["inverseBindMatrices"]]
        assert accessor["type"] == "MAT4" and accessor["componentType"] == 5126
        binds = self.accessor(skin["inverseBindMatrices"])
        assert len(binds) == len(names) and all(len(row) == 16 for row in binds)
        return set(names), nodes, dict(zip(names, (struct.pack("<16f", *row) for row in binds)))

    def mesh(self, name):
        node = next(node for node in self.nodes if node.get("name") == name)
        primitives = self.data["meshes"][node["mesh"]]["primitives"]
        assert len(primitives) == 1
        primitive = primitives[0]
        assert primitive.get("mode", 4) == 4
        attrs = {key: self.accessor(index) for key, index in primitive["attributes"].items()}
        assert {key for key in attrs if key.startswith("JOINTS_")} == {"JOINTS_0"}
        assert {key for key in attrs if key.startswith("WEIGHTS_")} == {"WEIGHTS_0"}
        skin = self.data["skins"][node["skin"]]
        names = [self.nodes[index]["name"] for index in skin["joints"]]
        vertices = [(position, {names[joint]: weight for joint, weight in zip(joints, weights) if weight > 0})
                    for position, joints, weights in zip(attrs["POSITION"], attrs["JOINTS_0"], attrs["WEIGHTS_0"])]
        return vertices, [row[0] for row in self.accessor(primitive["indices"])]


class CharacterAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = Asset(ASSETS / "character.glb")
        cls.character = Asset(ASSETS / "gangnam-character.glb")

    def test_named_bones_reference_transforms_and_inverse_binds_are_preserved(self):
        expected = self.original.rig(self.original.data["skins"][0])
        self.assertEqual(len(expected[0]), 65)
        self.assertTrue(self.character.data["skins"])
        for skin in self.character.data["skins"]:
            self.assertEqual(self.character.rig(skin), expected)

    def test_original_hand_geometry_topology_and_named_weights_are_preserved(self):
        source, source_indices = self.original.mesh("SuperHero_Male")
        hands, hand_indices = self.character.mesh("Original fully articulated hands")
        # GLB export may round positions by micrometers or duplicate a vertex
        # along a shading seam. Match the retained source geometry, not indices.
        tolerance = 2e-6
        cell = lambda position: tuple(math.floor(value / 1e-5) for value in position)
        buckets, representatives = collections.defaultdict(list), []

        def match(vertex):
            position, weights = vertex
            address = cell(position)
            for delta in itertools.product((-1, 0, 1), repeat=3):
                for index in buckets[tuple(a + b for a, b in zip(address, delta))]:
                    old_position, old_weights = representatives[index]
                    if (max(abs(a - b) for a, b in zip(position, old_position)) < tolerance
                            and all(abs(weights.get(key, 0) - old_weights.get(key, 0)) < tolerance
                                    for key in weights.keys() | old_weights.keys())):
                        return index
            return None

        mapping = {}
        for index, vertex in enumerate(source):
            x, y, _ = vertex[0]
            if not (abs(x) > .690 and 1.34 < y < 1.55):
                continue
            canonical = match(vertex)
            if canonical is None:
                canonical = len(representatives)
                representatives.append(vertex)
                buckets[cell(vertex[0])].append(canonical)
            mapping[index] = canonical
        matched = [match(vertex) for vertex in hands]
        self.assertTrue(hands)
        self.assertNotIn(None, matched, "A hand vertex or its named skin weights changed.")
        expected = collections.Counter(tuple(sorted(mapping[j] for j in source_indices[i:i + 3]))
                                       for i in range(0, len(source_indices), 3)
                                       if all(j in mapping for j in source_indices[i:i + 3]))
        actual = collections.Counter(tuple(sorted(matched[j] for j in hand_indices[i:i + 3]))
                                     for i in range(0, len(hand_indices), 3))
        self.assertEqual(actual, expected)

    def test_character_is_portable_geometry_without_image_dependencies(self):
        def uris(value):
            if isinstance(value, dict):
                return [child for key, child in value.items() if key == "uri"] + [uri for child in value.values() for uri in uris(child)]
            if isinstance(value, list):
                return [uri for child in value for uri in uris(child)]
            return []
        self.assertFalse(self.character.data.get("images"))
        self.assertFalse(self.character.data.get("textures"))
        self.assertFalse(uris(self.character.data))
        self.assertEqual(len(self.character.data["buffers"]), 1)


if __name__ == "__main__":
    unittest.main()
