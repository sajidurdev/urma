import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { UrmaError } from "../../src/core/errors.js";
import { runProcess } from "../../src/subprocess/runner.js";

function windowsProcesses(t: TestContext) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  const child = Object.assign(new ChildProcess(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const killer = new ChildProcess();
  let taskkills = 0;
  const spawn = t.mock.method(childProcess, "spawn", (executable: string) => {
    if (executable === "taskkill") {
      taskkills += 1;
      return killer;
    }
    return child;
  });
  syncBuiltinESMExports();
  const kills = t.mock.method(process, "kill", () => true);
  t.mock.method(killer, "kill", () => true);
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const closeChild = () => {
    Object.defineProperty(child, "signalCode", { value: "SIGKILL" });
    child.emit("close", null, "SIGKILL");
  };
  return { child, killer, kills, closeChild, taskkills: () => taskkills };
}

for (const failure of ["nonzero exit", "launch error"] as const) {
  test(`Windows cancellation falls back after taskkill ${failure} and reports unconfirmed descendants`, async (t) => {
    const processes = windowsProcesses(t);
    const controller = new AbortController();
    const pending = runProcess("fixture", [], { signal: controller.signal });
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert(error instanceof UrmaError);
      assert.equal(error.code, "CANCELLED");
      assert.equal(error.detail.terminationConfirmed, false);
      assert.match(error.message, /descendant termination is unconfirmed/);
      assert.match(error.message, failure === "nonzero exit"
        ? /taskkill exited with code 5/ : /taskkill unavailable/);
      return true;
    });
    controller.abort();
    if (failure === "nonzero exit") processes.killer.emit("close", 5);
    else processes.killer.emit("error", new Error("taskkill unavailable"));
    await setImmediate();
    processes.closeChild();
    await rejected;
    assert.deepEqual(processes.kills.mock.calls.map((call) => call.arguments), [
      [4242, "SIGKILL"],
    ]);
  });
}

test("Windows cancellation waits for taskkill status even when the child closes first", async (t) => {
  const processes = windowsProcesses(t);
  const controller = new AbortController();
  let completed = false;
  const pending = runProcess("fixture", [], { signal: controller.signal });
  const rejected = assert.rejects(pending, (error: unknown) => {
    completed = true;
    assert(error instanceof UrmaError);
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.detail.terminationConfirmed, true);
    return true;
  });
  void rejected.catch(() => undefined);
  controller.abort();
  processes.closeChild();
  await setImmediate();
  const completedBeforeTaskkill = completed;
  processes.killer.emit("close", 0);
  await rejected;
  assert.equal(completedBeforeTaskkill, false);
  assert.equal(processes.kills.mock.callCount(), 0);
});

test("overlapping cancellation and output limits launch only one termination attempt", async (t) => {
  const processes = windowsProcesses(t);
  const controller = new AbortController();
  const pending = runProcess("fixture", [], {
    signal: controller.signal,
    maxStdoutBytes: 1,
    maxStderrBytes: 1,
  });
  const rejected = assert.rejects(pending, /cancelled/);
  controller.abort();
  processes.child.stdout.write("too much output");
  processes.child.stderr.write("too much output");
  processes.killer.emit("close", 0);
  processes.closeChild();
  await rejected;
  assert.equal(processes.taskkills(), 1);
});

test("failed taskkill does not signal an already-exited PID", async (t) => {
  const processes = windowsProcesses(t);
  const controller = new AbortController();
  const pending = runProcess("fixture", [], { signal: controller.signal });
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert(error instanceof UrmaError);
    assert.equal(error.detail.terminationConfirmed, false);
    assert.match(error.message, /already exited/);
    return true;
  });
  controller.abort();
  Object.defineProperty(processes.child, "exitCode", { value: 0 });
  processes.child.emit("exit", 0);
  processes.killer.emit("close", 128);
  processes.child.emit("close", 0);
  await rejected;
  assert.equal(processes.kills.mock.callCount(), 0);
});

test("stalled taskkill is stopped and falls back before the overall cleanup deadline", async (t) => {
  const processes = windowsProcesses(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const pending = runProcess("fixture", [], { signal: controller.signal });
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert(error instanceof UrmaError);
    assert.equal(error.detail.terminationConfirmed, false);
    assert.match(error.message, /taskkill exceeded its 2000 ms cleanup deadline/);
    return true;
  });
  controller.abort();
  t.mock.timers.tick(2_000);
  await setImmediate();
  assert.deepEqual(processes.kills.mock.calls.map((call) => call.arguments), [
    [4242, "SIGKILL"],
  ]);
  processes.closeChild();
  await rejected;
});

test("failed direct fallback preserves the kill failure in the cancellation error", async (t) => {
  const processes = windowsProcesses(t);
  processes.kills.mock.mockImplementation(() => {
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  });
  const controller = new AbortController();
  const pending = runProcess("fixture", [], { signal: controller.signal });
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert(error instanceof UrmaError);
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.detail.terminationConfirmed, false);
    assert.match(error.message, /direct subprocess kill failed.*EPERM/);
    return true;
  });
  controller.abort();
  processes.killer.emit("close", 5);
  await setImmediate();
  processes.closeChild();
  await rejected;
});

test("cancellation is bounded when taskkill and child close both stall", async (t) => {
  const processes = windowsProcesses(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let failure: unknown;
  const pending = runProcess("fixture", [], { signal: controller.signal })
    .catch((error: unknown) => { failure = error; });
  controller.abort();
  t.mock.timers.tick(10_000);
  await setImmediate();
  const completedBeforeChildClose = failure !== undefined;
  processes.closeChild();
  processes.killer.emit("close", 1);
  await pending;
  assert.equal(completedBeforeChildClose, true);
  assert(failure instanceof UrmaError);
  assert.equal(failure.code, "CANCELLED");
  assert.equal(failure.detail.terminationConfirmed, false);
  assert.match(failure.message, /cleanup.*within/i);
  assert.equal(processes.child.stdout.destroyed, true);
  assert.equal(processes.child.stderr.destroyed, true);
});
