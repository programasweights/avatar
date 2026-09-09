"""Persistent JSONL bridge: one input direction and one output result per line."""
from __future__ import annotations

import json
import os
import sys
from typing import TextIO

from director import Infer, direct


def serve(source: TextIO, destination: TextIO, infer: Infer | None = None) -> None:
    for line in source:
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Expected a JSON object")
            request_id = request.get("id")
            if not isinstance(request_id, str) or not request_id or len(request_id) > 80:
                raise ValueError("Expected a request ID")
            instruction = request.get("instruction")
            if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 400:
                raise ValueError("Provide a direction of 1–400 characters.")
        except (ValueError, TypeError) as exc:
            response = {"id": request_id, "ok": False, "status": 400, "detail": str(exc)}
        else:
            try:
                result = direct(instruction, infer)
            except ValueError as exc:
                response = {"id": request_id, "ok": False, "status": 422,
                            "detail": f"PAW could not express that direction: {exc}"}
            except Exception as exc:
                print(f"Local PAW inference failed: {exc}", file=sys.stderr)
                response = {"id": request_id, "ok": False, "status": 503,
                            "detail": f"Local PAW inference failed: {exc}"}
            else:
                response = {"id": request_id, "ok": True, "result": result}
        destination.write(json.dumps(response, ensure_ascii=False) + "\n")
        destination.flush()


def main() -> None:
    # Reserve a duplicate of stdout for JSON. Redirect both Python and native
    # library stdout to stderr before any model import, download, or inference.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    try:
        serve(sys.stdin, protocol)
    except BrokenPipeError:
        pass  # The Vite server disconnected or cancelled the active request.
    finally:
        protocol.close()


if __name__ == "__main__":
    main()
