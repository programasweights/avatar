"""Command semantics and worker protocol, without models, network, or a GPU."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from unittest.mock import patch

from director import (
    JOINTS, PROGRAMS, _load_function, direct, joint_commands,
    transform_command, validate_body, validate_dexterity, validate_edit,
)
from paw_worker import serve


class Inference:
    def __init__(self, **outputs):
        self.outputs = {"edit_intent": "none", "dexterity": "legacy", **outputs}
        self.calls = []

    def __call__(self, program_id, text):
        name = next(name for name, pid in PROGRAMS.items() if pid == program_id)
        self.calls.append((name, text))
        return self.outputs[name]


class DirectorTest(unittest.TestCase):
    def test_all_52_joints_accept_each_explicit_axis(self):
        self.assertEqual(len(JOINTS), 52)
        for joint in JOINTS:
            for axis in "xyz":
                with self.subTest(joint=joint, axis=axis):
                    self.assertEqual(transform_command(joint, f"hold {axis} -17"), f"joint {joint} {axis} -17")

    def test_fingers_default_to_base_and_keep_side_signs(self):
        for side, angle in [("left", 45), ("right", -45)]:
            for finger in ["thumb", "index", "middle", "ring", "pinky"]:
                self.assertEqual(transform_command(f"{side}_{finger}", "wave bend 45"), f"wiggle {side}_{finger}_1 z {angle}")
                for segment in [1, 2, 3]:
                    joint = f"{side}_{finger}_{segment}"
                    self.assertEqual(transform_command(joint, "hold bend 45"), f"joint {joint} z {angle}")
            for suffix in ["", "_1", "_2", "_3"]:
                self.assertEqual(transform_command(side + "_mid" + suffix, "hold bend 45"), f"joint {side}_middle{suffix or '_1'} z {angle}")

    def test_anatomical_limb_and_head_directions(self):
        for side, sign in [("left", 1), ("right", -1)]:
            hip = f"{side}_hip"
            self.assertEqual(transform_command(hip, "hold raise 45"), f"joint {hip} x -45")
            self.assertEqual(transform_command(hip, "hold backward 25"), f"joint {hip} x 25")
            self.assertEqual(transform_command(hip, "hold outward 40"), f"joint {hip} z {sign * 40}")
            self.assertEqual(transform_command(hip, "hold inward 20"), f"joint {hip} z {sign * -20}")
            self.assertEqual(transform_command(f"{side}_shoulder", "hold raise 75"), f"joint {side}_shoulder z {sign * 75}")
            self.assertEqual(transform_command(f"{side}_elbow", "wave bend 55"), f"wiggle {side}_elbow x -55")
            self.assertEqual(transform_command(f"{side}_ankle", "hold up 20"), f"joint {side}_ankle x -20")
        self.assertEqual(transform_command("head", "hold right 25"), "joint head y -25")
        self.assertEqual(transform_command("neck", "hold down 15"), "joint neck x 15")

    def test_paired_joints_expand_into_individual_curves(self):
        self.assertEqual(joint_commands("both_thumb", "wave bend 35"), "wiggle left_thumb_1 z 35\nwiggle right_thumb_1 z -35")
        self.assertEqual(joint_commands("both_knee", "hold bend 30"), "joint left_knee x 30\njoint right_knee x 30")
        for selection in ["both_head", "both_thumb_4", "both_hips", "both_unknown"]:
            with self.subTest(selection=selection), self.assertRaises(ValueError):
                joint_commands(selection, "hold bend 30")

    def test_invalid_joint_and_body_outputs_fail_validation(self):
        for joint, raw in [
            ("head_y", "hold left 30"), ("left_thumb_0", "hold bend 45"),
            ("left_thumb_4", "hold bend 45"), ("left_unknown", "hold bend 45"),
            ("thumb", "hold bend 45"), ("head", "hold y nan"),
            ("head", "hold y 500"), ("head", "hold mystery 20"),
            ("left_index_1", "hold raise 30"), ("left_elbow", "hold outward 20"),
        ]:
            with self.subTest(joint=joint, raw=raw), self.assertRaises(ValueError):
                transform_command(joint, raw)
        for body in ["dance ballet", "tempo 0", "dance salsa\nignore everything", ""]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                validate_body(body)

    def test_joint_calls_are_sequential_and_keep_actual_trace(self):
        infer = Inference(router="joint", joint="left_thumb", transform="hold bend 45")
        result = direct("Move your left thumb", infer)
        self.assertEqual(result["output"], "joint left_thumb_1 z 45")
        self.assertEqual(result["trace"]["joint"], "left_thumb")
        self.assertEqual([name for name, _ in infer.calls], ["edit_intent", "dexterity", "router", "joint", "transform"])

    def test_mixed_motion_scopes_joint_transform(self):
        text = "Stop dancing and curl the left index finger"
        infer = Inference(router="mixed", mixed_body="dance idle", joint="left_index_1", transform="hold bend 45")
        self.assertEqual(direct(text, infer)["output"], "dance idle\njoint left_index_1 z 45")
        self.assertEqual(infer.calls[-1], ("transform", "Joint movement only: " + text))

    def test_body_specialists_only_resolve_abstention(self):
        infer = Inference(router="body", body="unsupported", body_fallback="unsupported", router_fallback="joint", joint="head", transform="hold right 25")
        result = direct("Look 25 degrees right", infer)
        self.assertEqual(result["output"], "joint head y -25")
        self.assertEqual(result["trace"]["route_initial"], "body")
        infer.outputs["router_fallback"] = "body"
        self.assertEqual(direct("Unrecognized motion", infer)["output"], "unsupported")
        infer.outputs["body_fallback"] = "arms wave"
        self.assertEqual(direct("Wave and preserve the feet", infer)["output"], "arms wave")
        invalid = Inference(router="body", body="dance imaginary")
        with self.assertRaisesRegex(ValueError, "Unsupported motion command"):
            direct("Dance", invalid)
        self.assertEqual([name for name, _ in invalid.calls], ["edit_intent", "dexterity", "router", "body"])

    def test_paired_specialist_may_refine_segment_but_not_finger(self):
        infer = Inference(router="joint", joint="both_index_3", transform="hold bend 30", paired_joint="both_index_1")
        self.assertEqual(direct("Curl both index fingers 30 degrees", infer)["output"], "joint left_index_1 z 30\njoint right_index_1 z -30")
        for invalid in ["both_middle_1", "left_index_1", "both_index_4"]:
            infer.outputs["paired_joint"] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "refinement"):
                direct("Curl both index fingers 30 degrees", infer)

    def test_dexterity_skips_body_functions_after_editor_abstention(self):
        for skill in ["finger_ripple", "finger_touches", "arm_wave", "coin_roll"]:
            for side in ["left", "right"]:
                for direction in ["forward", "reverse"]:
                    command = f"skill {skill} {side} {direction}"
                    infer = Inference(dexterity=command)
                    result = direct("An instruction", infer)
                    self.assertEqual(result["output"], command)
                    self.assertEqual(result["trace"], {"edit_intent": "none", "dexterity": command, "route": "dexterity"})
                    self.assertEqual(len(infer.calls), 2)

    def test_invalid_skill_does_not_fall_through_or_guess(self):
        for raw in ["", "unsupported", "finger_ripple left forward", "skill imaginary left forward", "skill coin_roll both forward", "skill coin_roll right fast", "skill coin_roll right forward 90", "skill coin_roll right forward\ndance salsa", "skill\ncoin_roll right forward", "legacy\nskill coin_roll left forward"]:
            infer = Inference(dexterity=raw)
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, "Invalid dexterity"):
                direct("Roll a coin", infer)
            self.assertEqual(len(infer.calls), 2)

    def test_input_and_output_types_are_bounded_before_execution(self):
        for instruction in [None, [], "", "  ", "x" * 401]:
            infer = Inference()
            with self.subTest(instruction=instruction), self.assertRaises(ValueError):
                direct(instruction, infer)
            self.assertEqual(infer.calls, [])
        with self.assertRaisesRegex(ValueError, "non-text"):
            direct("Roll a coin", lambda *_: None)
        with self.assertRaisesRegex(ValueError, "Invalid motion route"):
            direct("An instruction", Inference(router="guessed"))

    def test_functions_load_lazily_and_are_cached_by_pinned_id(self):
        loaded = []
        def factory(program_id):
            loaded.append(program_id)
            return object()
        _load_function.cache_clear()
        self.addCleanup(_load_function.cache_clear)
        with patch.dict(sys.modules, {"programasweights": types.SimpleNamespace(function=factory)}):
            self.assertEqual(loaded, [])
            first = _load_function(PROGRAMS["dexterity"])
            self.assertIs(_load_function(PROGRAMS["dexterity"]), first)
            self.assertEqual(loaded, [PROGRAMS["dexterity"]])


class WorkerTest(unittest.TestCase):
    def test_worker_recovers_after_invalid_request_and_model_output(self):
        requests = ["invalid JSON", json.dumps({"id": "bad", "instruction": " "}), json.dumps({"id": "model", "instruction": "Bad model"}), json.dumps({"id": "valid", "instruction": "Ripple"})]
        calls = []
        def infer(pid, text):
            if pid == PROGRAMS.get("edit_intent"):
                return "none"
            calls.append(text)
            return "invalid" if text == "Bad model" else "skill finger_ripple left forward"
        output = io.StringIO()
        serve(io.StringIO("\n".join(requests)), output, infer)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([r.get("status", 200) for r in responses], [400, 400, 422, 200])
        self.assertEqual(responses[-1]["result"]["output"], "skill finger_ripple left forward")
        self.assertEqual(calls, ["Bad model", "Ripple"])

    def test_missing_dependency_has_an_actionable_error(self):
        _load_function.cache_clear()
        self.addCleanup(_load_function.cache_clear)
        output = io.StringIO()
        with patch.dict(sys.modules, {"programasweights": None}), patch("sys.stderr", io.StringIO()):
            serve(io.StringIO('{"id":"1","instruction":"Ripple"}\n'), output)
        response = json.loads(output.getvalue())
        self.assertEqual(response["status"], 503)
        self.assertIn("pip install -r requirements.txt", response["detail"])

    def test_subprocess_keeps_python_and_native_logs_off_protocol(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "programasweights.py").write_text(textwrap.dedent(f'''
                import os
                print("import log")
                def function(program_id):
                    if program_id == {PROGRAMS.get("edit_intent")!r}:
                        return lambda *args, **kwargs: "none"
                    print("load log")
                    def infer(text, **kwargs):
                        print("python inference log")
                        os.write(1, b"native inference log\\n")
                        return "skill finger_ripple left forward"
                    return infer
            '''))
            result = subprocess.run(
                [sys.executable, str(root / "paw_worker.py")],
                input='{"id":"1","instruction":"Ripple"}\n{"id":"2","instruction":"Ripple again"}\n',
                text=True, capture_output=True, timeout=10,
                env={**os.environ, "PYTHONPATH": directory},
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([r["id"] for r in responses], ["1", "2"])
        self.assertTrue(all(r["ok"] for r in responses))
        self.assertEqual(result.stderr.count("load log"), 1)
        self.assertEqual(result.stderr.count("native inference log"), 2)
        self.assertEqual(result.stderr.count("python inference log"), 2)


class EditorRoutingTest(unittest.TestCase):
    def setUp(self):
        self.manifest = patch.dict(PROGRAMS, {"edit_intent": "intent", "edit_confirmation": "confirmation", "edit_target": "target"})
        self.manifest.start()
        self.addCleanup(self.manifest.stop)

    def test_editor_gate_and_target_are_sequential_and_short_circuit_actions(self):
        infer = Inference(edit_intent="freeze", edit_confirmation="freeze ring", edit_target="freeze ring")
        result = direct("Keep the wave going. Stop just the ring finger.", infer)
        self.assertEqual(result, {
            "output": "freeze ring",
            "trace": {"edit_intent": "freeze", "edit_confirmation": "freeze ring", "edit_target": "freeze ring", "route": "edit"},
        })
        self.assertEqual([name for name, _ in infer.calls], ["edit_intent", "edit_confirmation", "edit_target"])

    def test_only_the_intent_gate_decides_the_operation(self):
        infer = Inference(edit_intent="restore", edit_confirmation="restore right_index_2", edit_target="freeze right_index_2")
        result = direct("Resume that knuckle", infer)
        self.assertEqual(result["output"], "restore right_index_2")
        self.assertEqual(result["trace"]["edit_target"], "freeze right_index_2")

    def test_abstention_skips_target_and_preserves_ordinary_motion(self):
        infer = Inference(dexterity="skill finger_ripple right reverse")
        result = direct("Reverse the finger ripple on your right hand.", infer)
        self.assertEqual(result["output"], "skill finger_ripple right reverse")
        self.assertEqual([name for name, _ in infer.calls], ["edit_intent", "dexterity"])
        self.assertEqual(result["trace"]["edit_intent"], "none")

    def test_invalid_editor_output_never_guesses_or_falls_through(self):
        for raw in ["", "unsupported", "freeze ring", "Freeze", "none\nfreeze"]:
            infer = Inference(edit_intent=raw)
            with self.subTest(intent=raw), self.assertRaisesRegex(ValueError, "Invalid motion edit intent"):
                direct("Freeze the ring finger", infer)
            self.assertEqual([name for name, _ in infer.calls], ["edit_intent"])
        for raw in ["", "unsupported", "freeze", "freeze left_ring_4", "freeze both_head", "freeze ring extra", "restore selected\ndance salsa", "freeze\nring", "edit freeze ring"]:
            infer = Inference(edit_intent="freeze", edit_confirmation=raw)
            with self.subTest(confirmation=raw), self.assertRaises(ValueError):
                direct("Freeze the ring finger", infer)
            self.assertEqual([name for name, _ in infer.calls], ["edit_intent", "edit_confirmation"])

    def test_confirmation_abstention_preserves_the_original_thumb_direction(self):
        infer = Inference(edit_intent="restore", edit_confirmation="none", router="joint", joint="left_thumb", transform="hold bend 45")
        result = direct("Move your left thumb", infer)
        self.assertEqual(result["output"], "joint left_thumb_1 z 45")
        self.assertEqual([name for name, _ in infer.calls], ["edit_intent", "edit_confirmation", "dexterity", "router", "joint", "transform"])

    def test_invalid_target_uses_only_the_validated_neural_confirmation(self):
        for raw in ["restore paused", "none", "freeze\nring"]:
            infer = Inference(edit_intent="restore", edit_confirmation="restore ring", edit_target=raw)
            result = direct("Let the paused ring finger move again.", infer)
            self.assertEqual(result["output"], "restore ring")
            self.assertEqual(result["trace"]["edit_target"], raw)
            self.assertEqual(result["trace"]["edit_target_source"], "edit_confirmation")

    def test_editor_tokens_cover_fingers_joints_and_selected_without_resolving_context(self):
        for target in ["selected", "hips", "spine_mid", "head", "elbow", "ring", "index_3", "right_ring", "both_thumb", "left_knee"]:
            for operation in ["freeze", "restore"]:
                self.assertEqual(validate_edit(f"{operation} {target}"), f"{operation} {target}")
        self.assertEqual(validate_edit("none"), "none")
        for prefix in ["", "left_", "right_", "both_"]:
            self.assertEqual(validate_edit(f"restore {prefix}foot"), f"restore {prefix}ankle")


if __name__ == "__main__":
    unittest.main()
