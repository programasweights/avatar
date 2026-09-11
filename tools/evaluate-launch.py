#!/usr/bin/env python3
"""Run sequential, real-inference acceptance probes against an avatar director.

Example:
    python3 tools/evaluate-launch.py --url http://localhost:5173/api/direct \
        --output /tmp/avatar-language-results.json

This is opt-in: it sends each case to the supplied endpoint. The default suite
includes unsupported requests to check that the director abstains honestly.
It checks command meaning, not the visual quality of the resulting animation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url", help="Avatar direction endpoint")
    source.add_argument("--local", action="store_true", help="Run the pinned director with local PAW inference")
    source.add_argument("--infer-url", help="Run the pinned director with sequential calls to a hosted PAW /api/v1/infer endpoint")
    parser.add_argument("--cases", type=Path, default=Path(__file__).resolve().parents[1] / "tests/launch-language-cases.json")
    parser.add_argument("--case", action="append", dest="case_ids", help="Run only this case ID; may be repeated")
    parser.add_argument("--output", type=Path, required=True, help="Raw result JSON path, outside the source tree recommended")
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text())["cases"]
    if args.case_ids:
        known = {case["id"] for case in cases}
        if set(args.case_ids) - known:
            parser.error("Unknown case ID: " + ", ".join(sorted(set(args.case_ids) - known)))
        cases = [case for case in cases if case["id"] in args.case_ids]
    director = None
    infer = None
    inference_calls = []
    if args.local or args.infer_url:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from director import direct, PROGRAMS
        director = direct
    if args.infer_url:
        import programasweights as paw
        endpoint = urlsplit(args.infer_url)
        configured = urlsplit(paw.get_api_url())
        same_origin = (endpoint.scheme, endpoint.netloc) == (configured.scheme, configured.netloc)
        key = paw.get_api_key() if same_origin else None
        def infer(program_id, instruction):
            headers = {"Content-Type": "application/json"}
            if key:
                headers["X-API-Key"] = key
            request = urllib.request.Request(args.infer_url, data=json.dumps({
                "program_id": program_id, "input": instruction, "temperature": 0,
                "max_tokens": 256 if program_id in {PROGRAMS.get("sequence"), PROGRAMS.get("motion_language"), PROGRAMS.get("motion_translation")} else 80,
            }).encode(), headers=headers, method="POST")
            with urllib.request.urlopen(request, timeout=args.timeout) as result:
                output = json.load(result)["output"]
            inference_calls.append({"program_id": program_id, "output": output})
            return output
    report = {"endpoint": args.url or args.infer_url or "local", "started_at": datetime.now(timezone.utc).isoformat(), "results": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for case in cases:
        inference_calls.clear()
        started = time.monotonic()
        status, response = None, None
        try:
            if director:
                response = director(case["instruction"], infer=infer)
                status = 200
            else:
                request = urllib.request.Request(
                    args.url, data=json.dumps({"instruction": case["instruction"]}).encode(),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(request, timeout=args.timeout) as result:
                    status = result.status
                    response = json.load(result)
        except urllib.error.HTTPError as exc:
            status = exc.code
            raw = exc.read().decode(errors="replace")
            try:
                response = json.loads(raw)
            except json.JSONDecodeError:
                response = {"error": raw}
        except ValueError as exc:
            status = 422
            response = {"error": str(exc)}
        except OSError as exc:
            response = {"error": str(exc)}
        output = response.get("output") if isinstance(response, dict) else None
        matches = output in case.get("expected", []) or (
            isinstance(output, str) and any(re.fullmatch(pattern, output) for pattern in case.get("expected_patterns", []))
        )
        if "expected_steps" in case and isinstance(output, str):
            try:
                plan = json.loads(output)
                expected = case["expected_steps"]
                matches = (isinstance(plan, dict) and plan.get("kind") == "sequence"
                           and isinstance(plan.get("steps"), list) and len(plan["steps"]) == len(expected)
                           and all(isinstance(step, dict) and step.get("commands") in want["commands"]
                                   and step.get("mode") == want["mode"]
                                   and step.get("seconds") == want.get("seconds")
                                   for step, want in zip(plan["steps"], expected)))
            except (ValueError, TypeError):
                matches = False
        elif isinstance(output, str) and output.startswith("{"):
            # Older body-action cases already describe temporal order. The
            # explicit plan must preserve every action and count; simultaneous
            # joint or style command blocks are never accepted this way.
            try:
                plan = json.loads(output)
                for expected in case.get("expected", []):
                    lines = expected.splitlines()
                    if len(lines) < 2 or not all(line.startswith("action ") for line in lines):
                        continue
                    steps = plan.get("steps", []) if isinstance(plan, dict) else []
                    if (plan.get("kind") == "sequence" and len(steps) == len(lines)
                            and all(isinstance(step, dict) and step.get("commands") == line
                                    and step.get("mode") == "perform" and "seconds" not in step
                                    for step, line in zip(steps, lines))):
                        matches = True
            except (ValueError, TypeError, AttributeError):
                matches = False
        if case.get("excluded_prefixes") and isinstance(output, str):
            matches = not any(output.startswith(prefix) for prefix in case["excluded_prefixes"])
        if "expected_route" in case:
            matches = matches and response.get("trace", {}).get("route") == case["expected_route"]
        passed = status == 200 and matches
        if passed:
            outcome = ("guarded_rejection" if response.get("trace", {}).get("validation_error")
                       else "honest_unsupported" if output == "unsupported" else "supported")
        elif status == 422:
            outcome = "validation_rejection"
        elif status != 200:
            outcome = "request_failure"
        elif output == "unsupported":
            outcome = "supported_intent_rejected"
        else:
            outcome = "incorrect_command"
        row = {**case, "status": status, "elapsed_seconds": round(time.monotonic() - started, 3), "passed": passed, "outcome": outcome, "response": response}
        if args.infer_url:
            # Keep model evidence even when command validation raises before
            # the director can return its completed trace.
            row["inference_calls"] = inference_calls.copy()
        report["results"].append(row)
        report["passed"] = sum(item["passed"] for item in report["results"])
        report["failed"] = len(report["results"]) - report["passed"]
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(f"{'PASS' if passed else 'FAIL'} {case['id']}: {output!r} ({row['elapsed_seconds']}s, HTTP {status})", flush=True)
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    report["by_category"] = {}
    for row in report["results"]:
        category = report["by_category"].setdefault(row.get("category", "named"), {})
        category[row["outcome"]] = category.get(row["outcome"], 0) + 1
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for category, outcomes in report["by_category"].items():
        print(f"{category}: " + ", ".join(f"{outcome}={count}" for outcome, count in sorted(outcomes.items())))
    print(f"Full traces: {args.output}")
    return int(report["failed"] > 0)


if __name__ == "__main__":
    sys.exit(main())
