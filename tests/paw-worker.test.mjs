/** Exercise the real HTTP/process bridge with a fake local model, never a GPU. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
let server, directory, base;
const environment = {
  AVATAR_PYTHON: process.env.AVATAR_PYTHON,
  PYTHONPATH: process.env.PYTHONPATH,
  AVATAR_TEST_EVENTS: process.env.AVATAR_TEST_EVENTS,
};

async function events() {
  try {
    return (await readFile(resolve(directory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate(await events())) {
    if (Date.now() > deadline) throw new Error("Worker event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const post = (instruction, signal) =>
  fetch(base + "/api/direct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
    signal,
  });

before(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "avatar-worker-test-"));
  const programs = JSON.parse(await readFile(resolve(root, "programs.json"), "utf8"));
  await writeFile(
    resolve(directory, "programasweights.py"),
    `
import json, os, time

def event(kind, text=''):
    with open(os.environ['AVATAR_TEST_EVENTS'], 'a') as output:
        output.write(json.dumps({'kind': kind, 'text': text, 'pid': os.getpid()}) + '\\n')

def function(program_id):
    if program_id == ${JSON.stringify(programs.sequence)}:
        return lambda *args, **kwargs: 'single'
    if program_id == ${JSON.stringify(programs.leg_scope)}:
        return lambda *args, **kwargs: 'yes'
    if program_id in (${JSON.stringify(programs.action_intent)}, ${JSON.stringify(programs.leg_control)}, ${JSON.stringify(programs.playback_control)}, ${JSON.stringify(programs.arm_control)}, ${JSON.stringify(programs.dance_extension)}, ${JSON.stringify(programs.dance_fallback)}):
        return lambda *args, **kwargs: 'none'
    if program_id == ${JSON.stringify(programs.dance_confirmation)}:
        return lambda *args, **kwargs: 'no'
    if program_id in (${JSON.stringify(programs.activity_scope)}, ${JSON.stringify(programs.activity_confirmation)}):
        return lambda *args, **kwargs: 'other'
    if program_id == ${JSON.stringify(programs.dispatch)}:
        return lambda *args, **kwargs: 'dexterity'
    if program_id == ${JSON.stringify(programs.current_control)}:
        return lambda *args, **kwargs: 'unsupported'
    event('load', program_id)
    def infer(text, **kwargs):
        event('start', text)
        if text == 'crash': os._exit(7)
        if text.startswith('slow'): time.sleep(0.25)
        if text.startswith('cancel'): time.sleep(10)
        print('model log')
        os.write(1, b'native model log\\n')
        event('finish', text)
        return 'invalid' if text == 'bad-output' else 'skill finger_ripple left forward'
    return infer
`,
  );
  process.env.AVATAR_PYTHON = "python3";
  process.env.PYTHONPATH = directory;
  process.env.AVATAR_TEST_EVENTS = resolve(directory, "events.jsonl");
  server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  await server?.close();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("validation rejects bad requests without loading a model", async () => {
  assert.equal((await post(" ")).status, 400);
  assert.equal((await post("x".repeat(401))).status, 400);
  assert.equal((await fetch(base + "/api/direct")).status, 405);
  assert.equal(
    (await fetch(base + "/api/direct", { method: "POST", body: "Ripple" }))
      .status,
    415,
  );
  assert.equal(
    (
      await fetch(base + "/api/direct", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://unrelated.example",
        },
        body: JSON.stringify({ instruction: "Ripple" }),
      })
    ).status,
    403,
  );
  assert.equal((await post("x".repeat(5_000))).status, 413);
  assert.deepEqual(await events(), []);
});

test("four requests execute serially and a fifth is rejected", async () => {
  const first = post("slow-one");
  await until((items) =>
    items.some((item) => item.text === "slow-one" && item.kind === "start"),
  );
  const requests = [
    post("slow-two"),
    post("slow-three"),
    post("slow-four"),
    post("slow-five"),
  ];
  const responses = await Promise.all([first, ...requests]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 200, 200, 200, 429],
  );
  const activity = (await events()).filter((item) =>
    ["start", "finish"].includes(item.kind),
  );
  assert.equal(activity.length, 8);
  for (let index = 0; index < activity.length; index += 2) {
    assert.equal(activity[index].kind, "start");
    assert.equal(activity[index + 1].kind, "finish");
    assert.equal(activity[index].text, activity[index + 1].text);
  }
  assert.equal(
    (await events()).filter((item) => item.kind === "load").length,
    1,
  );
});

test("cancelling a queued request leaves the active model alive", async () => {
  const active = post("slow-queue");
  await until((items) =>
    items.some((item) => item.kind === "start" && item.text === "slow-queue"),
  );
  const controller = new AbortController();
  const queued = post("queued-cancelled", controller.signal);
  const rejected = assert.rejects(
    queued,
    (error) => error.name === "AbortError",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort();
  await rejected;
  assert.equal((await active).status, 200);
  assert.ok(!(await events()).some((item) => item.text === "queued-cancelled"));
  assert.equal(
    (await events()).filter((item) => item.kind === "load").length,
    1,
  );
});

test("cancelling active inference stops its process and allows a fresh request", async () => {
  const controller = new AbortController();
  const active = post("cancel-active", controller.signal);
  const rejected = assert.rejects(
    active,
    (error) => error.name === "AbortError",
  );
  await until((items) =>
    items.some(
      (item) => item.kind === "start" && item.text === "cancel-active",
    ),
  );
  controller.abort();
  await rejected;
  const response = await post("after-cancel");
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).output,
    "skill finger_ripple left forward",
  );
  const activity = await events();
  assert.notEqual(
    activity.find((item) => item.text === "cancel-active").pid,
    activity.find((item) => item.text === "after-cancel").pid,
  );
  assert.ok(
    !activity.some(
      (item) => item.text === "cancel-active" && item.kind === "finish",
    ),
  );
});

test("a crashed worker reports failure and restarts only on the next request", async () => {
  const crashed = await post("crash");
  assert.equal(crashed.status, 503);
  assert.match((await crashed.json()).detail, /worker exited|disconnected/);
  const response = await post("after-crash");
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).output,
    "skill finger_ripple left forward",
  );
});

test("invalid neural output remains an error and does not poison later requests", async () => {
  const invalid = await post("bad-output");
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).detail, /Invalid dexterity/);
  assert.equal((await post("after-bad-output")).status, 200);
});

test("deadline terminates a stuck worker and the next request can recover", async () => {
  const originalTimer = globalThis.setTimeout;
  // Exercise the production deadline without waiting five minutes.
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalTimer(callback, delay === 300_000 ? 80 : delay, ...args);
  try {
    const timedOut = await post("cancel-timeout");
    assert.equal(timedOut.status, 504);
    assert.match((await timedOut.json()).detail, /exceeded five minutes/);
  } finally {
    globalThis.setTimeout = originalTimer;
  }
  assert.equal((await post("after-timeout")).status, 200);
  const activity = await events();
  assert.notEqual(
    activity.find((item) => item.text === "cancel-timeout").pid,
    activity.find((item) => item.text === "after-timeout").pid,
  );
});

test(
  "server shutdown terminates active inference promptly",
  { timeout: 5_000 },
  async () => {
    const active = post("cancel-server-shutdown").catch((error) => error);
    await until((items) =>
      items.some(
        (item) =>
          item.kind === "start" && item.text === "cancel-server-shutdown",
      ),
    );
    const pid = (await events()).find(
      (item) => item.text === "cancel-server-shutdown",
    ).pid;
    const closing = server.close();
    const response = await active;
    // Vite may close its HTTP socket before our shutdown response is flushed.
    if (response instanceof Response) assert.equal(response.status, 503);
    else assert.match(response.message, /fetch failed/);
    await closing;
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    });
  },
);
