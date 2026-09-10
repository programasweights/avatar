"""Ordered-plan validation with injected model responses and no network."""
import json
import unittest
from unittest.mock import patch

from director import PROGRAMS, direct, validate_arm_control, validate_sequence


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
        defaults = {"sequence": self.sequence, "playback_control": "none", "arm_control": "none",
                    "dance_extension": "none", "dance_confirmation": "yes" if outputs.get("dance_extension", "none") != "none" else "no", "dance_fallback": "none", "activity_scope": "other", "activity_confirmation": "other",
                    "dispatch": "motion", "edit_intent": "none", "motion_scope": "joint", "current_control": "unsupported"}
        return {**defaults, **outputs}[name]


class SequenceDirectorTest(unittest.TestCase):
    def setUp(self):
        programs = patch.dict(PROGRAMS, {name: PROGRAMS.get(name, f"test-{name}") for name in ("sequence", "arm_control")})
        programs.start()
        self.addCleanup(programs.stop)

    def test_single_and_arm_gates_preserve_actual_trace_and_run_in_order(self):
        infer = PlannedInference(joint_motion="left_elbow hold x 30")
        result = direct("Bend your left elbow.", infer)
        self.assertEqual(result["output"], "joint left_elbow x 30")
        self.assertEqual([name for name, _ in infer.calls], ["sequence", "playback_control", "arm_control", "dance_extension", "dance_confirmation", "activity_scope", "activity_confirmation", "dispatch", "edit_intent", "motion_scope", "joint_motion"])
        self.assertEqual(result["trace"]["sequence"], "single")
        self.assertEqual(result["trace"]["arm_control"], "none")
        infer = PlannedInference(playback_control="pause")
        self.assertEqual(direct("Stop.", infer)["output"], "playback pause")
        self.assertEqual([name for name, _ in infer.calls], ["sequence", "playback_control"])

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
        self.assertEqual(infer.calls[0], ("sequence", "Do three ordered motions."))
        seen = [text for _, text in infer.calls[1:]]
        self.assertEqual(seen, sorted(seen, key=list(clauses).index))
        self.assertEqual(infer.calls[-2:], [(name, "Make the right arm robotic.") for name in ["playback_control", "arm_control"]])

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
                self.assertEqual(infer.calls, [("sequence", "An ordered instruction.")])

    def test_four_bounded_steps_allow_48_explicit_seconds_and_400_character_clause(self):
        steps = validate_sequence("sequence\n" + "\n".join(["perform|12|" + "x" * 400] * 4))
        self.assertEqual(sum(step["seconds"] for step in steps), 48)
        self.assertEqual(len(steps), 4)

    def test_invalid_middle_step_aborts_the_entire_plan_without_interpreting_later_steps(self):
        raw = "sequence\nperform|auto|First\nperform|auto|Second\nperform|auto|Third"
        for invalid in ["unsupported", "left_elbow hold x 999"]:
            infer = PlannedInference(raw, {"First": {"joint_motion": "left_elbow hold x 30"}, "Second": {"joint_motion": invalid}})
            result = direct("First then second then third.", infer)
            self.assertEqual(result["output"], "unsupported")
            self.assertEqual(len(result["trace"]["steps"]), 2)
            self.assertNotIn("Third", [text for _, text in infer.calls])

    def test_playback_freeze_and_restore_cannot_enter_a_sequence(self):
        for outputs in [{"playback_control": "pause"}, {"playback_control": "restart"},
                        {"dispatch": "edit", "edit_intent": "freeze", "edit_target": "freeze ring"},
                        {"dispatch": "edit", "edit_intent": "restore", "edit_target": "restore ring"}]:
            with self.subTest(outputs=outputs):
                infer = PlannedInference("sequence\nperform|auto|First\ncontinue|auto|Second", {"First": outputs})
                result = direct("First then second.", infer)
                self.assertEqual(result["output"], "unsupported")
                self.assertIn("cannot be placed", result["trace"]["validation_error"])
                self.assertNotIn("Second", [text for _, text in infer.calls])

    def test_arm_style_expert_accepts_only_bounded_bilateral_or_sided_commands(self):
        for prefix in ["arms", "arm left", "arm right"]:
            for style in ["natural", "robot", "wave", "still"]:
                command = f"{prefix} {style}"
                infer = PlannedInference(arm_control=command)
                result = direct("Change the arm motion while the dance continues.", infer)
                self.assertEqual(result["output"], command)
                self.assertEqual(result["trace"]["arm_control"], command)
                self.assertEqual(result["trace"]["route"], "control")
                self.assertEqual([name for name, _ in infer.calls], ["sequence", "playback_control", "arm_control"])
        for invalid in ["", "arm both robot", "arms left robot", "arm left hold", "arms still\ndance gangnam", "arm left robot extra", "arm\tleft robot", "none"]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_arm_control(invalid)


if __name__ == "__main__":
    unittest.main()
