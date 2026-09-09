import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

type Result = { output: string; trace: Record<string, string> };
class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.status = status;
  }
}
type Job = {
  id: string;
  instruction: string;
  finish: (error?: Error, result?: Result) => void;
};

// One process retains the loaded models; only one request ever enters it at a time.
class PawWorker {
  private child?: ChildProcessWithoutNullStreams;
  private active?: Job;
  private queue: Job[] = [];
  private stopping = false;
  private disposed = false;
  private serial = 0;
  private readonly root = fileURLToPath(new URL("../", import.meta.url));

  run(instruction: string, signal: AbortSignal): Promise<Result> {
    if (this.disposed)
      return Promise.reject(
        new RequestError("The local server is shutting down."),
      );
    if (signal.aborted)
      return Promise.reject(new RequestError("Direction cancelled.", 499));
    if (this.queue.length + Number(Boolean(this.active)) >= 4) {
      return Promise.reject(
        new RequestError(
          "The local director is busy. Try again after the current direction.",
          429,
        ),
      );
    }
    return new Promise((resolveResult, reject) => {
      const job: Job = { id: String(++this.serial), instruction, finish };
      const cancel = () =>
        this.cancel(job, new RequestError("Direction cancelled.", 499));
      const timer = setTimeout(
        () =>
          this.cancel(
            job,
            new RequestError(
              "Local PAW exceeded five minutes. Check the terminal for download or runtime errors, then try again.",
              504,
            ),
          ),
        300_000,
      );
      function finish(error?: Error, result?: Result) {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolveResult(result!);
      }
      signal.addEventListener("abort", cancel, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump() {
    if (this.disposed || this.stopping || this.active || !this.queue.length)
      return;
    this.active = this.queue.shift();
    if (!this.child) this.start();
    this.child!.stdin.write(
      JSON.stringify({
        id: this.active!.id,
        instruction: this.active!.instruction,
      }) + "\n",
    );
  }

  private start() {
    const venv = resolve(
      this.root,
      process.platform === "win32"
        ? ".venv/Scripts/python.exe"
        : ".venv/bin/python",
    );
    const python =
      process.env.AVATAR_PYTHON || (existsSync(venv) ? venv : "python3");
    const child = spawn(python, ["-u", resolve(this.root, "paw_worker.py")], {
      cwd: this.root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    });
    this.child = child;
    let buffered = "";
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child || this.stopping) return;
      buffered += chunk;
      if (buffered.length > 64_000) {
        this.fail(
          new RequestError("Local PAW returned an oversized response."),
        );
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (
            !this.active ||
            response.id !== this.active.id ||
            typeof response.ok !== "boolean"
          ) {
            throw new Error("Mismatched worker response");
          }
          if (
            response.ok &&
            (typeof response.result?.output !== "string" ||
              typeof response.result?.trace !== "object" ||
              !response.result.trace)
          ) {
            throw new Error("Invalid worker result");
          }
          const job = this.active;
          this.active = undefined;
          if (response.ok) job.finish(undefined, response.result);
          else
            job.finish(
              new RequestError(
                typeof response.detail === "string"
                  ? response.detail
                  : "Local PAW inference failed.",
                [400, 422, 503].includes(response.status)
                  ? response.status
                  : 503,
              ),
            );
          this.pump();
        } catch {
          this.fail(
            new RequestError(
              "Local PAW returned an invalid response. Check the terminal.",
            ),
          );
          break;
        }
      }
    });
    child.on("error", () => {
      if (this.child === child)
        this.fail(
          new RequestError(
            "Could not start Python. Install Python 3.10+, create .venv, and install requirements.txt; or set AVATAR_PYTHON.",
          ),
        );
    });
    child.stdin.on("error", () => {
      if (this.child === child && !this.stopping)
        this.fail(new RequestError("The local PAW worker disconnected."));
    });
    child.on("close", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.stopping = false;
      if (this.active) {
        this.active.finish(
          new RequestError(
            "The local PAW worker exited. Check the terminal, then try again.",
          ),
        );
        this.active = undefined;
      }
      this.pump();
    });
  }

  private cancel(job: Job, error: Error) {
    if (this.active === job) {
      this.active = undefined;
      job.finish(error);
      this.stop(); // Wait for process close before starting the next request.
    } else {
      const index = this.queue.indexOf(job);
      if (index !== -1) {
        this.queue.splice(index, 1);
        job.finish(error);
      }
    }
  }

  private fail(error: Error) {
    this.active?.finish(error);
    this.active = undefined;
    this.stop();
  }

  private stop() {
    const child = this.child;
    if (!child || this.stopping) return;
    this.stopping = true;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }

  close = () => {
    this.disposed = true;
    this.active?.finish(new RequestError("The local server is shutting down."));
    this.active = undefined;
    for (const job of this.queue.splice(0))
      job.finish(new RequestError("The local server is shutting down."));
    this.stop();
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 4096) chunks.push(Buffer.from(chunk));
      else reject(new RequestError("Direction is too large.", 413));
    });
    req.on("end", () => {
      if (bytes > 4096) return;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(
          new RequestError(
            "Expected a JSON object containing instruction.",
            400,
          ),
        );
      }
    });
    req.on("error", reject);
    req.on("aborted", () =>
      reject(new RequestError("Direction cancelled.", 499)),
    );
  });
}

export function localPawPlugin(): Plugin {
  const worker = new PawWorker();
  const middleware = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    if (req.url?.split("?")[0] !== "/api/direct") {
      next();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      if (req.method !== "POST")
        throw new RequestError("Use POST for a direction.", 405);
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        throw new RequestError("Send the direction as application/json.", 415);
      }
      if (req.headers.origin) {
        let host: string;
        try {
          host = new URL(req.headers.origin).host;
        } catch {
          throw new RequestError("Invalid request origin.", 403);
        }
        if (host !== req.headers.host)
          throw new RequestError(
            "Directions must come from this local studio.",
            403,
          );
      }
      const body = (await readBody(req)) as { instruction?: unknown } | null;
      const instruction = body?.instruction;
      if (
        typeof instruction !== "string" ||
        !instruction.trim() ||
        instruction.length > 400
      ) {
        throw new RequestError("Provide a direction of 1–400 characters.", 400);
      }
      const result = await worker.run(instruction, controller.signal);
      if (!res.destroyed) res.end(JSON.stringify(result));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = error instanceof RequestError ? error.status : 503;
      res.end(
        JSON.stringify({
          detail:
            error instanceof Error
              ? error.message
              : "Local PAW inference failed.",
        }),
      );
    }
  };
  return {
    name: "local-paw",
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", worker.close);
      process.once("exit", worker.close);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer.once("close", worker.close);
      process.once("exit", worker.close);
    },
    closeBundle() {
      worker.close();
      process.removeListener("exit", worker.close);
    },
  };
}
