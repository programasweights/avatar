"""Ordered-plan validation with injected model responses and no network."""
import json
import unittest
from unittest.mock import patch

from director import PROGRAMS, direct, validate_arm_control, validate_sequence


def setUpModule():
    global _focused_programs
    _focused_programs = patch.dict(PROGRAMS, {
        name: PROGRAMS.get(name, f"test-{name}") for name in ("body_sway", "request_intent", "motion_language", "extension_scope", "action_gesture", "language_scope", "motion_translation", "meaning_scope")
    })
    _focused_programs.start()


def tearDownModule():
    _focused_programs.stop()


class PlannedInference:
    def __init__(self, sequence="single", clauses=None, **outputs):
        self.sequence = sequence
        self.clauses = clauses or {}
        self.outputs = outputs
        self.calls = []

    def __call__(self, program_id, text):
        name = next(name for name, value in PROGRAMS.items() if value == program_id)
        self.calls.append((name, text))
        outputs = {**self.outputs, **self.clauses.get(text, {})}
        defaults = {"meaning_scope": "clarify" if "motion_language" in outputs else "keep", "language_scope": "english", "motion_language": "unchanged", "sequence": self.sequence, "extension_scope": "none", "body_sway": "none", "request_intent": "command", "playback_control": "none", "leg_control": "none", "leg_scope": "yes", "action_intent": "none", "arm_control": "none",
                    "dance_extension": "none", "dance_confirmation": "yes" if outputs.get("dance_extension", "none") != "none" else "no", "dance_fallback": "none", "activity_scope": "other", "activity_confirmation": "basic" if outputs.get("activity_scope") == "basic" else "other",
                    "dispatch": "motion", "edit_intent": "none", "motion_scope": "joint", "current_control": "unsupported"}
        return {**defaults, **outputs}[name]


class SequenceDirectorTest(unittest.TestCase):
    def setUp(self):
        programs = patch.dict(PROGRAMS, {name: PROGRAMS.get(name, f"test-{name}") for name in ("sequence", "leg_control", "action_intent", "arm_control", "motion_language")})
        programs.start()
        self.addCleanup(programs.stop)

    def test_chinese_ordered_request_is_normalized_once_before_splitting_and_keeps_each_side(self):
        normalized = "First lift the left leg 30 degrees, then lift the right leg 60 degrees."
        infer = PlannedInference(
            "sequence\nperform|auto|Lift the left leg 30 degrees.\nperform|auto|Lift the right leg 60 degrees.",
            {"Lift the left leg 30 degrees.": {"joint_motion": "left_hip hold raise 30"},
             "Lift the right leg 60 degrees.": {"joint_motion": "right_hip hold raise 60"}},
            language_scope="translate", motion_translation=normalized,
        )
        original = "先抬左腿30度，再抬右腿60度"
        result = direct(original, infer)
        plan = json.loads(result["output"])
        self.assertEqual([step["commands"] for step in plan["steps"]], ["joint left_hip x -30", "joint right_hip x -60"])
        self.assertEqual(result["trace"]["normalized_instruction"], normalized)
        self.assertEqual(result["trace"]["motion_translation"], normalized)
        self.assertEqual(infer.calls[:5], [("request_intent", original), ("language_scope", original), ("motion_translation", original), ("meaning_scope", normalized), ("sequence", normalized)])
        self.assertEqual([name for name, _ in infer.calls].count("meaning_scope"), 1)
        self.assertEqual([name for name, _ in infer.calls].count("language_scope"), 1)
        self.assertEqual([name for name, _ in infer.calls].count("request_intent"), 1)
        self.assertEqual([name for name, _ in infer.calls].count("motion_translation"), 1)
        self.assertEqual([name for name, _ in infer.calls].count("sequence"), 1)

    def test_rejected_chinese_sequence_keeps_normalization_and_does_not_run_later_steps(self):
        normalized = "First lift the left leg, then do an unsupported action, then bow."
        infer = PlannedInference(
            "sequence\nperform|auto|Lift the left leg.\nperform|auto|Unsupported action.\nperform|auto|Bow.",
            {"Lift the left leg.": {"joint_motion": "left_hip hold raise 45"},
             "Unsupported action.": {"joint_motion": "unsupported"}},
            language_scope="translate", motion_translation=normalized,
        )
        result = direct("先抬左腿，再做不支持的动作，最后鞠躬", infer)
        self.assertEqual(result["output"], "unsupported")
        self.assertEqual(result["trace"]["normalized_instruction"], normalized)
        self.assertEqual(result["trace"]["motion_translation"], normalized)
        self.assertEqual(len(result["trace"]["steps"]), 2)
        self.assertNotIn("Bow.", [text for _, text in infer.calls])

    def test_ordered_extensions_share_one_language_and_request_interpretation(self):
        instruction = "First sway twice, then punch with your left hand."
        infer = PlannedInference(
            "sequence\nperform|auto|Sway twice.\nperform|auto|Punch with your left hand.",
            {"Sway twice.": {"extension_scope": "sway", "body_sway": "action sway 2"},
             "Punch with your left hand.": {"extension_scope": "gesture", "action_gesture": "action punch_left 1"}},
        )
        result = direct(instruction, infer)
        plan = json.loads(result["output"])
        self.assertEqual([step["commands"] for step in plan["steps"]], ["action sway 2", "action punch_left 1"])
        self.assertEqual(infer.calls, [
            ("request_intent", instruction), ("language_scope", instruction), ("meaning_scope", instruction), ("sequence", instruction),
            ("extension_scope", "Sway twice."), ("body_sway", "Sway twice."),
            ("extension_scope", "Punch with your left hand."), ("action_gesture", "Punch with your left hand."),
        ])
        self.assertEqual(result["trace"]["request_intent"], "command")
        self.assertEqual(result["trace"]["normalized_instruction"], instruction)
        self.assertTrue(all("request_intent" not in step["trace"] for step in result["trace"]["steps"]))

    def test_unchanged_keeps_lowercase_after_ordering_for_the_original_sequence_model(self):
        original = "bow after jumping three times"
        infer = PlannedInference(
            "sequence\nperform|auto|Jump three times.\nperform|auto|Bow.",
            {"Jump three times.": {"activity_scope": "basic", "action": "action jump 3"},
             "Bow.": {"activity_scope": "basic", "action": "action bow 1"}},
        )
        result = direct(original, infer)
        self.assertEqual(result["trace"]["meaning_scope"], "keep")
        self.assertEqual(result["trace"]["normalized_instruction"], original)
        self.assertEqual(infer.calls[:4], [("request_intent", original), ("language_scope", original), ("meaning_scope", original), ("sequence", original)])
        self.assertEqual([step["commands"] for step in json.loads(result["output"])["steps"]], ["action jump 3", "action bow 1"])

    def test_single_and_arm_gates_preserve_actual_trace_and_run_in_order(self):
        infer = PlannedInference(joint_motion="left_elbow hold x 30")
        result = direct("Bend your left elbow.", infer)
        self.assertEqual(result["output"], "joint left_elbow x 30")
        self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'arm_control', 'leg_control', 'dance_extension', 'dance_confirmation', 'activity_scope', 'activity_confirmation', 'dispatch', 'edit_intent', 'motion_scope', 'joint_motion'])
        self.assertEqual(result["trace"]["sequence"], "single")
        self.assertEqual(result["trace"]["arm_control"], "none")
        infer = PlannedInference(playback_control="pause")
        self.assertEqual(direct("Stop.", infer)["output"], "playback pause")
        self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control'])

    def test_mixed_steps_keep_order_modes_durations_and_sequential_atomic_calls(self):
        raw = "sequence\nperform|auto|Raise your left arm.\nperform|2.5|Roll the coin.\ncontinue|3|Make the right arm robotic."
        clauses = {
            "Raise your left arm.": {"joint_motion": "left_shoulder hold z 75"},
            "Roll the coin.": {"dispatch": "dexterity", "dexterity": "skill coin_roll left forward"},
            "Make the right arm robotic.": {"arm_control": "arm right robot"},
        }
        infer = PlannedInference(raw, clauses)
        result = direct("Do three ordered motions.", infer)
        self.assertEqual(json.loads(result["output"]), {"kind": "sequence", "steps": [
            {"instruction": "Raise your left arm.", "mode": "perform", "commands": "joint left_shoulder z 75"},
            {"instruction": "Roll the coin.", "mode": "perform", "seconds": 2.5, "commands": "skill coin_roll left forward"},
            {"instruction": "Make the right arm robotic.", "mode": "continue", "seconds": 3, "commands": "arm right robot"},
        ]})
        self.assertEqual(result["trace"]["sequence"], raw)
        self.assertEqual(result["trace"]["route"], "sequence")
        self.assertEqual([step["trace"]["route"] for step in result["trace"]["steps"]], ["joint", "dexterity", "control"])
        self.assertEqual([name for name, _ in infer.calls].count("sequence"), 1)
        self.assertEqual([name for name, _ in infer.calls].count("meaning_scope"), 1)
        self.assertEqual([name for name, _ in infer.calls].count("language_scope"), 1)
        self.assertEqual([name for name, _ in infer.calls].count("request_intent"), 1)
        self.assertEqual(result["trace"]["meaning_scope"], "keep")
        self.assertEqual(result["trace"]["normalized_instruction"], "Do three ordered motions.")
        self.assertEqual(infer.calls[:4], [("request_intent", "Do three ordered motions."), ("language_scope", "Do three ordered motions."), ("meaning_scope", "Do three ordered motions."), ("sequence", "Do three ordered motions.")])
        seen = [text for _, text in infer.calls[4:]]
        self.assertEqual(seen, sorted(seen, key=list(clauses).index))
        self.assertEqual(infer.calls[-4:], [(name, "Make the right arm robotic.") for name in ['extension_scope', 'playback_control', 'action_intent', 'arm_control']])

    def test_named_speed_followup_remains_a_continuation_in_an_ordered_plan(self):
        infer = PlannedInference(
            "sequence\nperform|2|Roll a coin.\ncontinue|3|Make the coin roll faster.",
            {
                "Roll a coin.": {"dispatch": "dexterity", "dexterity": "skill coin_roll left forward"},
                "Make the coin roll faster.": {"dispatch": "dexterity", "current_control": "tempo_scale 1.25"},
            },
        )
        result = direct("Roll a coin for two seconds, then make the coin roll faster for three seconds.", infer)
        self.assertEqual(json.loads(result["output"]), {"kind": "sequence", "steps": [
            {"instruction": "Roll a coin.", "mode": "perform", "seconds": 2, "commands": "skill coin_roll left forward"},
            {"instruction": "Make the coin roll faster.", "mode": "continue", "seconds": 3, "commands": "tempo_scale 1.25"},
        ]})
        self.assertEqual([step["trace"]["route"] for step in result["trace"]["steps"]], ["dexterity", "control"])
        self.assertEqual([call for call in infer.calls if call[0] == "dexterity"], [("dexterity", "Roll a coin.")])

    def test_malformed_or_missing_plan_fields_reject_before_any_atomic_call(self):
        valid = "perform|auto|Move an arm."
        invalid = ["", "unsupported", "single\nextra", "sequence", f"sequence\n{valid}",
                   "sequence\n" + "\n".join([valid] * 5),
                   "sequence\nperform|auto\n" + valid,
                   "sequence\nperform|auto|\n" + valid,
                   "sequence\nperform|auto|Move|extra\n" + valid,
                   "sequence\nappend|auto|Move\n" + valid,
                   "sequence\nperform|auto|Bad\tclause\n" + valid,
                   "sequence\nperform|auto|" + "x" * 401 + "\n" + valid]
        invalid += [f"sequence\nperform|{duration}|Move\n{valid}" for duration in ["", "0", "0.99", "12.1", "13", "-1", "nan", "inf", "1e1", "2seconds"]]
        for raw in invalid:
            with self.subTest(raw=raw):
                infer = PlannedInference(raw)
                result = direct("An ordered instruction.", infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertEqual(result["trace"]["route"], "unsupported")
                self.assertTrue(result["trace"]["validation_error"])
                self.assertEqual(infer.calls, [("request_intent", "An ordered instruction."), ("language_scope", "An ordered instruction."), ("meaning_scope", "An ordered instruction."), ("sequence", "An ordered instruction.")])

    def test_four_bounded_steps_allow_48_explicit_seconds_and_400_character_clause(self):
        steps = validate_sequence("sequence\n" + "\n".join(["perform|12|" + "x" * 400] * 4))
        self.assertEqual(sum(step["seconds"] for step in steps), 48)
        self.assertEqual(len(steps), 4)

    def test_invalid_middle_step_aborts_the_entire_plan_without_interpreting_later_steps(self):
        raw = "sequence\nperform|auto|First\nperform|auto|Second\nperform|auto|Third"
        for invalid in ["unsupported", "left_elbow hold x 999", "left_wrist hold fist 45"]:
            infer = PlannedInference(raw, {"First": {"joint_motion": "left_elbow hold x 30"}, "Second": {"joint_motion": invalid}})
            result = direct("First then second then third.", infer)
            self.assertEqual(result["output"], "unsupported")
            self.assertEqual(len(result["trace"]["steps"]), 2)
            self.assertNotIn("Third", [text for _, text in infer.calls])
            self.assertEqual(result["trace"]["steps"][1]["trace"]["joint_motion"], invalid)
            if invalid != "unsupported":
                self.assertTrue(result["trace"]["steps"][1]["validation_error"])

    def test_ordered_step_provider_failures_propagate_and_never_run_later_steps(self):
        for failure in [None, ValueError("Provider decoding failed"), ConnectionError("Disconnected")]:
            with self.subTest(failure=failure):
                fake = PlannedInference(
                    "sequence\nperform|auto|First\nperform|auto|Second\nperform|auto|Third",
                    {"First": {"joint_motion": "left_elbow hold x 30"}, "Second": {"joint_motion": failure}},
                )
                def infer(program_id, text):
                    output = fake(program_id, text)
                    if isinstance(output, Exception):
                        raise output
                    return output
                expected = type(failure) if isinstance(failure, Exception) else ValueError
                with self.assertRaises(expected):
                    direct("First then second then third.", infer)
                self.assertEqual(fake.calls[-1], ("joint_motion", "Second"))
                self.assertNotIn("Third", [text for _, text in fake.calls])

    def test_playback_freeze_and_restore_cannot_enter_a_sequence(self):
        for outputs in [{"playback_control": "pause"}, {"playback_control": "restart"},
                        {"leg_control": "freeze both_legs"}, {"leg_control": "restore left_leg"},
                        {"dispatch": "edit", "edit_intent": "freeze", "edit_target": "freeze ring"},
                        {"dispatch": "edit", "edit_intent": "restore", "edit_target": "restore ring"}]:
            with self.subTest(outputs=outputs):
                infer = PlannedInference("sequence\nperform|auto|First\ncontinue|auto|Second", {"First": outputs})
                result = direct("First then second.", infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertIn("cannot be placed", result["trace"]["validation_error"])
                self.assertNotIn("Second", [text for _, text in infer.calls])

    def test_sequence_actions_canonicalize_constraints_but_preserve_steps_and_raw_trace(self):
        first = "arms still\naction kick_right 1"
        second = "action jump 2 left\narms still\naction bow 1"
        infer = PlannedInference(
            "sequence\nperform|2|Kick with your arms still.\ncontinue|3|Jump then bow with your arms still.",
            {"Kick with your arms still.": {"action_intent": "single", "activity_scope": "basic", "action": first},
             "Jump then bow with your arms still.": {"action_intent": "combined", "activity_scope": "basic", "action": second}},
        )
        result = direct("First kick, then jump and bow, keeping the arms still.", infer)
        plan = json.loads(result["output"])
        self.assertEqual([step["commands"] for step in plan["steps"]], [
            "action kick_right 1\narms still", "action jump 2 left\naction bow 1\narms still",
        ])
        self.assertEqual([step["mode"] for step in plan["steps"]], ["perform", "continue"])
        self.assertEqual([step["seconds"] for step in plan["steps"]], [2, 3])
        self.assertEqual([step["trace"]["action"] for step in result["trace"]["steps"]], [first, second])

    def test_overhead_reach_and_new_body_actions_retain_order_and_continuation(self):
        infer = PlannedInference(
            "sequence\nperform|2|Raise both arms overhead.\ncontinue|3|Do a side kick.\nperform|4|Lie down.",
            {
                "Raise both arms overhead.": {"joint_motion": "both_shoulder hold overhead 180"},
                "Do a side kick.": {"action_intent": "single", "activity_scope": "basic", "action": "action side_kick_right 1"},
                "Lie down.": {"action_intent": "single", "activity_scope": "basic", "action": "action lie_down 1"},
            },
        )
        result = direct("Raise both arms, then kick, then lie down.", infer)
        plan = json.loads(result["output"])
        self.assertEqual([step["mode"] for step in plan["steps"]], ["perform", "continue", "perform"])
        self.assertEqual([step["seconds"] for step in plan["steps"]], [2, 3, 4])
        self.assertEqual([step["commands"] for step in plan["steps"]], [
            "arm left still\njoint left_shoulder z 180\narm right still\njoint right_shoulder z -180",
            "action side_kick_right 1", "action lie_down 1",
        ])
        self.assertEqual([name for name, _ in infer.calls].count("leg_control"), 1)

    def test_arm_style_expert_accepts_only_bounded_bilateral_or_sided_commands(self):
        for prefix in ["arms", "arm left", "arm right"]:
            for style in ["natural", "robot", "wave", "still"]:
                command = f"{prefix} {style}"
                infer = PlannedInference(arm_control=command)
                result = direct("Change the arm motion while the dance continues.", infer)
                self.assertEqual(result["output"], command)
                self.assertEqual(result["trace"]["arm_control"], command)
                self.assertEqual(result["trace"]["route"], "control")
                self.assertEqual([name for name, _ in infer.calls], ['request_intent', 'language_scope', 'meaning_scope', 'sequence', 'extension_scope', 'playback_control', 'action_intent', 'arm_control'])
        for invalid in ["", "arm both robot", "arms left robot", "arm left hold", "arms still\ndance gangnam", "arm left robot extra", "arm\tleft robot", "none"]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_arm_control(invalid)


if __name__ == "__main__":
    unittest.main()
