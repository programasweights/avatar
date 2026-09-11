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
    JOINTS, PROGRAMS, _load_function, direct, joint_commands, local_infer,
    transform_command, validate_body, validate_dexterity, validate_edit, validate_follow_up, validate_actions, validate_dance_extension,
)
from paw_worker import serve


def setUpModule():
    global _focused_programs
    _focused_programs = patch.dict(PROGRAMS, {
        name: PROGRAMS.get(name, f"test-{name}") for name in ("body_sway", "request_intent", "motion_language", "extension_scope", "action_gesture", "language_scope", "motion_translation", "meaning_scope")
    })
    _focused_programs.start()


def tearDownModule():
    _focused_programs.stop()


class Inference:
    def __init__(self, **outputs):
        self.outputs = {"meaning_scope": "clarify" if "motion_language" in outputs else "keep", "language_scope": "english", "sequence": "single", "extension_scope": "none", "body_sway": "none", "request_intent": "command", "leg_control": "none", "leg_scope": "yes", "action_intent": "none", "arm_control": "none", "playback_control": "none", "dance_extension": "none", "dance_confirmation": "yes" if outputs.get("dance_extension", "none") != "none" else "no", "dance_fallback": "none", "activity_scope": "other", "activity_confirmation": "basic" if outputs.get("activity_scope") == "basic" else "other", "action_composition": "unsupported", "edit_intent": "none", "edit_fallback": "none", "current_control": "unsupported", **outputs}
        self.calls = []

    @property
    def atomic_calls(self):
        """Isolate the original expert graph; calls retains every gate call."""
        return [call for call in self.calls if call[0] not in {"sequence", "leg_control", "action_intent", "arm_control", "body_sway", "request_intent", "motion_language", "extension_scope", "action_gesture", "language_scope", "motion_translation", "meaning_scope"}]

    def __call__(self, program_id, text):
        name = next(name for name, pid in PROGRAMS.items() if pid == program_id)
        self.calls.append((name, text))
        if name == "motion_language" and name not in self.outputs:
            return "unchanged"
        output = self.outputs[name]
        return output(text) if callable(output) else output


class MotionAssertions(unittest.TestCase):
    def assertRejected(self, result, pattern=None):
        self.assertEqual(result["output"], "unsupported")
        self.assertEqual(result["trace"]["route"], "unsupported")
        self.assertTrue(result["trace"]["validation_error"])
        if pattern is not None:
            self.assertRegex(result["trace"]["validation_error"], pattern)


class DirectorTest(MotionAssertions):

    def test_recognized_arm_edit_never_calls_a_conflicting_leg_gate(self):
        cases = [
            ("Let the left arm swing naturally.", "arm left natural", "restore left_leg"),
            ("Make both arms robotic.", "arms robot", "freeze both_legs"),
            ("Wave your right arm.", "arm right wave", "restore right_leg"),
            ("Keep your arms still while dancing.", "arms still", "freeze both_legs"),
        ]
        for instruction, arm, wrong_leg in cases:
            with self.subTest(instruction=instruction):
                infer = Inference(arm_control=arm, leg_control=wrong_leg)
                result = direct(instruction, infer)
                self.assertEqual(result["output"], arm)
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'arm_control'])
                self.assertNotIn("leg_control", result["trace"])

    def test_confirmed_body_action_never_calls_a_conflicting_leg_gate(self):
        for intent, action in [("single", "action kneel 1\narms still"), ("combined", "action walk_wave 1")]:
            with self.subTest(intent=intent):
                infer = Inference(action_intent=intent, activity_scope="basic", action=action,
                                  arm_control="arms still", leg_control="freeze both_legs")
                result = direct("Perform a new whole-body action.", infer)
                self.assertEqual(result["output"], action)
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'activity_scope', 'action'])
                self.assertNotIn("leg_control", result["trace"])

    def test_leg_controls_after_arm_abstention_only_defer_restore_until_dance_abstains(self):
        for instruction, leg in [("Stop leg movements.", "freeze both_legs"), ("Resume the footwork.", "restore both_legs")]:
            with self.subTest(instruction=instruction):
                infer = Inference(leg_control=leg)
                result = direct(instruction, infer)
                self.assertEqual(result["output"], leg)
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'arm_control', 'leg_control', 'leg_scope', *(['dance_extension', 'dance_confirmation'] if leg.startswith('restore ') else [])])
                self.assertEqual(result["trace"]["route"], "edit")
                self.assertNotIn("activity_scope", result["trace"])

    def test_confirmed_support_edit_takes_priority_over_an_ambiguous_leg_restore(self):
        for outputs in [
            {"dance_extension": "support both", "dance_confirmation": "yes"},
            {"dance_extension": "none", "dance_confirmation": "yes", "dance_fallback": "support both"},
        ]:
            with self.subTest(outputs=outputs):
                infer = Inference(leg_control="restore both_legs", leg_scope="yes", **outputs)
                result = direct("Both feet again.", infer)
                self.assertEqual(result["output"], "support both")
                self.assertEqual(result["trace"]["route"], "control")
                self.assertEqual(result["trace"]["leg_control"], "restore both_legs")
                self.assertEqual(result["trace"]["leg_scope"], "yes")
                self.assertNotIn("activity_scope", result["trace"])
        infer = Inference(leg_control="restore both_legs", dance_extension="support both", dance_confirmation="no")
        self.assertEqual(direct("Resume the footwork.", infer)["output"], "restore both_legs")

    def test_explicit_leg_freeze_precedes_an_incorrect_dance_support_prediction(self):
        for instruction, leg in [("Keep your right leg still.", "freeze right_leg"), ("Hold both feet where they are.", "freeze both_legs")]:
            with self.subTest(instruction=instruction):
                infer = Inference(leg_control=leg, leg_scope="yes", dance_extension="support both", dance_confirmation="yes")
                result = direct(instruction, infer)
                self.assertEqual(result["output"], leg)
                self.assertEqual(result["trace"]["route"], "edit")
                self.assertNotIn("dance_extension", result["trace"])

    def test_rejected_leg_anatomy_leaves_global_torso_and_selected_part_routes_intact(self):
        cases = [
            ("Stop dancing.", "freeze both_legs", {"dispatch": "motion", "motion_scope": "body", "body": "dance idle"}, "dance idle"),
            ("Pause the torso.", "freeze both_legs", {"dispatch": "edit", "edit_fallback": "freeze", "edit_target": "freeze hips"}, "freeze hips"),
            ("Let it move again.", "restore both_legs", {"dispatch": "edit", "edit_intent": "restore", "edit_target": "restore selected"}, "restore selected"),
            ("Resume the right ring finger.", "restore right_leg", {"dispatch": "edit", "edit_intent": "restore", "edit_target": "restore right_ring"}, "restore right_ring"),
        ]
        for instruction, leg, outputs, expected in cases:
            with self.subTest(instruction=instruction):
                infer = Inference(leg_control=leg, leg_scope="no", **outputs)
                result = direct(instruction, infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"]["leg_scope"], "no")
                self.assertEqual([name for name, _ in infer.calls].count("leg_scope"), 1)
                self.assertIn("dispatch", result["trace"])

    def test_invalid_leg_anatomy_response_rejects_before_any_downstream_motion(self):
        for raw in ["", "none", "true", "unsupported", "yes\nno"]:
            with self.subTest(raw=raw):
                infer = Inference(leg_control="restore both_legs", leg_scope=raw)
                self.assertRejected(direct('Resume the footwork.', infer), 'Invalid leg anatomy scope')
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'arm_control', 'leg_control', 'leg_scope'])

    def test_unconfirmed_new_action_candidate_preserves_arm_hand_and_coin_routes_without_repeat_classification(self):
        cases = [
            ("Use relaxed swinging movements for the left arm.", {"arm_control": "arm left natural"}, "arm left natural"),
            ("Roll a coin across your knuckles.", {"dispatch": "dexterity", "dexterity": "skill coin_roll left forward"}, "skill coin_roll left forward"),
            ("Wave hello with the right hand.", {"dispatch": "control", "current_control": "wave right"}, "wave right"),
            ("Send a wave across the arms.", {"dispatch": "dexterity", "dexterity": "skill arm_wave left forward"}, "skill arm_wave left forward"),
            ("Make the coin roll faster.", {"dispatch": "control", "current_control": "tempo_scale 1.25"}, "tempo_scale 1.25"),
        ]
        for instruction, outputs, expected in cases:
            with self.subTest(instruction=instruction):
                infer = Inference(action_intent="combined", activity_scope="other", activity_confirmation="other", **outputs)
                result = direct(instruction, infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"]["action_intent"], "combined")
                calls = [name for name, _ in infer.calls]
                self.assertEqual(calls.count("activity_scope"), 1)
                self.assertEqual(calls.count("activity_confirmation"), 1)
                self.assertLessEqual(calls.count("current_control"), 1)
                self.assertLess(calls.index("activity_confirmation"), calls.index("arm_control"))
                self.assertNotIn("action", calls)
                self.assertNotIn("action_composition", calls)

    def test_fallback_confirmation_of_new_action_checks_current_motion_control_before_promotion(self):
        for control, action, expected in [
            ("unsupported", "action kneel 1\narms still", "action kneel 1\narms still"),
            ("unsupported", "unsupported", "unsupported"),
            ("tempo_scale 2", "action run_wave 2", "tempo_scale 2"),
            ("reverse current", "action run 1", "reverse current"),
        ]:
            with self.subTest(control=control, action=action):
                infer = Inference(action_intent="single", activity_scope="other", activity_confirmation="basic",
                                  current_control=control, action=action, action_composition="action lie_down 1")
                result = direct("A candidate new action or relative edit.", infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'activity_scope', 'activity_confirmation', 'current_control', *(['action'] if control == 'unsupported' else [])])
                self.assertNotIn("action_composition", result["trace"])

    def test_invalid_lazy_activity_or_control_response_cannot_execute_an_action(self):
        for outputs, error in [
            ({"activity_scope": "unknown"}, "Invalid activity scope"),
            ({"activity_scope": "other", "activity_confirmation": "unknown"}, "Invalid activity confirmation"),
            ({"activity_scope": "other", "activity_confirmation": "basic", "current_control": "tempo_scale 0"}, "Invalid motion route or current-motion control"),
        ]:
            with self.subTest(outputs=outputs):
                infer = Inference(action_intent="single", **outputs)
                self.assertRejected(direct('A candidate body action.', infer), error)
                self.assertNotIn("action", [name for name, _ in infer.calls])
                self.assertNotIn("arm_control", [name for name, _ in infer.calls])

    def test_single_new_action_preserves_its_arm_constraint_before_arm_or_dance_gates(self):
        infer = Inference(action_intent="single", activity_scope="basic", action="action kneel 1\narms still",
                          arm_control="arms still", dance_extension="support left")
        result = direct("Kneel down while keeping both arms still.", infer)
        self.assertEqual(result, {"output": "action kneel 1\narms still", "trace": {
            "meaning_scope": "keep", "normalized_instruction": "Kneel down while keeping both arms still.", "language_scope": "english", "request_intent": "command", "extension_scope": "none", "sequence": "single", "playback_control": "none",
            "action_intent": "single", "activity_scope": "basic",  "action": "action kneel 1\narms still", "route": "action",
        }})
        self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'activity_scope', 'action'])

    def test_single_action_abstention_never_falls_back_to_a_different_posture(self):
        for raw in ["unsupported", "action lie_prone 1", "action lie_down 0"]:
            with self.subTest(raw=raw):
                infer = Inference(action_intent="single", activity_scope="basic", action=raw, action_composition="action lie_down 1")
                result = direct("Lie face down on your stomach.", infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["action"], raw)
                self.assertEqual(result["trace"]["route"], "unsupported")
                self.assertNotIn("action_composition", [name for name, _ in infer.calls])
                self.assertNotIn("arm_control", [name for name, _ in infer.calls])
                if raw != "unsupported":
                    self.assertTrue(result["trace"]["validation_error"])

    def test_only_combined_action_intent_uses_the_validated_composition_fallback(self):
        for primary, fallback, expected in [
            ("action walk_wave 1", "unsupported", "action walk_wave 1"),
            ("unsupported", "action walk_wave 1", "action walk_wave 1"),
            ("unsupported", "action run_wave 1\narms still", "unsupported"),
            ("unsupported", "unsupported", "unsupported"),
        ]:
            with self.subTest(primary=primary, fallback=fallback):
                infer = Inference(action_intent="combined", activity_scope="basic", action=primary, action_composition=fallback,
                                  arm_control="arm left wave")
                result = direct("Walk and wave.", infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'activity_scope', 'action', *(['action_composition'] if primary == 'unsupported' else [])])

    def test_no_new_action_intent_keeps_movie_support_and_existing_arm_joint_routes(self):
        cases = [
            ("Now on one foot.", {"dance_extension": "support left", "activity_scope": "basic", "activity_confirmation": "basic", "action": "action jump 1 left"}, "support left"),
            ("Switch to the opposite foot.", {"dance_extension": "support other"}, "support other"),
            ("Keep the dance and lower your arm.", {"arm_control": "arm right still"}, "arm right still"),
            ("Bend the left knee.", {"dispatch": "motion", "motion_scope": "joint", "joint_motion": "left_knee hold bend 30"}, "joint left_knee x 30"),
        ]
        for instruction, outputs, expected in cases:
            with self.subTest(instruction=instruction):
                infer = Inference(action_intent="none", **outputs)
                result = direct(instruction, infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"]["action_intent"], "none")
                self.assertNotIn("action", [name for name, _ in infer.calls])
                if instruction in {"Now on one foot.", "Switch to the opposite foot."}:
                    self.assertNotIn("activity_scope", [name for name, _ in infer.calls])
                    self.assertNotIn("activity_confirmation", [name for name, _ in infer.calls])

    def test_invalid_action_intent_stops_before_any_motion_interpreter(self):
        for raw in ["", "basic", "unsupported", "single action", "combined\nsingle"]:
            with self.subTest(raw=raw):
                infer = Inference(action_intent=raw)
                self.assertRejected(direct('A new motion.', infer), 'Invalid new-action intent')
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent'])

    def test_leg_freeze_and_restore_confirm_anatomy_before_returning_validated_edits(self):
        for operation in ["freeze", "restore"]:
            for target in ["left_leg", "right_leg", "both_legs", "leg"]:
                command = f"{operation} {target}"
                with self.subTest(command=command):
                    infer = Inference(leg_control=command)
                    result = direct("Change only the leg motion.", infer)
                    self.assertEqual(result, {"output": command, "trace": {
                        "meaning_scope": "keep", "normalized_instruction": "Change only the leg motion.", "language_scope": "english", "request_intent": "command", "extension_scope": "none", "sequence": "single", "playback_control": "none", "action_intent": "none",
                        "arm_control": "none", "leg_control": command, "leg_scope": "yes", "route": "edit",
                        **({"dance_extension": "none", "dance_confirmation": "no"} if operation == "restore" else {}),
                    }})
                    self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'arm_control', 'leg_control', 'leg_scope', *(['dance_extension', 'dance_confirmation'] if operation == 'restore' else [])])

    def test_malformed_leg_gate_cannot_run_partial_or_unrelated_commands(self):
        for raw in ["", "unsupported", "freeze both", "freeze left_arm", "restore left_ankle",
                    "freeze\tleft_leg", "freeze left_leg extra", "freeze left_leg\nrestore right_leg"]:
            with self.subTest(raw=raw):
                infer = Inference(leg_control=raw)
                self.assertRejected(direct('Freeze a leg.', infer), 'Invalid leg motion control')
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'arm_control', 'leg_control'])

    def test_full_overhead_reach_expands_only_the_selected_arm_and_keeps_real_trace(self):
        for target, command in [
            ("left_shoulder", "arm left still\njoint left_shoulder z 180"),
            ("right_shoulder", "arm right still\njoint right_shoulder z -180"),
            ("both_shoulder", "arm left still\njoint left_shoulder z 180\narm right still\njoint right_shoulder z -180"),
        ]:
            with self.subTest(target=target):
                raw = f"{target} hold overhead 180"
                infer = Inference(dispatch="motion", motion_scope="joint", joint_motion=raw)
                result = direct("Raise the arm all the way overhead.", infer)
                self.assertEqual(result["output"], command)
                self.assertEqual(result["trace"]["joint_motion"], raw)
                self.assertEqual(result["trace"]["joint"], target)
                self.assertEqual(result["trace"]["transform"], "hold overhead 180")
                self.assertEqual(result["trace"]["route"], "joint")
                self.assertEqual(infer.calls[-1][0], "joint_motion")

    def test_overhead_reach_rejects_other_joints_modes_angles_and_preserves_numeric_raises(self):
        for target, transform in [
            ("left_clavicle", "hold overhead 180"), ("left_hip", "hold overhead 180"),
            ("head", "hold overhead 180"), ("right_wrist", "hold overhead 180"),
            ("left_shoulder", "wave overhead 180"), ("left_shoulder", "hold overhead 45"),
            ("right_shoulder", "hold overhead -180"), ("both_shoulder", "hold overhead 0"),
        ]:
            with self.subTest(target=target, transform=transform), self.assertRaisesRegex(ValueError, "overhead reach"):
                joint_commands(target, transform)
        self.assertEqual(joint_commands("both_shoulder", "hold raise 45"),
                         "joint left_shoulder z 45\njoint right_shoulder z -45")
        self.assertEqual(transform_command("left_shoulder", "hold z 45"), "joint left_shoulder z 45")

    def test_new_body_actions_keep_counts_and_optional_still_arms(self):
        for action in ["kneel", "lie_down", "sway", "side_kick_left", "side_kick_right"]:
            for count in [1, 8]:
                command = f"action {action} {count}\narms still"
                with self.subTest(command=command):
                    infer = Inference(activity_scope="basic", action=command)
                    result = direct("A body action with arms held still.", infer)
                    self.assertEqual(result["output"], command)
                    self.assertEqual(result["trace"]["route"], "action")
                    self.assertEqual(result["trace"]["action"], command)

    def test_new_action_support_and_count_validation_cannot_execute_partial_programs(self):
        invalid = [f"action {action} {count}" for action in ["kneel", "lie_down", "sway", "side_kick_left", "side_kick_right"]
                   for count in ["0", "9", "1.5"]]
        invalid += [f"action {action} 1 {support}" for action in ["kneel", "lie_down", "sway", "side_kick_left", "side_kick_right"]
                    for support in ["left", "right", "both"]]
        invalid += ["action kneel 8\naction side_kick_right 8\naction lie_down 1"]
        for raw in invalid:
            with self.subTest(raw=raw):
                result = direct("A bounded body action.", Inference(activity_scope="basic", action=raw))
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["route"], "unsupported")
                self.assertTrue(result["trace"]["validation_error"])
        self.assertEqual(validate_actions("action side_kick_left 8\naction side_kick_right 8"),
                         "action side_kick_left 8\naction side_kick_right 8")

    def test_playback_short_circuits_without_selecting_or_rebuilding_a_motion(self):
        for command in ["playback pause", "playback resume", "playback restart"]:
            with self.subTest(command=command):
                infer = Inference(playback_control=command.removeprefix("playback "))
                result = direct("A global playback direction", infer)
                self.assertEqual(result, {"output": command, "trace": {
                    "meaning_scope": "keep", "normalized_instruction": "A global playback direction", "language_scope": "english", "request_intent": "command", "extension_scope": "none", "sequence": "single", "playback_control": command.removeprefix("playback "), "route": "playback"}})
                self.assertEqual(infer.atomic_calls, [("playback_control", "A global playback direction")])

    def test_invalid_playback_output_is_rejected_before_other_models_run(self):
        for output in ["playback pause", "unsupported", "playback reset", "playback pause\njoint head x 10"]:
            with self.subTest(output=output):
                infer = Inference(playback_control=output)
                self.assertRejected(direct('A direction', infer), 'Invalid playback control')
                self.assertEqual(len(infer.atomic_calls), 1)

    def test_dance_start_and_support_edits_have_distinct_commands(self):
        for command in ["dance gangnam", "dance gangnam\nsupport right", "dance gangnam\nsupport left\ntempo 132", "support left", "support right", "support both", "support other", "support left\ntempo 100"]:
            with self.subTest(command=command):
                infer = Inference(dance_extension=command)
                result = direct("A Gangnam or support-foot direction", infer)
                self.assertEqual(result["output"], command)
                self.assertEqual(result["trace"]["route"], "body" if command.startswith("dance ") else "control")
                self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation"])

    def test_invalid_dance_extensions_never_run_partial_commands(self):
        for command in ["", "support center", "support left\nsupport right", "support left\ndance gangnam", "dance gangnam\nsupport other", "dance salsa", "tempo 120", "dance gangnam\ntempo 500", "dance gangnam\ntempo 120\nsupport left", "dance gangnam\njoint head x 10"]:
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    validate_dance_extension(command)
                result = direct("A malformed model response", Inference(dance_extension=command))
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["dance_extension"], command)
                self.assertTrue(result["trace"]["validation_error"])
        infer = Inference(dance_extension="unsupported")
        self.assertEqual(direct("An unsupported Gangnam combination", infer)["output"], "unsupported")
        self.assertEqual(len(infer.atomic_calls), 3)

    def test_dance_scope_rejection_preserves_existing_dances_and_actions(self):
        for candidate in ["dance gangnam", "unsupported", "support left"]:
            infer = Inference(dance_extension=candidate, dance_confirmation="no", activity_scope="dance", body_fallback="dance cha_cha")
            result = direct("Dance chacha", infer)
            self.assertEqual(result["output"], "dance cha_cha")
            self.assertEqual(result["trace"]["dance_extension"], candidate)
            self.assertEqual(result["trace"]["dance_confirmation"], "no")
        infer = Inference(dance_extension="unsupported", dance_confirmation="no", activity_scope="basic", action="action walk_wave 1")
        self.assertEqual(direct("Walk and wave", infer)["output"], "action walk_wave 1")
        self.assertRejected(direct('Dance Gangnam', Inference(dance_extension='dance gangnam', dance_confirmation='maybe')), 'Invalid dance domain confirmation')

    def test_confirmed_dance_abstention_uses_a_validated_fallback(self):
        for command in ["support left", "support right", "support other", "dance gangnam"]:
            with self.subTest(command=command):
                infer = Inference(dance_extension="none", dance_confirmation="yes", dance_fallback=command)
                result = direct("Go on one foot.", infer)
                self.assertEqual(result["output"], command)
                self.assertEqual(result["trace"]["dance_extension"], "none")
                self.assertEqual(result["trace"]["dance_confirmation"], "yes")
                self.assertEqual(result["trace"]["dance_fallback"], command)
                self.assertEqual(result["trace"]["route"], "body" if command.startswith("dance ") else "control")
                self.assertEqual([name for name, _ in infer.atomic_calls], [
                    "playback_control", "dance_extension", "dance_confirmation", "dance_fallback",
                ])

    def test_dance_fallback_abstention_and_domain_rejection_preserve_other_routes(self):
        for primary, confirmation, fallback, used_fallback in [
            ("none", "yes", "none", True),
            ("none", "no", "support left", False),
            ("support left", "no", "support right", False),
        ]:
            with self.subTest(primary=primary, confirmation=confirmation):
                infer = Inference(dance_extension=primary, dance_confirmation=confirmation, dance_fallback=fallback,
                                  dispatch="motion", motion_scope="joint", joint_motion="left_elbow hold x 30")
                result = direct("Bend the left elbow.", infer)
                self.assertEqual(result["output"], "joint left_elbow x 30")
                self.assertEqual("dance_fallback" in result["trace"], used_fallback)
                self.assertEqual([name for name, _ in infer.atomic_calls].count("dance_confirmation"), 1)

    def test_dance_fallback_cannot_execute_malformed_or_unsupported_commands(self):
        for raw in ["", "support center", "support left\njoint head x 30", "dance salsa", "unsupported"]:
            with self.subTest(raw=raw):
                infer = Inference(dance_extension="none", dance_confirmation="yes", dance_fallback=raw)
                result = direct("Go on one foot.", infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["route"], "unsupported")
                self.assertEqual(result["trace"]["dance_fallback"], raw)
                if raw != "unsupported":
                    self.assertTrue(result["trace"]["validation_error"])
                self.assertNotIn("action", [name for name, _ in infer.atomic_calls])

    def test_dance_fallback_does_not_override_an_explicit_primary_result_or_rejection(self):
        for primary, expected in [("support right", "support right"), ("unsupported", "unsupported"), ("support center", "unsupported")]:
            with self.subTest(primary=primary):
                infer = Inference(dance_extension=primary, dance_confirmation="yes", dance_fallback="support left")
                result = direct("A support direction.", infer)
                self.assertEqual(result["output"], expected)
                self.assertNotIn("dance_fallback", result["trace"])
                self.assertEqual([name for name, _ in infer.atomic_calls], [
                    "playback_control", "dance_extension", "dance_confirmation",
                ])

    def test_invalid_dance_confirmation_after_primary_abstention_stops_before_fallback(self):
        infer = Inference(dance_extension="none", dance_confirmation="maybe")
        self.assertRejected(direct('Go on one foot.', infer), 'Invalid dance domain confirmation')
        self.assertEqual(infer.atomic_calls[-1][0], "dance_confirmation")
        self.assertNotIn("dance_fallback", [name for name, _ in infer.atomic_calls])

    def test_relative_control_prevents_false_promotion_to_a_new_body_action(self):
        for instruction, command in [
            ("Make the arm wave twice as fast.", "tempo_scale 2"),
            ("Run this motion backward.", "reverse current"),
        ]:
            with self.subTest(instruction=instruction):
                infer = Inference(activity_scope="other", activity_confirmation="basic", current_control=command)
                result = direct(instruction, infer)
                self.assertEqual(result["output"], command)
                self.assertEqual(result["trace"]["route"], "control")
                self.assertEqual(result["trace"]["activity_scope"], "other")
                self.assertEqual(result["trace"]["activity_confirmation"], "basic")
                self.assertEqual(result["trace"]["current_control"], command)
                self.assertEqual([name for name, _ in infer.atomic_calls], [
                    "playback_control", "dance_extension", "dance_confirmation", "activity_scope",
                    "activity_confirmation", "current_control",
                ])

    def test_invalid_control_during_activity_promotion_cannot_start_an_action(self):
        for raw in ["none", "tempo_scale nan", "tempo_scale 2\naction run 2"]:
            with self.subTest(raw=raw):
                infer = Inference(activity_scope="other", activity_confirmation="basic", current_control=raw)
                self.assertRejected(direct('Make the arm wave twice as fast.', infer), 'Invalid motion route or current-motion control')
                self.assertEqual(infer.atomic_calls[-1][0], "current_control")
                self.assertNotIn("action", [name for name, _ in infer.atomic_calls])

    def test_basic_actions_preserve_counts_and_sequence_order(self):
        command = "action jump 2\naction bow 1"
        infer = Inference(activity_scope="basic", action=command)
        result = direct("Jump twice, then take a bow", infer)
        self.assertEqual(result["output"], command)
        self.assertEqual(result["trace"]["route"], "action")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "action"])
        infer = Inference(activity_scope="basic", action="unsupported")
        self.assertEqual(direct("Jump nine times", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "action", "activity_confirmation", "action_composition"])

    def test_scope_keeps_basic_actions_separate_from_joint_and_playback_edits(self):
        infer = Inference(activity_scope="basic", action="action sit 1")
        self.assertEqual(direct("Sit down", infer)["output"], "action sit 1")
        infer = Inference(activity_scope="dance", body_fallback="dance cha_cha")
        self.assertEqual(direct("Dance chacha", infer)["output"], "dance cha_cha")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "body_fallback"])
        self.assertRejected(direct('Some instruction', Inference(activity_scope='guessed')), 'Invalid activity scope')

    def test_action_abstention_checks_scope_before_coordinated_gaits(self):
        infer = Inference(activity_scope="basic", action="unsupported",
                          activity_confirmation="other", dispatch="control",
                          current_control="reverse current")
        self.assertEqual(direct("Run this motion backward", infer)["output"], "reverse current")
        self.assertNotIn("action_composition", [name for name, _ in infer.atomic_calls])
        infer = Inference(activity_scope="basic", action="unsupported",
                          action_composition="action walk_wave 1\naction bow 1")
        self.assertEqual(direct("Walk and wave then bow", infer)["output"], "action walk_wave 1\naction bow 1")
        self.assertEqual([name for name, _ in infer.atomic_calls],
                         ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "action", "activity_confirmation", "action_composition"])

    def test_confirmation_promotes_only_basic_actions_and_is_reused_after_abstention(self):
        for action, composition, expected in [
            ("action jump 1 left", "unsupported", "action jump 1 left"),
            ("unsupported", "action jump 2 right\narms still", "action jump 2 right\narms still"),
            ("unsupported", "unsupported", "unsupported"),
        ]:
            infer = Inference(activity_scope="other", activity_confirmation="basic",
                              action=action, action_composition=composition)
            self.assertEqual(direct("A constrained body action", infer)["output"], expected)
            calls = [name for name, _ in infer.atomic_calls]
            self.assertEqual(calls.count("activity_confirmation"), 1)
            self.assertEqual(calls.count("current_control"), 1)
            self.assertLess(calls.index("current_control"), calls.index("action"))
            self.assertNotIn("dispatch", calls)
            self.assertEqual("action_composition" in calls, action == "unsupported")

    def test_confirmation_dance_does_not_replace_a_joint_edit(self):
        infer = Inference(activity_scope="other", activity_confirmation="dance",
                          dispatch="motion", motion_scope="joint", joint_motion="right_wrist hold y 20")
        self.assertEqual(direct("Dance robot with the right wrist rotated around y 20 degrees", infer)["output"],
                         "joint right_wrist y 20")
        self.assertNotIn("body_fallback", [name for name, _ in infer.atomic_calls])

    def test_invalid_confirmation_fails_before_action_or_dispatch(self):
        for scope in ["other", "basic"]:
            infer = Inference(activity_scope=scope, action="unsupported", activity_confirmation="action jump 1")
            self.assertRejected(direct('A direction', infer), 'Invalid activity confirmation')
            self.assertNotIn("action_composition", [name for name, _ in infer.atomic_calls])
            self.assertNotIn("dispatch", [name for name, _ in infer.atomic_calls])

    def test_waving_gaits_reject_a_conflicting_still_arms_constraint(self):
        for gait in ["walk_wave", "run_wave"]:
            for commands in [f"action {gait} 1\narms still", f"arms still\naction {gait} 1",
                             f"action jump 1\narms still\naction {gait} 1"]:
                with self.subTest(commands=commands), self.assertRaisesRegex(ValueError, "waving gait"):
                    validate_actions(commands)

    def test_global_still_arms_canonicalizes_any_position_without_reordering_actions(self):
        actions = ["action jump 2 left", "action bow 1", "action sway 3", "action kick_right 1"]
        canonical = "\n".join([*actions, "arms still"])
        for position in range(len(actions) + 1):
            with self.subTest(position=position):
                raw = "\n".join([*actions[:position], "arms still", *actions[position:]])
                self.assertEqual(validate_actions(raw), canonical)
                result = direct("Keep both arms still throughout these actions.", Inference(activity_scope="basic", action=raw))
                self.assertEqual(result["output"], canonical)
                self.assertEqual(result["trace"]["action"], raw)
        self.assertEqual(validate_actions("\n".join(actions)), "\n".join(actions))

    def test_reordered_still_arms_cannot_hide_duplicates_missing_actions_or_limits(self):
        invalid = [
            "arms still", "arms still\narms still", "arms still\naction jump 1\narms still",
            "action jump 1\narms still\naction bow 1\narms still", "arms  still\naction jump 1",
            "arms still\naction jump 0", "arms still\naction jump 9", "arms still\naction jump 1.5",
            "arms still\naction jump 8\naction bow 8\naction sway 1",
            "arms still\n" + "\n".join(["action jump 1"] * 5),
        ]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                validate_actions(raw)
        self.assertEqual(validate_actions("arms still\naction jump 8\naction bow 8"),
                         "action jump 8\naction bow 8\narms still")

    def test_action_parameters_preserve_support_and_arm_constraints(self):
        for command in ["action kick_right 1\narms still", "action jump 2 left",
                        "action jump 1 right\naction jump 2 left\narms still",
                        "action jump 2 both", "action run 1\narms still"]:
            with self.subTest(command=command):
                infer = Inference(activity_scope="basic", action=command)
                self.assertEqual(direct("A parameterized body action", infer)["output"], command)
        for invalid in ["arms still", "action run 1 left", "action kick_right 1 right",
                        "action jump 1 center", "action jump 1 left extra",
                        "arms still extra\naction jump 1", "action jump 1\narms still\narms still"]:
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
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "joint_motion"])

    def test_mixed_motion_separates_body_and_joint_commands(self):
        text = "Stop dancing and curl the left index finger"
        infer = Inference(dispatch="motion", motion_scope="mixed", body="dance idle", joint_motion="left_index_1 hold bend 45")
        self.assertEqual(direct(text, infer)["output"], "dance idle\njoint left_index_1 z 45")
        self.assertEqual(infer.atomic_calls[-1], ("joint_motion", text))

    def test_mixed_preservation_and_bpm_use_body_expert_without_restarting_dance(self):
        infer = Inference(dispatch="motion", motion_scope="mixed", body="tempo 100", joint_motion="left_index_1 wave bend 35")
        result = direct("Keep dancing salsa at 100 BPM and wiggle the left index finger 35 degrees.", infer)
        self.assertEqual(result["output"], "tempo 100\nwiggle left_index_1 z 35")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "body", "joint_motion"])

    def test_body_specialists_only_resolve_abstention_without_switching_routes(self):
        infer = Inference(dispatch="motion", motion_scope="body", body="unsupported", body_fallback="unsupported")
        self.assertEqual(direct("Unrecognized motion", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "body", "body_fallback"])
        infer.outputs["body_fallback"] = "arms robot"
        self.assertEqual(direct("Use robotic arms", infer)["output"], "arms robot")
        invalid = Inference(dispatch="motion", motion_scope="body", body="dance imaginary")
        self.assertRejected(direct('Dance', invalid), 'Unsupported motion command')
        self.assertEqual([name for name, _ in invalid.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "body"])

    def test_combined_joint_output_preserves_paired_segments_and_validates_fields(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="both_index_2 hold bend 30")
        self.assertEqual(direct("Curl the second knuckle of both index fingers 30 degrees", infer)["output"], "joint left_index_2 z 30\njoint right_index_2 z -30")
        for invalid in ["both_index_4 hold bend 30", "both_head hold left 20", "head hold y nan", "head hold y 400", "head hold y 20 extra", "head hold\ny 20"]:
            with self.subTest(invalid=invalid):
                self.assertRejected(direct('A joint request', Inference(dispatch='motion', motion_scope='joint', joint_motion=invalid)))
        infer = Inference(dispatch="motion", motion_scope="mixed", body="dance salsa", joint_motion="unsupported")
        self.assertEqual(direct("An unsupported joint plus dance", infer)["output"], "unsupported")

    def test_shoulder_specialist_preserves_the_side_and_anatomical_joint(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="left_shoulder hold raise 18", joint="left_clavicle")
        result = direct("Shrug the left shoulder 18 degrees", infer)
        self.assertEqual(result["output"], "joint left_clavicle z 18")
        self.assertEqual(result["trace"]["joint_motion"], "left_shoulder hold raise 18")
        for target in ["right_clavicle", "left_wrist", "unsupported"]:
            with self.subTest(target=target):
                self.assertRejected(direct('Raise the left arm', Inference(dispatch='motion', motion_scope='joint', joint_motion='left_shoulder hold raise 18', joint=target)), 'Shoulder refinement')

    def test_explicit_shoulder_axis_does_not_enter_anatomical_raise_refinement(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="left_shoulder hold x -27")
        self.assertEqual(direct("Rotate the left shoulder on x to -27 degrees", infer)["output"], "joint left_shoulder x -27")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "joint_motion"])

    def test_dexterity_skips_unrelated_functions(self):
        for skill in ["finger_ripple", "finger_touches", "arm_wave", "coin_roll"]:
            for side in ["left", "right"]:
                for direction in ["forward", "reverse"]:
                    command = f"skill {skill} {side} {direction}"
                    infer = Inference(dispatch="dexterity", dexterity=command)
                    result = direct("An instruction", infer)
                    self.assertEqual(result["output"], command)
                    self.assertEqual(result["trace"], {"meaning_scope": "keep", "normalized_instruction": "An instruction", "language_scope": "english", "extension_scope": "none", "sequence": "single", "playback_control": "none", "leg_control": "none", "action_intent": "none", "arm_control": "none", "dance_extension": "none", "dance_confirmation": "no", "activity_scope": "other", "activity_confirmation": "other", "request_intent": "command", "dispatch": "dexterity", "current_control": "unsupported", "dexterity": command, "route": "dexterity"})
                    self.assertEqual(len(infer.atomic_calls), 8)

    def test_named_skill_speed_edits_control_the_current_motion_without_creating_a_skill(self):
        for instruction, command in [
            ("Make the coin roll faster.", "tempo_scale 1.25"),
            ("Slow down the finger ripple.", "tempo_scale 0.8"),
            ("Do the fingertip touches at half speed.", "tempo_scale 0.5"),
            ("Make the arm wave twice as fast.", "tempo_scale 2"),
        ]:
            with self.subTest(instruction=instruction):
                infer = Inference(dispatch="dexterity", current_control=command)
                result = direct(instruction, infer)
                self.assertEqual(result["output"], command)
                self.assertEqual(result["trace"]["dispatch"], "dexterity")
                self.assertEqual(result["trace"]["route"], "control")
                self.assertEqual(result["trace"]["current_control"], command)
                self.assertEqual([name for name, _ in infer.atomic_calls], [
                    "playback_control", "dance_extension", "dance_confirmation", "activity_scope",
                    "activity_confirmation", "dispatch", "current_control",
                ])
                self.assertNotIn("dexterity", result["trace"])

    def test_named_skill_control_abstention_preserves_new_skills_and_declines_unknown_tricks(self):
        for instruction, skill, expected in [
            ("Roll a coin across your right knuckles.", "skill coin_roll right forward", "skill coin_roll right forward"),
            ("Reverse the left finger ripple.", "skill finger_ripple left reverse", "skill finger_ripple left reverse"),
            ("Flip a coin faster.", "legacy", "unsupported"),
        ]:
            with self.subTest(instruction=instruction):
                infer = Inference(dispatch="dexterity", current_control="unsupported", dexterity=skill)
                result = direct(instruction, infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"]["route"], "unsupported" if expected == "unsupported" else "dexterity")
                self.assertEqual(infer.atomic_calls[-2:], [("current_control", instruction), ("dexterity", instruction)])
                self.assertEqual(result["trace"]["current_control"], "unsupported")
                self.assertEqual(result["trace"]["dexterity"], skill)

    def test_invalid_named_skill_control_fails_before_creating_a_skill(self):
        for command in ["", "tempo_scale nan", "tempo_scale 0", "tempo_scale 4.1", "tempo_scale 2\nhand other", "skill coin_roll left forward"]:
            with self.subTest(command=command):
                infer = Inference(dispatch="dexterity", current_control=command)
                self.assertRejected(direct('Make the coin roll faster.', infer), 'Invalid motion route or current-motion control')
                self.assertEqual(infer.atomic_calls[-1][0], "current_control")
                self.assertNotIn("dexterity", [name for name, _ in infer.atomic_calls])

    def test_invalid_skill_does_not_fall_through_or_guess(self):
        for raw in ["", "unsupported", "finger_ripple left forward", "skill imaginary left forward", "skill coin_roll both forward", "skill coin_roll right fast", "skill coin_roll right forward 90", "skill coin_roll right forward\ndance salsa", "skill\ncoin_roll right forward", "legacy\nskill coin_roll left forward"]:
            infer = Inference(dispatch="dexterity", dexterity=raw)
            with self.subTest(raw=raw):
                self.assertRejected(direct('Roll a coin', infer), 'Invalid dexterity')
            self.assertEqual(len(infer.atomic_calls), 8)

    def test_input_and_output_types_are_bounded_before_execution(self):
        for instruction in [None, [], "", "  ", "x" * 401]:
            infer = Inference()
            with self.subTest(instruction=instruction), self.assertRaises(ValueError):
                direct(instruction, infer)
            self.assertEqual(infer.calls, [])
        with self.assertRaisesRegex(ValueError, "non-text"):
            direct("Roll a coin", lambda *_: None)
        self.assertRejected(direct('An instruction', Inference(dispatch='guessed')), 'Invalid motion route')

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


class ExtensionPipelineTest(MotionAssertions):
    def test_whole_request_intent_precedes_the_splitter_and_all_motion_models(self):
        for label in ["other", "unknown", "command\nother", ""]:
            with self.subTest(label=label):
                infer = Inference(request_intent=label, playback_control="pause", extension_scope="gesture")
                result = direct("A valid user input.", infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["request_intent"], label)
                self.assertEqual(infer.calls, [("request_intent", "A valid user input.")])
                self.assertNotIn("sequence", result["trace"])
                if label != "other":
                    self.assertRejected(result, "Invalid motion request intent")

    def test_neutral_scope_selects_one_bounded_extension_without_old_action_routing(self):
        for scope, expert, raw, expected in [
            ("sway", "body_sway", "action sway 8", "action sway 8"),
            ("sway", "body_sway", "arms still\naction sway 2", "action sway 2\narms still"),
            ("gesture", "action_gesture", "action clap 2", "action clap 2"),
            ("gesture", "action_gesture", "action punch_left 1", "action punch_left 1"),
            ("gesture", "action_gesture", "action punch_right 8", "action punch_right 8"),
        ]:
            with self.subTest(scope=scope, raw=raw):
                infer = Inference(extension_scope=scope, **{expert: raw}, action="action side_kick_right 1")
                result = direct("Perform an extension motion.", infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"], {
                    "meaning_scope": "keep", "normalized_instruction": "Perform an extension motion.",
                    "request_intent": "command", "language_scope": "english", "sequence": "single", "extension_scope": scope,
                    expert: raw, "route": "action",
                })
                self.assertEqual([name for name, _ in infer.calls], ["request_intent", "language_scope", "meaning_scope", "sequence", "extension_scope", expert])

    def test_none_scope_preserves_original_posture_support_and_playback_routes(self):
        for outputs, expected in [
            ({"action_intent": "single", "activity_scope": "basic", "action": "action jump 8"}, "action jump 8"),
            ({"activity_scope": "basic", "action": "action kneel 1"}, "action kneel 1"),
            ({"dance_extension": "support left"}, "support left"),
            ({"playback_control": "pause"}, "playback pause"),
        ]:
            with self.subTest(outputs=outputs):
                infer = Inference(extension_scope="none", body_sway="action sway 8", action_gesture="action clap 8", **outputs)
                result = direct("An established direction.", infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"]["extension_scope"], "none")
                self.assertEqual([name for name, _ in infer.calls[:5]], ["request_intent", "language_scope", "meaning_scope", "sequence", "extension_scope"])
                self.assertNotIn("body_sway", result["trace"])
                self.assertNotIn("action_gesture", result["trace"])

    def test_selected_extension_abstention_never_falls_through_to_an_unrelated_action(self):
        for scope, expert in [("sway", "body_sway"), ("gesture", "action_gesture")]:
            infer = Inference(extension_scope=scope, **{expert: "unsupported"}, activity_scope="basic", action="action jump 1")
            result = direct("An unsupported variant of an extension.", infer)
            self.assertEqual(result["output"], "unsupported")
            self.assertEqual(result["trace"][expert], "unsupported")
            self.assertEqual(infer.calls[-1][0], expert)
            self.assertNotIn("activity_scope", result["trace"])

    def test_scope_and_detail_grammars_reject_wrong_domains_counts_and_multiple_actions(self):
        cases = [("invalid", None, None)]
        cases += [("sway", "body_sway", raw) for raw in ["none", "action kick_right 1", "action sway 0", "action sway 9", "action sway 1 left", "action sway 1\naction sway 1"]]
        cases += [("gesture", "action_gesture", raw) for raw in ["none", "action sway 1", "action clap 0", "action punch_left 9", "action punch_right 1\narms still", "action clap 1\naction clap 1"]]
        for scope, expert, raw in cases:
            with self.subTest(scope=scope, raw=raw):
                infer = Inference(extension_scope=scope, **({expert: raw} if expert else {}))
                result = direct("A valid motion request.", infer)
                self.assertRejected(result)
                self.assertEqual(result["trace"]["extension_scope"], scope)
                if expert:
                    self.assertEqual(result["trace"][expert], raw)
                self.assertEqual(infer.calls[-1][0], expert or "extension_scope")

    def test_pipeline_stages_preserve_non_text_and_provider_errors(self):
        for gate, context in [("request_intent", {}), ("extension_scope", {}),
                              ("body_sway", {"extension_scope": "sway"}), ("action_gesture", {"extension_scope": "gesture"})]:
            for failure in [None, ValueError("Provider JSON invalid"), ConnectionError("Provider disconnected")]:
                with self.subTest(gate=gate, failure=failure):
                    fake = Inference(**context, **{gate: failure})
                    def infer(program_id, text):
                        output = fake(program_id, text)
                        if isinstance(output, Exception):
                            raise output
                        return output
                    with self.assertRaises(type(failure) if isinstance(failure, Exception) else ValueError):
                        direct("A motion request.", infer)
                    self.assertEqual(fake.calls[-1][0], gate)


class ModelOutputRejectionTest(MotionAssertions):
    def test_invalid_joint_grammar_is_a_rejection_with_original_trace_in_either_language(self):
        for original, normalized in [("Make a fist.", None), ("握拳", "Make a fist.")]:
            for raw, error in [("left_wrist hold fist 45", "Unknown transform: fist"),
                               ("left_wrist_99 hold x 45", "Unsupported joint selection")]:
                with self.subTest(original=original, raw=raw):
                    infer = Inference(**({"language_scope": "translate", "motion_translation": normalized} if normalized else {}), dispatch="motion", motion_scope="joint", joint_motion=raw)
                    result = direct(original, infer)
                    self.assertRejected(result, error)
                    self.assertEqual(result["trace"]["joint_motion"], raw)
                    self.assertEqual(result["trace"]["joint"], raw.split()[0])
                    self.assertEqual(result["trace"]["transform"], " ".join(raw.split()[1:]))
                    self.assertEqual(infer.calls[-1], ("joint_motion", normalized or original))
                    if normalized:
                        self.assertEqual(result["trace"]["normalized_instruction"], normalized)
                        self.assertEqual(result["trace"]["motion_translation"], normalized)
                    else:
                        self.assertEqual(result["trace"]["normalized_instruction"], original)

    def test_late_non_text_and_provider_failures_remain_errors_in_either_language(self):
        for original in ["Move your wrist.", "转动手腕"]:
            for failure in [None, ValueError("Invalid provider JSON"), ConnectionError("Provider disconnected")]:
                with self.subTest(original=original, failure=failure):
                    fake = Inference(language_scope="english" if original == "Move your wrist." else "translate", motion_translation="Move your wrist.", dispatch="motion", motion_scope="joint", joint_motion=failure)
                    def infer(program_id, text):
                        output = fake(program_id, text)
                        if isinstance(output, Exception):
                            raise output
                        return output
                    expected = type(failure) if isinstance(failure, Exception) else ValueError
                    message = str(failure) if isinstance(failure, Exception) else "non-text"
                    with self.assertRaisesRegex(expected, message):
                        direct(original, infer)
                    self.assertEqual(fake.calls[-1][0], "joint_motion")


class MotionLanguageTest(unittest.TestCase):
    def test_original_questions_and_prohibitions_are_rejected_before_language_models(self):
        for original in ["抬左手是什么意思", "不要抬左脚", "What does raising the left arm mean?", "Do not lift your left foot."]:
            with self.subTest(original=original):
                infer = Inference(request_intent="other", language_scope="translate", motion_translation="Raise your left arm.")
                self.assertEqual(direct(original, infer), {"output": "unsupported", "trace": {"request_intent": "other", "route": "unsupported"}})
                self.assertEqual(infer.calls, [("request_intent", original)])

    def test_original_polite_requests_and_current_motion_constraints_retain_their_intent(self):
        for original, translated, outputs, expected in [
            ("可以抬一下左手吗", "Can you raise your left hand?", {"motion_language": "Can you raise your left arm?", "dispatch": "motion", "motion_scope": "joint", "joint_motion": "left_shoulder hold raise 45", "joint": "left_shoulder"}, "joint left_shoulder z 45"),
            ("双手不动，踢一下", "Kick once without moving your arms.", {"action_intent": "single", "activity_scope": "basic", "action": "action kick_right 1\narms still"}, "action kick_right 1\narms still"),
        ]:
            with self.subTest(original=original):
                infer = Inference(language_scope="translate", motion_translation=translated, **outputs)
                result = direct(original, infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(infer.calls[:4], [("request_intent", original), ("language_scope", original), ("motion_translation", original), ("meaning_scope", translated)])
                normalized = outputs.get("motion_language", translated)
                start = next(i for i, (name, _) in enumerate(infer.calls) if name == "sequence")
                self.assertTrue(all(text == normalized for _, text in infer.calls[start:]))

    def test_keep_preserves_english_text_exactly_and_never_calls_translation_or_generator(self):
        for original, outputs, expected in [
            ("slap yourself", {"dispatch": "unsupported"}, "unsupported"),
            ("  Unfreeze your left foot.  ", {"dispatch": "edit", "edit_intent": "restore", "edit_target": "restore left_ankle"}, "restore left_ankle"),
            ("Send a wave from left fingertips to right.", {"dispatch": "dexterity", "dexterity": "skill arm_wave left forward"}, "skill arm_wave left forward"),
            ("Go onto both knees.", {"activity_scope": "basic", "action": "action kneel 1"}, "action kneel 1"),
            ("Lift your left foot.", {"dance_extension": "support right"}, "support right"),
        ]:
            with self.subTest(original=original):
                infer = Inference(meaning_scope="keep", motion_language="Both feet again.", **outputs)
                result = direct(original, infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"]["meaning_scope"], "keep")
                self.assertNotIn("motion_language", result["trace"])
                self.assertEqual(result["trace"]["normalized_instruction"], original)
                self.assertTrue(all(text == original for _, text in infer.calls))
                self.assertNotIn("motion_translation", [name for name, _ in infer.calls])

    def test_keep_uses_translated_english_instead_of_the_original_non_english_text(self):
        for original in ["Остановись.", "止まれ。", "Arrete.", "Detente.", "停止", "\U00020000"]:
            with self.subTest(original=original):
                infer = Inference(language_scope="translate", motion_translation="Stop.", playback_control="pause")
                result = direct(original, infer)
                self.assertEqual(result["output"], "playback pause")
                self.assertEqual(result["trace"]["meaning_scope"], "keep")
                self.assertNotIn("motion_language", result["trace"])
                self.assertEqual(result["trace"]["motion_translation"], "Stop.")
                self.assertEqual(result["trace"]["normalized_instruction"], "Stop.")
                self.assertEqual(infer.calls[:4], [("request_intent", original), ("language_scope", original), ("motion_translation", original), ("meaning_scope", "Stop.")])
                self.assertTrue(all(text == "Stop." for _, text in infer.calls[3:]))

    def test_english_requests_use_the_shared_semantic_stage_before_the_original_experts(self):
        for instruction in ["Stop.", "Please stop—now.", "Stop at 45°."]:
            with self.subTest(instruction=instruction):
                infer = Inference(playback_control="pause")
                self.assertEqual(direct(instruction, infer), {"output": "playback pause", "trace": {
                    "request_intent": "command", "language_scope": "english", "meaning_scope": "keep",
                    "normalized_instruction": instruction, "extension_scope": "none", "sequence": "single", "playback_control": "pause", "route": "playback",
                }})
                self.assertEqual(infer.calls, [(name, instruction) for name in ["request_intent", "language_scope", "meaning_scope", "sequence", "extension_scope", "playback_control"]])

    def test_translated_and_english_anatomical_idioms_share_the_same_semantic_model_and_effects(self):
        pairs = [
            ("抬左手", "Raise your left hand.", "Raise your left arm.", {"dispatch": "motion", "motion_scope": "joint", "joint_motion": "left_shoulder hold raise 45", "joint": "left_shoulder"}, "joint left_shoulder z 45"),
            ("抬左脚", "Lift your left foot.", "unchanged", {"dance_extension": "support right"}, "support right"),
            ("放下右脚", "Lower your right foot.", "Both feet again.", {"dance_extension": "support both"}, "support both"),
            ("右脚尖抬高16度", "Point your right toes up 16 degrees.", "Flex your right ankle upward 16 degrees.", {"dispatch": "motion", "motion_scope": "joint", "joint_motion": "right_ankle hold up 16"}, "joint right_ankle x -16"),
            ("右手腕转30度", "Rotate your right wrist 30 degrees.", "unchanged", {"dispatch": "motion", "motion_scope": "joint", "joint_motion": "right_wrist hold y 30"}, "joint right_wrist y 30"),
            ("跳高", "Jump high.", "Jump.", {"activity_scope": "basic", "action": "action jump 1"}, "action jump 1"),
        ]
        for original, english, semantic, outputs, expected in pairs:
            with self.subTest(original=original):
                scope = "keep" if semantic == "unchanged" else "clarify"
                translated = Inference(language_scope="translate", motion_translation=english, meaning_scope=scope, motion_language=semantic, **outputs)
                native = Inference(meaning_scope=scope, motion_language=semantic, **outputs)
                translated_result, native_result = direct(original, translated), direct(english, native)
                self.assertEqual(translated_result["output"], expected)
                self.assertEqual(native_result["output"], expected)
                self.assertEqual(translated.calls[3:], native.calls[2:])
                self.assertEqual(translated_result["trace"]["normalized_instruction"], english if semantic == "unchanged" else semantic)

    def test_translation_preserves_model_side_angle_and_full_input_for_existing_router(self):
        cases = [
            ("抬左腿", "Lift your left leg.", "left_hip hold raise 45", "joint left_hip x -45"),
            ("抬起右腿60度", "Lift your right leg 60 degrees.", "right_hip hold raise 60", "joint right_hip x -60"),
            ("向左转头45度", "Turn your head left 45 degrees.", "head hold left 45", "joint head y 45"),
            ("向右轉頭45度", "Turn your head right 45°.", "head hold right 45", "joint head y -45"),
            ("Raise the 左 leg 30 degrees", "Raise the left leg 30 degrees.", "left_hip hold raise 30", "joint left_hip x -30"),
        ]
        for original, english, joint, expected in cases:
            with self.subTest(original=original):
                infer = Inference(language_scope="translate", motion_translation=english, dispatch="motion", motion_scope="joint", joint_motion=joint)
                result = direct(original, infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"]["motion_translation"], english)
                self.assertEqual(result["trace"]["normalized_instruction"], english)
                self.assertTrue(all(text == english for _, text in infer.calls[3:]))
                self.assertEqual([name for name, _ in infer.calls].count("meaning_scope"), 1)

    def test_keep_protects_established_posture_and_support_from_a_wrong_generator(self):
        for original, english, outputs, expected in [
            ("Lie down.", "Lie down.", {"activity_scope": "basic", "action": "action lie_down 1"}, "action lie_down 1"),
            ("躺下", "Lie down.", {"activity_scope": "basic", "action": "action lie_down 1"}, "action lie_down 1"),
            ("Stand only on your left foot.", "Stand only on your left foot.", {"dance_extension": "support left"}, "support left"),
            ("只用左脚站立", "Stand only on your left foot.", {"dance_extension": "support left"}, "support left"),
        ]:
            with self.subTest(original=original):
                infer = Inference(language_scope="english" if original == english else "translate",
                                  motion_translation=english, meaning_scope="keep", motion_language="Both feet again.", **outputs)
                result = direct(original, infer)
                self.assertEqual(result["output"], expected)
                self.assertEqual(result["trace"]["normalized_instruction"], english)
                self.assertNotIn("motion_language", result["trace"])
                self.assertNotIn("motion_language", [name for name, _ in infer.calls])

    def test_clarify_can_abstain_with_unchanged_without_regenerating_the_input(self):
        for original, english in [("  Lift your left foot.  ", "  Lift your left foot.  "), ("抬左脚", "Lift your left foot.")]:
            with self.subTest(original=original):
                infer = Inference(language_scope="english" if original == english else "translate", motion_translation=english,
                                  meaning_scope="clarify", motion_language="unchanged", dance_extension="support right")
                result = direct(original, infer)
                self.assertEqual(result["output"], "support right")
                self.assertEqual(result["trace"]["motion_language"], "unchanged")
                self.assertEqual(result["trace"]["normalized_instruction"], english)
                self.assertEqual([name for name, _ in infer.calls].count("motion_language"), 1)

    def test_invalid_meaning_scope_stops_before_generator_and_original_motion_experts(self):
        for scope in ["none", "english", "Keep", "keep\nclarify", "", "unsupported"]:
            with self.subTest(scope=scope):
                infer = Inference(meaning_scope=scope, motion_language="Jump.", activity_scope="basic", action="action jump 1")
                result = direct("A valid instruction.", infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["meaning_scope"], scope)
                self.assertIn("Invalid motion meaning scope", result["trace"]["validation_error"])
                self.assertEqual([name for name, _ in infer.calls], ["request_intent", "language_scope", "meaning_scope"])

    def test_language_scope_vocabulary_fails_closed_before_translation_or_semantics(self):
        for scope in ["none", "English", "english\ntranslate", "", "unsupported"]:
            with self.subTest(scope=scope):
                infer = Inference(language_scope=scope)
                result = direct("A valid request.", infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["language_scope"], scope)
                self.assertIn("Invalid motion language scope", result["trace"]["validation_error"])
                self.assertEqual([name for name, _ in infer.calls], ["request_intent", "language_scope"])

    def test_malformed_translation_and_semantic_output_never_reaches_motion_experts(self):
        invalid = ["", "  ", "x" * 401, "抬右腿", "Lift the 左 leg", "45°", "...", "Подними ногу", "Lift leg\nThen bow", "Lift\tleg", "Lift\x00leg", "Lift\u200bleg", "Liftひらがなleg"]
        for stage in ["motion_translation", "motion_language"]:
            for raw in invalid + (["unchanged"] if stage == "motion_translation" else []):
                with self.subTest(stage=stage, raw=raw):
                    context = {"language_scope": "translate"} if stage == "motion_translation" else {}
                    infer = Inference(**context, **{stage: raw})
                    result = direct("Move your left leg.", infer)
                    self.assertEqual(result["output"], "unsupported")
                    self.assertEqual(result["trace"][stage], raw.strip())
                    self.assertIn("validation_error", result["trace"])
                    self.assertEqual(infer.calls[-1][0], stage)
                    self.assertNotIn("sequence", result["trace"])

    def test_misclassified_non_latin_input_cannot_use_the_unchanged_sentinel_to_bypass_validation(self):
        for original in ["抬左手", "Подними левую руку", "左手を上げて", "왼손을 들어"]:
            with self.subTest(original=original):
                infer = Inference(language_scope="english", motion_language="unchanged")
                result = direct(original, infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["normalized_instruction"], original)
                self.assertIn("validation_error", result["trace"])
                self.assertEqual(infer.calls[-1][0], "motion_language")

    def test_language_stages_keep_non_text_and_provider_failures_as_errors(self):
        for stage in ["request_intent", "language_scope", "motion_translation", "meaning_scope", "motion_language"]:
            for error in [None, ValueError("Provider malformed response"), RuntimeError("Disconnected")]:
                with self.subTest(stage=stage, error=error):
                    fake = Inference(language_scope="translate", motion_translation="Stop.", meaning_scope="clarify", playback_control="pause")
                    def infer(program_id, text):
                        if program_id == PROGRAMS[stage]:
                            if isinstance(error, Exception):
                                raise error
                            return error
                        return fake(program_id, text)
                    with self.assertRaisesRegex(type(error) if isinstance(error, Exception) else ValueError, "Provider|Disconnected|non-text"):
                        direct("停止", infer)

    def test_abstention_and_downstream_rejection_preserve_the_completed_language_trace(self):
        for stage in ["motion_translation", "motion_language"]:
            infer = Inference(language_scope="translate", motion_translation="Move your left leg.", **({stage: "unsupported"} if stage == "motion_language" else {}))
            if stage == "motion_translation":
                infer.outputs[stage] = "unsupported"
            result = direct("抬左腿", infer)
            self.assertEqual(result["output"], "unsupported")
            self.assertEqual(result["trace"][stage], "unsupported")
            self.assertNotIn("validation_error", result["trace"])
            self.assertEqual(infer.calls[-1][0], stage)
        for outputs in [{"dispatch": "unsupported"}, {"arm_control": "arms invalid"}, {"sequence": "sequence"}]:
            infer = Inference(language_scope="translate", motion_translation="Lift your left leg.", **outputs)
            result = direct("抬左腿", infer)
            self.assertEqual(result["output"], "unsupported")
            self.assertEqual(result["trace"]["motion_translation"], "Lift your left leg.")
            self.assertEqual(result["trace"]["meaning_scope"], "keep")
            self.assertNotIn("motion_language", result["trace"])
            self.assertEqual(result["trace"]["normalized_instruction"], "Lift your left leg.")

    def test_translation_semantics_and_sequence_have_256_tokens_other_experts_keep_80(self):
        calls = []
        def function(text, **options):
            calls.append((text, options))
            return "an output"
        names = ["motion_translation", "motion_language", "sequence", "meaning_scope", "language_scope", "request_intent", "joint_motion"]
        with patch(f"{local_infer.__module__}._load_function", return_value=function):
            for name in names:
                self.assertEqual(local_infer(PROGRAMS[name], name), "an output")
        self.assertEqual(calls, [(name, {"temperature": 0, "max_tokens": 256 if name in {"motion_language", "motion_translation", "sequence"} else 80}) for name in names])

    def test_default_clone_path_loads_pinned_language_and_motion_experts_with_correct_budgets(self):
        infer = Inference(language_scope="translate", motion_translation="Lift your left leg 60 degrees.", dispatch="motion", motion_scope="joint", joint_motion="left_hip hold raise 60")
        loaded, options = [], []
        def load(program_id):
            loaded.append(program_id)
            def function(text, **kwargs):
                options.append(kwargs)
                return infer(program_id, text)
            return function
        with patch(f"{local_infer.__module__}._load_function", side_effect=load):
            result = direct("抬左腿60度")
        self.assertEqual(result["output"], "joint left_hip x -60")
        self.assertEqual(loaded[:5], [PROGRAMS[name] for name in ["request_intent", "language_scope", "motion_translation", "meaning_scope", "sequence"]])
        self.assertEqual(options, [{"temperature": 0, "max_tokens": 256 if name in {"motion_language", "motion_translation", "sequence"} else 80} for name, _ in infer.calls])


class WorkerTest(unittest.TestCase):
    def test_worker_preserves_chinese_normalization_and_recovers_for_following_english_request(self):
        infer = Inference(language_scope=lambda text: "translate" if text == "停止" else "english", motion_translation="Stop.", playback_control="pause")
        requests = [{"id": "chinese", "instruction": "停止"}, {"id": "english", "instruction": "Stop."}]
        output = io.StringIO()
        with patch.dict(PROGRAMS, {"motion_language": PROGRAMS.get("motion_language", "test-motion-language")}):
            serve(io.StringIO("\n".join(json.dumps(request) for request in requests)), output, infer)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(all(response["ok"] for response in responses))
        self.assertEqual(responses[0]["result"]["trace"]["normalized_instruction"], "Stop.")
        self.assertEqual(responses[1]["result"]["trace"]["normalized_instruction"], "Stop.")
        self.assertEqual([name for name, _ in infer.calls].count("meaning_scope"), 2)

    def test_worker_recovers_after_invalid_request_and_model_output(self):
        requests = ["invalid JSON", json.dumps({"id": "bad", "instruction": " "}), json.dumps({"id": "model", "instruction": "Bad model"}), json.dumps({"id": "valid", "instruction": "Ripple"})]
        calls = []
        def infer(pid, text):
            if pid == PROGRAMS["meaning_scope"]:
                return "keep"
            if pid == PROGRAMS["language_scope"]:
                return "english"
            if pid == PROGRAMS["motion_language"]:
                return "unchanged"
            if pid == PROGRAMS["sequence"]:
                return "single"
            if pid == PROGRAMS["request_intent"]:
                return "command"
            if pid in {PROGRAMS["body_sway"], PROGRAMS["extension_scope"]}:
                return "none"
            if pid in {PROGRAMS["action_intent"], PROGRAMS["leg_control"], PROGRAMS["arm_control"], PROGRAMS["playback_control"], PROGRAMS["dance_extension"], PROGRAMS["dance_fallback"]}:
                return "none"
            if pid == PROGRAMS["dance_confirmation"]:
                return "no"
            if pid in {PROGRAMS["activity_scope"], PROGRAMS["activity_confirmation"]}:
                return "other"
            if pid == PROGRAMS["dispatch"]:
                return "dexterity"
            if pid == PROGRAMS["current_control"]:
                return "unsupported"
            calls.append(text)
            return "invalid" if text == "Bad model" else "skill finger_ripple left forward"
        output = io.StringIO()
        serve(io.StringIO("\n".join(requests)), output, infer)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([r.get("status", 200) for r in responses], [400, 400, 200, 200])
        self.assertTrue(responses[2]["ok"])
        self.assertEqual(responses[2]["result"]["output"], "unsupported")
        self.assertEqual(responses[2]["result"]["trace"]["dexterity"], "invalid")
        self.assertIn("Invalid dexterity", responses[2]["result"]["trace"]["validation_error"])
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
                    if program_id == {PROGRAMS["meaning_scope"]!r}:
                        return lambda text, **kwargs: "keep"
                    if program_id == {PROGRAMS["language_scope"]!r}:
                        return lambda text, **kwargs: "english"
                    if program_id == {PROGRAMS["motion_language"]!r}:
                        return lambda text, **kwargs: "unchanged"
                    if program_id == {PROGRAMS["sequence"]!r}:
                        return lambda *args, **kwargs: "single"
                    if program_id == {PROGRAMS["request_intent"]!r}:
                        return lambda *args, **kwargs: "command"
                    if program_id in ({PROGRAMS["body_sway"]!r}, {PROGRAMS["extension_scope"]!r}):
                        return lambda *args, **kwargs: "none"
                    if program_id in ({PROGRAMS["action_intent"]!r}, {PROGRAMS["leg_control"]!r}, {PROGRAMS["arm_control"]!r}, {PROGRAMS["playback_control"]!r}, {PROGRAMS["dance_extension"]!r}, {PROGRAMS["dance_fallback"]!r}):
                        return lambda *args, **kwargs: "none"
                    if program_id == {PROGRAMS["dance_confirmation"]!r}:
                        return lambda *args, **kwargs: "no"
                    if program_id in ({PROGRAMS["activity_scope"]!r}, {PROGRAMS["activity_confirmation"]!r}):
                        return lambda *args, **kwargs: "other"
                    if program_id == {PROGRAMS["dispatch"]!r}:
                        return lambda *args, **kwargs: "dexterity"
                    if program_id == {PROGRAMS["current_control"]!r}:
                        return lambda *args, **kwargs: "unsupported"
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


class DispatchRoutingTest(MotionAssertions):
    def test_edit_target_is_sequential_and_short_circuits_actions(self):
        infer = Inference(dispatch="edit", edit_intent="freeze", edit_target="freeze ring")
        self.assertEqual(direct("Keep the wave going. Stop just the ring finger.", infer), {
            "output": "freeze ring",
            "trace": {"meaning_scope": "keep", "normalized_instruction": "Keep the wave going. Stop just the ring finger.", "language_scope": "english", "extension_scope": "none", "sequence": "single", "playback_control": "none", "leg_control": "none", "action_intent": "none", "arm_control": "none", "dance_extension": "none", "dance_confirmation": "no", "activity_scope": "other", "activity_confirmation": "other", "request_intent": "command", "dispatch": "edit", "edit_intent": "freeze", "edit_target": "freeze ring", "route": "edit"},
        })
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_target"])

    def test_dispatch_decides_operation_and_confirmation_repairs_only_invalid_target(self):
        infer = Inference(dispatch="edit", edit_intent="restore", edit_target="freeze right_index_2")
        self.assertEqual(direct("Resume that knuckle", infer)["output"], "restore right_index_2")
        for raw in ["restore paused", "none", "freeze\nring"]:
            infer = Inference(dispatch="edit", edit_intent="restore", edit_target=raw, edit_confirmation="restore ring")
            result = direct("Let the paused ring finger move again.", infer)
            self.assertEqual(result["output"], "restore ring")
            self.assertEqual(result["trace"]["edit_target"], raw)
            self.assertEqual(result["trace"]["edit_target_source"], "edit_confirmation")
            self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_target", "edit_confirmation"])

    def test_unsupported_short_circuits_and_controls_have_a_bounded_extractor(self):
        infer = Inference(dispatch="unsupported")
        self.assertEqual(direct("Unsupported action", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch"])
        for command in ["unsupported", "reverse current", "hand left", "hand right", "hand other", "tempo_scale 0.25", "tempo_scale 4", "wave left", "wave right"]:
            infer = Inference(dispatch="control", edit_intent="none", current_control=command)
            self.assertEqual(direct("A visitor direction", infer)["output"], command)
            self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "current_control"])
        for command in ["", "body", "joint", "hand both", "wave both", "tempo_scale nan", "tempo_scale -1", "tempo_scale 0.249", "tempo_scale 4.1", "reverse", "hand left\njoint head x 40"]:
            with self.subTest(command=command):
                self.assertRejected(direct('A visitor direction', Inference(dispatch='control', edit_intent='none', current_control=command)))
        self.assertRejected(direct('A motion', Inference(dispatch='motion', motion_scope='unsupported')), 'Invalid motion scope')

    def test_pause_is_resolved_before_a_motion_scope_can_reset_the_joint(self):
        infer = Inference(dispatch="motion", edit_intent="freeze", edit_target="freeze both_knee")
        self.assertEqual(direct("Stop moving both knees", infer)["output"], "freeze both_knee")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_target"])

    def test_current_motion_edit_is_resolved_before_relative_control(self):
        infer = Inference(dispatch="control", edit_intent="freeze", edit_target="freeze ring")
        self.assertEqual(direct("Keep the wave going. Stop just the ring finger.", infer)["output"], "freeze ring")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_target"])

    def test_editor_scope_gate_rejects_explanations_without_touching_targets(self):
        infer = Inference(dispatch="edit", edit_intent="none")
        self.assertEqual(direct("Explain how to freeze a finger", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "edit_fallback"])
        self.assertRejected(direct('An edit', Inference(dispatch='edit', edit_intent='guessed')), 'Invalid motion edit intent')

    def test_only_an_explicit_edit_domain_can_use_the_intent_fallback(self):
        infer = Inference(dispatch="edit", edit_intent="none", edit_fallback="freeze", edit_target="freeze hips")
        result = direct("Pause the torso", infer)
        self.assertEqual(result["output"], "freeze hips")
        self.assertEqual(result["trace"]["edit_intent"], "none")
        self.assertEqual(result["trace"]["edit_fallback"], "freeze")
        self.assertRejected(direct('An edit', Inference(dispatch='edit', edit_intent='none', edit_fallback='guessed')), 'Invalid motion edit intent')

    def test_new_thumb_motion_cannot_enter_edit_selector(self):
        infer = Inference(dispatch="motion", motion_scope="joint", joint_motion="left_thumb hold bend 45")
        result = direct("Could you move just your left thumb?", infer)
        self.assertEqual(result["output"], "joint left_thumb_1 z 45")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "joint_motion"])

    def test_skill_and_edit_abstentions_do_not_fall_through(self):
        infer = Inference(dispatch="dexterity", dexterity="legacy")
        self.assertEqual(direct("Roll a coin on your head", infer)["output"], "unsupported")
        self.assertEqual([name for name, _ in infer.atomic_calls], ["playback_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "current_control", "dexterity"])
        infer = Inference(dispatch="edit", edit_intent="freeze", edit_target="none", edit_confirmation="none")
        self.assertEqual(direct("An unsupported edit", infer)["output"], "unsupported")
        self.assertRejected(direct('An invalid edit', Inference(dispatch='edit', edit_intent='freeze', edit_target='none', edit_confirmation='freeze everything')))

    def test_editor_tokens_cover_fingers_joints_and_selected_without_resolving_context(self):
        for target in ["selected", "hips", "spine_mid", "head", "elbow", "ring", "index_3", "right_ring", "both_thumb", "left_knee", "arm", "left_arm", "right_arm", "both_arms"]:
            for operation in ["freeze", "restore"]:
                self.assertEqual(validate_edit(f"{operation} {target}"), f"{operation} {target}")
        self.assertEqual(validate_edit("none"), "none")
        self.assertEqual(validate_edit("freeze arms"), "freeze both_arms")
        self.assertEqual(validate_edit("restore both_arm"), "restore both_arms")
        for prefix in ["", "left_", "right_", "both_"]:
            self.assertEqual(validate_edit(f"restore {prefix}foot"), f"restore {prefix}ankle")


if __name__ == "__main__":
    unittest.main()
