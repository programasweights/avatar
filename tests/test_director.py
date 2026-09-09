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
    transform_command, validate_body, validate_dexterity, validate_edit, validate_follow_up, validate_actions,
)
from paw_worker import serve


class Inference:
    def __init__(self, **outputs):
        self.outputs = {"playback_control": "none", "activity_scope": "other", "activity_confirmation": "basic" if outputs.get("activity_scope") == "basic" else "other", "action_composition": "unsupported", "edit_intent": "none", "edit_fallback": "none", **outputs}
        self.calls = []

    def __call__(self, program_id, text):
        name = next(name for name, pid in PROGRAMS.items() if pid == program_id)
        self.calls.append((name, text))
        return self.outputs[name]


class DirectorTest(unittest.TestCase):


    def test_playback_short_circuits_without_selecting_or_rebuilding_a_motion(self):
        for command in ["playback pause", "playback resume", "playback restart"]:
            with self.subTest(command=command):
                infer = Inference(playback_control=command.removeprefix("playback "))
                result = direct("A global playback direction", infer)
                self.assertEqual(result, {"output": command, "trace": {
                    "playback_control": command.removeprefix("playback "), "route": "playback"}})
                self.assertEqual(infer.calls, [("playback_control", "A global playback direction")])

    def test_invalid_playback_output_is_rejected_before_other_models_run(self):
        for output in ["playback pause", "unsupported", "playback reset", "playback pause\njoint head x 10"]:
            with self.subTest(output=output):
                infer = Inference(playback_control=output)
                with self.assertRaisesRegex(ValueError, "Invalid playback control"):
                    direct("A direction", infer)
                self.assertEqual(len(infer.calls), 1)

    def test_basic_actions_preserve_counts_and_sequence_order(self):
        command = "action jump 2\naction bow 1"
        infer = Inference(activity_scope="basic", action=command)
        result = direct("Jump twice, then take a bow", infer)
        self.assertEqual(result["output"], command)
        self.assertEqual(result["trace"]["route"], "action")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "action"])
        infer = Inference(activity_scope="basic", action="unsupported")
        self.assertEqual(direct("Jump nine times", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "action", "activity_confirmation", "action_composition"])

    def test_scope_keeps_basic_actions_separate_from_joint_and_playback_edits(self):
        infer = Inference(activity_scope="basic", action="action sit 1")
        self.assertEqual(direct("Sit down", infer)["output"], "action sit 1")
        infer = Inference(activity_scope="dance", body_fallback="dance cha_cha")
        self.assertEqual(direct("Dance chacha", infer)["output"], "dance cha_cha")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "body_fallback"])
        with self.assertRaisesRegex(ValueError, "Invalid activity scope"):
            direct("Some instruction", Inference(activity_scope="guessed"))

    def test_action_abstention_checks_scope_before_coordinated_gaits(self):
        infer = Inference(activity_scope="basic", action="unsupported",
                          activity_confirmation="other", dispatch="control",
                          current_control="reverse current")
        self.assertEqual(direct("Run this motion backward", infer)["output"], "reverse current")
        self.assertNotIn("action_composition", [name for name, _ in infer.calls])
        infer = Inference(activity_scope="basic", action="unsupported",
                          action_composition="action walk_wave 1\naction bow 1")
        self.assertEqual(direct("Walk and wave then bow", infer)["output"], "action walk_wave 1\naction bow 1")
        self.assertEqual([name for name, _ in infer.calls],
                         ["playback_control", "activity_scope", "action", "activity_confirmation", "action_composition"])

    def test_confirmation_promotes_only_basic_actions_and_is_reused_after_abstention(self):
        for action, composition, expected in [
            ("action jump 1 left", "unsupported", "action jump 1 left"),
            ("unsupported", "action jump 2 right\narms still", "action jump 2 right\narms still"),
            ("unsupported", "unsupported", "unsupported"),
        ]:
            infer = Inference(activity_scope="other", activity_confirmation="basic",
                              action=action, action_composition=composition)
            self.assertEqual(direct("A constrained body action", infer)["output"], expected)
            calls = [name for name, _ in infer.calls]
            self.assertEqual(calls.count("activity_confirmation"), 1)
            self.assertNotIn("dispatch", calls)
            self.assertEqual("action_composition" in calls, action == "unsupported")

    def test_confirmation_dance_does_not_replace_a_joint_edit(self):
        infer = Inference(activity_scope="other", activity_confirmation="dance",
                          dispatch="motion", motion_scope="joint", joint_motion="right_wrist hold y 20")
        self.assertEqual(direct("Dance robot with the right wrist rotated around y 20 degrees", infer)["output"],
                         "joint right_wrist y 20")
        self.assertNotIn("body_fallback", [name for name, _ in infer.calls])

    def test_invalid_confirmation_fails_before_action_or_dispatch(self):
        for scope in ["other", "basic"]:
            infer = Inference(activity_scope=scope, action="unsupported", activity_confirmation="action jump 1")
            with self.assertRaisesRegex(ValueError, "Invalid activity confirmation"):
                direct("A direction", infer)
            self.assertNotIn("action_composition", [name for name, _ in infer.calls])
            self.assertNotIn("dispatch", [name for name, _ in infer.calls])

    def test_waving_gaits_reject_a_conflicting_still_arms_constraint(self):
        for gait in ["walk_wave", "run_wave"]:
            with self.subTest(gait=gait), self.assertRaisesRegex(ValueError, "waving gait"):
                validate_actions(f"action {gait} 1\narms still")

    def test_action_parameters_preserve_support_and_arm_constraints(self):
        for command in ["action kick_right 1\narms still", "action jump 2 left",
                        "action jump 1 right\naction jump 2 left\narms still",
                        "action jump 2 both", "action run 1\narms still"]:
            with self.subTest(command=command):
                infer = Inference(activity_scope="basic", action=command)
                self.assertEqual(direct("A parameterized body action", infer)["output"], command)
        for invalid in ["arms still", "action run 1 left", "action kick_right 1 right",
                        "action jump 1 center", "action jump 1 left extra",
                        "arms still\naction jump 1", "action jump 1\narms still\narms still"]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_actions(invalid)

    def test_action_limits_reject_invalid_or_partial_model_programs(self):
        for raw in ["", "action jump 0", "action jump 9", "action jump -1",
                    "action jump 2.5", "action jump twice", "action backflip 1",
                    "action jump 1\ndance salsa", "action run 1 extra",
                    "\n".join(["action jump 1"] * 5),
                    "action jump 8\naction bow 8\naction run 1"]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                validate_actions(raw)
        self.assertEqual(validate_actions("action jump 8\naction bow 8"),
                         "action jump 8\naction bow 8")

    def test_invalid_action_programs_abstain_without_running_a_partial_motion(self):
        for field in ["action", "action_composition"]:
            for raw in ["", "action jump 0", "action jump 9 left",
                        "action run_wave 1\narms still", "action jump 1\naction backflip 1"]:
                with self.subTest(field=field, raw=raw):
                    outputs = {"activity_scope": "basic", "activity_confirmation": "basic", "action": "unsupported", field: raw}
                    result = direct("A bounded whole-body direction", Inference(**outputs))
                    self.assertEqual(result["output"], "unsupported")
                    self.assertEqual(result["trace"]["route"], "unsupported")
                    self.assertEqual(result["trace"][field], raw)
                    self.assertTrue(result["trace"]["validation_error"])

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

    def test_knee_raises_lift_at_the_hip_while_knee_bends_stay_local(self):
        for side in ["left", "right"]:
            self.assertEqual(transform_command(f"{side}_knee", "hold raise 30"), f"joint {side}_hip x -30")
            self.assertEqual(transform_command(f"{side}_knee", "hold bend 30"), f"joint {side}_knee x 30")

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

    def test_final_edit_route_preserves_the_initial_dispatch_and_specialist_decisions(self):
        for domain in ["motion", "control", "edit"]:
            for intent in ["freeze", "restore"]:
                with self.subTest(domain=domain, intent=intent):
                    raw_target = "freeze middle"
                    infer = Inference(dispatch=domain, edit_intent=intent, edit_target=raw_target)
                    result = direct("A finger edit discovered after dispatch", infer)
                    self.assertEqual(result["output"], f"{intent} middle")
                    self.assertEqual(result["trace"]["route"], "edit")
                    self.assertEqual(result["trace"]["dispatch"], domain)
                    self.assertEqual(result["trace"]["edit_intent"], intent)
                    self.assertEqual(result["trace"]["edit_target"], raw_target)
                    self.assertNotIn("motion_scope", result["trace"])
                    self.assertNotIn("current_control", result["trace"])

    def test_every_abstention_has_an_unsupported_final_route_and_retains_raw_decisions(self):
        paths = [
            {"dispatch": "unsupported"},
            {"activity_scope": "basic", "action": "unsupported", "action_composition": "unsupported"},
            {"activity_scope": "dance", "body_fallback": "unsupported"},
            {"dispatch": "edit", "edit_intent": "none", "edit_fallback": "none"},
            {"dispatch": "motion", "edit_intent": "freeze", "edit_target": "none", "edit_confirmation": "none"},
            {"dispatch": "control", "current_control": "unsupported"},
            {"dispatch": "dexterity", "dexterity": "legacy"},
            {"dispatch": "motion", "motion_scope": "body", "body": "unsupported", "body_fallback": "unsupported"},
            {"dispatch": "motion", "motion_scope": "mixed", "body": "unsupported"},
            {"dispatch": "motion", "motion_scope": "joint", "joint_motion": "unsupported"},
            {"dispatch": "motion", "motion_scope": "mixed", "body": "dance salsa", "joint_motion": "unsupported"},
        ]
        for outputs in paths:
            with self.subTest(outputs=outputs):
                result = direct("A request outside the implemented motion vocabulary", Inference(**outputs))
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["route"], "unsupported")
                for name, raw in outputs.items():
                    self.assertEqual(result["trace"][name], raw)

    def test_joint_calls_are_sequential_and_keep_actual_trace(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="left_thumb hold bend 45")
        result = direct("Move your left thumb", infer)
        self.assertEqual(result["output"], "joint left_thumb_1 z 45")
        self.assertEqual(result["trace"]["joint"], "left_thumb")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "joint_motion"])

    def test_mixed_motion_separates_body_and_joint_commands(self):
        text = "Stop dancing and curl the left index finger"
        infer = Inference(dispatch="motion", motion_scope="mixed", body="dance idle", joint_motion="left_index_1 hold bend 45")
        self.assertEqual(direct(text, infer)["output"], "dance idle\njoint left_index_1 z 45")
        self.assertEqual(infer.calls[-1], ("joint_motion", text))

    def test_mixed_preservation_and_bpm_use_body_expert_without_restarting_dance(self):
        infer = Inference(dispatch="motion", motion_scope="mixed", body="tempo 100", joint_motion="left_index_1 wave bend 35")
        result = direct("Keep dancing salsa at 100 BPM and wiggle the left index finger 35 degrees.", infer)
        self.assertEqual(result["output"], "tempo 100\nwiggle left_index_1 z 35")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "body", "joint_motion"])

    def test_body_specialists_only_resolve_abstention_without_switching_routes(self):
        infer = Inference(dispatch="motion", motion_scope="body", body="unsupported", body_fallback="unsupported")
        self.assertEqual(direct("Unrecognized motion", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "body", "body_fallback"])
        infer.outputs["body_fallback"] = "arms robot"
        self.assertEqual(direct("Use robotic arms", infer)["output"], "arms robot")
        invalid = Inference(dispatch="motion", motion_scope="body", body="dance imaginary")
        with self.assertRaisesRegex(ValueError, "Unsupported motion command"):
            direct("Dance", invalid)
        self.assertEqual([name for name, _ in invalid.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "body"])

    def test_combined_joint_output_preserves_paired_segments_and_validates_fields(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="both_index_2 hold bend 30")
        self.assertEqual(direct("Curl the second knuckle of both index fingers 30 degrees", infer)["output"], "joint left_index_2 z 30\njoint right_index_2 z -30")
        for invalid in ["both_index_4 hold bend 30", "both_head hold left 20", "head hold y nan", "head hold y 400", "head hold y 20 extra", "head hold\ny 20"]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                direct("A joint request", Inference(dispatch="motion", motion_scope="joint", joint_motion=invalid))
        infer = Inference(dispatch="motion", motion_scope="mixed", body="dance salsa", joint_motion="unsupported")
        self.assertEqual(direct("An unsupported joint plus dance", infer)["output"], "unsupported")

    def test_shoulder_specialist_preserves_the_side_and_anatomical_joint(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="left_shoulder hold raise 18", joint="left_clavicle")
        result = direct("Shrug the left shoulder 18 degrees", infer)
        self.assertEqual(result["output"], "joint left_clavicle z 18")
        self.assertEqual(result["trace"]["joint_motion"], "left_shoulder hold raise 18")
        for target in ["right_clavicle", "left_wrist", "unsupported"]:
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, "Shoulder refinement"):
                direct("Raise the left arm", Inference(dispatch="motion", motion_scope="joint", joint_motion="left_shoulder hold raise 18", joint=target))

    def test_explicit_shoulder_axis_does_not_enter_anatomical_raise_refinement(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="left_shoulder hold x -27")
        self.assertEqual(direct("Rotate the left shoulder on x to -27 degrees", infer)["output"], "joint left_shoulder x -27")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "joint_motion"])

    def test_dexterity_skips_unrelated_functions(self):
        for skill in ["finger_ripple", "finger_touches", "arm_wave", "coin_roll"]:
            for side in ["left", "right"]:
                for direction in ["forward", "reverse"]:
                    command = f"skill {skill} {side} {direction}"
                    infer = Inference(dispatch="dexterity", dexterity=command)
                    result = direct("An instruction", infer)
                    self.assertEqual(result["output"], command)
                    self.assertEqual(result["trace"], {"playback_control": "none", "activity_scope": "other", "activity_confirmation": "other", "dispatch": "dexterity", "dexterity": command, "route": "dexterity"})
                    self.assertEqual(len(infer.calls), 5)

    def test_invalid_skill_does_not_fall_through_or_guess(self):
        for raw in ["", "unsupported", "finger_ripple left forward", "skill imaginary left forward", "skill coin_roll both forward", "skill coin_roll right fast", "skill coin_roll right forward 90", "skill coin_roll right forward\ndance salsa", "skill\ncoin_roll right forward", "legacy\nskill coin_roll left forward"]:
            infer = Inference(dispatch="dexterity", dexterity=raw)
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, "Invalid dexterity"):
                direct("Roll a coin", infer)
            self.assertEqual(len(infer.calls), 5)

    def test_input_and_output_types_are_bounded_before_execution(self):
        for instruction in [None, [], "", "  ", "x" * 401]:
            infer = Inference()
            with self.subTest(instruction=instruction), self.assertRaises(ValueError):
                direct(instruction, infer)
            self.assertEqual(infer.calls, [])
        with self.assertRaisesRegex(ValueError, "non-text"):
            direct("Roll a coin", lambda *_: None)
        with self.assertRaisesRegex(ValueError, "Invalid motion route"):
            direct("An instruction", Inference(dispatch="guessed"))

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
            if pid == PROGRAMS["playback_control"]:
                return "none"
            if pid in {PROGRAMS["activity_scope"], PROGRAMS["activity_confirmation"]}:
                return "other"
            if pid == PROGRAMS["dispatch"]:
                return "dexterity"
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
                    if program_id == {PROGRAMS["playback_control"]!r}:
                        return lambda *args, **kwargs: "none"
                    if program_id in ({PROGRAMS["activity_scope"]!r}, {PROGRAMS["activity_confirmation"]!r}):
                        return lambda *args, **kwargs: "other"
                    if program_id == {PROGRAMS["dispatch"]!r}:
                        return lambda *args, **kwargs: "dexterity"
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


class DispatchRoutingTest(unittest.TestCase):
    def test_edit_target_is_sequential_and_short_circuits_actions(self):
        infer = Inference(dispatch="edit", edit_intent="freeze", edit_target="freeze ring")
        self.assertEqual(direct("Keep the wave going. Stop just the ring finger.", infer), {
            "output": "freeze ring",
            "trace": {"playback_control": "none", "activity_scope": "other", "activity_confirmation": "other", "dispatch": "edit", "edit_intent": "freeze", "edit_target": "freeze ring", "route": "edit"},
        })
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_target"])

    def test_dispatch_decides_operation_and_confirmation_repairs_only_invalid_target(self):
        infer = Inference(dispatch="edit", edit_intent="restore", edit_target="freeze right_index_2")
        self.assertEqual(direct("Resume that knuckle", infer)["output"], "restore right_index_2")
        for raw in ["restore paused", "none", "freeze\nring"]:
            infer = Inference(dispatch="edit", edit_intent="restore", edit_target=raw, edit_confirmation="restore ring")
            result = direct("Let the paused ring finger move again.", infer)
            self.assertEqual(result["output"], "restore ring")
            self.assertEqual(result["trace"]["edit_target"], raw)
            self.assertEqual(result["trace"]["edit_target_source"], "edit_confirmation")
            self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_target", "edit_confirmation"])

    def test_unsupported_short_circuits_and_controls_have_a_bounded_extractor(self):
        infer = Inference(dispatch="unsupported")
        self.assertEqual(direct("Unsupported action", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch"])
        for command in ["unsupported", "reverse current", "hand left", "hand right", "hand other", "tempo_scale 0.25", "tempo_scale 4", "wave left", "wave right"]:
            infer = Inference(dispatch="control", edit_intent="none", current_control=command)
            self.assertEqual(direct("A visitor direction", infer)["output"], command)
            self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "current_control"])
        for command in ["", "body", "joint", "hand both", "wave both", "tempo_scale nan", "tempo_scale -1", "tempo_scale 0.249", "tempo_scale 4.1", "reverse", "hand left\njoint head x 40"]:
            with self.subTest(command=command), self.assertRaises(ValueError):
                direct("A visitor direction", Inference(dispatch="control", edit_intent="none", current_control=command))
        with self.assertRaisesRegex(ValueError, "Invalid motion scope"):
            direct("A motion", Inference(dispatch="motion", motion_scope="unsupported"))

    def test_pause_is_resolved_before_a_motion_scope_can_reset_the_joint(self):
        infer = Inference(dispatch="motion", edit_intent="freeze", edit_target="freeze both_knee")
        self.assertEqual(direct("Stop moving both knees", infer)["output"], "freeze both_knee")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_target"])

    def test_current_motion_edit_is_resolved_before_relative_control(self):
        infer = Inference(dispatch="control", edit_intent="freeze", edit_target="freeze ring")
        self.assertEqual(direct("Keep the wave going. Stop just the ring finger.", infer)["output"], "freeze ring")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_target"])

    def test_editor_scope_gate_rejects_explanations_without_touching_targets(self):
        infer = Inference(dispatch="edit", edit_intent="none")
        self.assertEqual(direct("Explain how to freeze a finger", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_fallback"])
        with self.assertRaisesRegex(ValueError, "Invalid motion edit intent"):
            direct("An edit", Inference(dispatch="edit", edit_intent="guessed"))

    def test_only_an_explicit_edit_domain_can_use_the_intent_fallback(self):
        infer = Inference(dispatch="edit", edit_intent="none", edit_fallback="freeze", edit_target="freeze hips")
        result = direct("Pause the torso", infer)
        self.assertEqual(result["output"], "freeze hips")
        self.assertEqual(result["trace"]["edit_intent"], "none")
        self.assertEqual(result["trace"]["edit_fallback"], "freeze")
        with self.assertRaisesRegex(ValueError, "Invalid motion edit intent"):
            direct("An edit", Inference(dispatch="edit", edit_intent="none", edit_fallback="guessed"))

    def test_new_thumb_motion_cannot_enter_edit_selector(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="left_thumb hold bend 45")
        result = direct("Could you move just your left thumb?", infer)
        self.assertEqual(result["output"], "joint left_thumb_1 z 45")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "joint_motion"])

    def test_skill_and_edit_abstentions_do_not_fall_through(self):
        infer = Inference(dispatch="dexterity", dexterity="legacy")
        self.assertEqual(direct("Roll a coin on your head", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.calls], ["playback_control", "activity_scope", "activity_confirmation", "dispatch", "dexterity"])
        infer = Inference(dispatch="edit", edit_intent="freeze", edit_target="none", edit_confirmation="none")
        self.assertEqual(direct("An unsupported edit", infer)["output"], "unsupported")
        with self.assertRaises(ValueError):
            direct("An invalid edit", Inference(dispatch="edit", edit_intent="freeze", edit_target="none", edit_confirmation="freeze everything"))

    def test_editor_tokens_cover_fingers_joints_and_selected_without_resolving_context(self):
        for target in ["selected", "hips", "spine_mid", "head", "elbow", "ring", "index_3", "right_ring", "both_thumb", "left_knee"]:
            for operation in ["freeze", "restore"]:
                self.assertEqual(validate_edit(f"{operation} {target}"), f"{operation} {target}")
        self.assertEqual(validate_edit("none"), "none")
        for prefix in ["", "left_", "right_", "both_"]:
            self.assertEqual(validate_edit(f"restore {prefix}foot"), f"restore {prefix}ankle")


if __name__ == "__main__":
    unittest.main()
