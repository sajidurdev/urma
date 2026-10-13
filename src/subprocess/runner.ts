import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  debugFromEnvironment,
  diagnosticLog,
  recordDiagnosticSubprocess,
} from "../core/diagnostics.js";
import { UrmaError } from "../core/errors.js";
import { assertNoProxyEnvironment } from "../remote/egress.js";
import { redactArgs, redactText } from "./redaction.js";

export type ProcessResult = Readonly<{
  executable: string;
  args: readonly string[];
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  wallMs: number;
}>;
export type RunOptions = Readonly<{
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  maxStdoutBytes?: number | undefined;
  maxStderrBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Open read-only and send as child stdin; arguments must use the fixed `fd:` input. */
  inputFile?: string | undefined;
  debug?: boolean | undefined;
  label?: string | undefined;
  diagnosticRole?: string | undefined;
}>;

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "ComSpec",
  "SystemDrive",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "LANG",
  "LC_ALL",
  "TZ",
] as const;

/** Do not pass host credentials, proxy settings, hooks, or browser state to child processes */
export function allowlistedEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = input[key];
    if (value !== undefined) output[key] = value;
  }
  return output;
}

const TASKKILL_TIMEOUT_MS = 2_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 5_000;

type TerminationResult = Readonly<{ confirmed: boolean; detail: string }>;

function terminateSubprocess(child: ChildProcess, failure: string): TerminationResult {
  let detail: string;
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    detail = "the subprocess already exited";
  } else {
    try {
      process.kill(child.pid, "SIGKILL");
      detail = "a direct subprocess kill was requested";
    } catch (error) {
      detail = `the direct subprocess kill failed: ${redactText(String(error))}`;
    }
  }
  return {
    confirmed: false,
    detail: `${failure}; ${detail}; descendant termination is unconfirmed`,
  };
}

async function terminateTree(child: ChildProcess): Promise<TerminationResult> {
  const pid = child.pid;
  if (pid === undefined) return terminateSubprocess(child, "No subprocess PID was available");
  if (process.platform === "win32") {
    const failure = await new Promise<string | null>((resolve) => {
      let killer: ChildProcess;
      try {
        killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
          env: allowlistedEnvironment(),
        });
      } catch (error) {
        resolve(`taskkill could not start: ${redactText(String(error))}`);
        return;
      }
      let finished = false;
      const finish = (failure: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(failure);
      };
      const timer = setTimeout(() => {
        let failure = `taskkill exceeded its ${TASKKILL_TIMEOUT_MS} ms cleanup deadline`;
        try {
          killer.kill("SIGKILL");
        } catch (error) {
          failure += `; stopping taskkill failed: ${redactText(String(error))}`;
        }
        killer.unref();
        finish(failure);
      }, TASKKILL_TIMEOUT_MS);
      killer.once("error", (error) => finish(`taskkill failed: ${redactText(String(error))}`));
      killer.once("close", (code, signal) => finish(code === 0 ? null
        : `taskkill exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}`));
    });
    return failure === null
      ? { confirmed: true, detail: "taskkill completed successfully" }
      : terminateSubprocess(child, failure);
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return { confirmed: true, detail: "Process-group termination was requested" };
    } catch (error) {
      return terminateSubprocess(child, `Process-group termination failed: ${redactText(String(error))}`);
    }
  }
}

async function openRegularInput(file: string): Promise<FileHandle> {
  if (file.length === 0 || file.includes("\0")) {
    throw new UrmaError(
      "INVALID_SOURCE",
      "Subprocess media input path must be non-empty and contain no null bytes",
    );
  }
  let handle: FileHandle | undefined;
  try {
    const pathInfo = await lstat(file);
    if (!pathInfo.isFile()) {
      throw new UrmaError(
        "INVALID_SOURCE",
        "Subprocess media input must be a readable regular file",
      );
    }
    const flags = process.platform === "win32"
      ? "r"
      : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
    handle = await open(file, flags);
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new UrmaError(
        "INVALID_SOURCE",
        "Subprocess media input must be a readable regular file",
      );
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof UrmaError) throw error;
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "Subprocess media input could not be opened as a readable regular file",
      { cause: error },
    );
  }
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  if (
    !executable ||
    executable.includes("\0") ||
    args.some((argument) => argument.includes("\0"))
  ) {
    throw new UrmaError(
      "INVALID_SOURCE",
      "Subprocess executable and arguments must be non-empty and contain no null bytes",
    );
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxStdout = options.maxStdoutBytes ?? 32 * 1024 * 1024;
  const maxStderr = options.maxStderrBytes ?? 2 * 1024 * 1024;
  const debug = options.debug ?? debugFromEnvironment();
  const label = options.label ?? "subprocess";
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError(
      `Subprocess timeoutMs must be a positive safe integer; received ${
        String(timeoutMs)
      }`,
    );
  }
  if (options.signal?.aborted) {
    throw new UrmaError(
      "CANCELLED",
      `Subprocess ${executable} was cancelled before it started`,
    );
  }
  let inputHandle: FileHandle | undefined;
  try {
    if (options.inputFile !== undefined) {
      inputHandle = await openRegularInput(options.inputFile);
    }
    if (options.signal?.aborted) {
      throw new UrmaError(
        "CANCELLED",
        `Subprocess ${executable} was cancelled before it started`,
      );
    }
    const started = performance.now();
    return await new Promise<ProcessResult>((resolve, reject) => {
      const childEnvironment = allowlistedEnvironment(options.env ?? process.env);
      assertNoProxyEnvironment(childEnvironment);
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: childEnvironment,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: [inputHandle?.fd ?? "ignore", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let reason: "timeout" | "cancelled" | "stdout" | "stderr" | null = null;
      let settled = false;
      let closed = false;
      let closeCode: number | null = null;
      let termination: TerminationResult | undefined;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (next: NonNullable<typeof reason>) => {
        if (settled || reason !== null) return;
        reason = next;
        clearTimeout(timer);
        cleanupTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(child.exitCode, {
            confirmed: false,
            detail: `Process-tree cleanup did not complete within ${PROCESS_CLEANUP_TIMEOUT_MS} ms; check for remaining subprocesses before retrying`,
          });
        }, PROCESS_CLEANUP_TIMEOUT_MS);
        void terminateTree(child).then((result) => {
          termination = result;
          if (closed) finish(closeCode, result);
        });
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      timer.unref();
      const onAbort = () => stop("cancelled");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (reason !== null) return;
        if (stdoutBytes > maxStdout) {
          stop("stdout");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (reason !== null) return;
        if (stderrBytes > maxStderr) {
          stop("stderr");
          return;
        }
        stderr.push(chunk);
      });
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const wallMs = Math.round(performance.now() - started);
        recordDiagnosticSubprocess(label, wallMs, options.diagnosticRole);
        diagnosticLog(debug, "subprocess", {
          name: label,
          status: "start-failed",
          exitCode: null,
          wallMs,
          stdoutBytes,
          stderrBytes,
        });
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          new UrmaError(
            missing ? "REQUIRED_BINARY_MISSING" : "INTERNAL_ERROR",
            missing
              ? `Required executable ${
                JSON.stringify(executable)
              } was not found; install it or configure its URMA_* path override`
              : `Could not start executable ${
                JSON.stringify(executable)
              }; verify the configured path and permissions`,
            { cause: error },
          ),
        );
      });
      const finish = (code: number | null, terminationResult?: TerminationResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        const wallMs = Math.round(performance.now() - started);
        recordDiagnosticSubprocess(label, wallMs, options.diagnosticRole);
        diagnosticLog(debug, "subprocess", {
          name: label,
          status: reason ?? (code === 0 ? "succeeded" : "failed"),
          exitCode: code ?? null,
          wallMs,
          stdoutBytes,
          stderrBytes,
          ...(terminationResult === undefined ? {} : {
            terminationConfirmed: terminationResult.confirmed,
            terminationDetail: terminationResult.detail,
          }),
        });
        const detail = {
          retryable: true,
          detail: {
            executable,
            args: redactArgs(args),
            ...(terminationResult === undefined ? {} : {
              terminationConfirmed: terminationResult.confirmed && closed,
              terminationDetail: terminationResult.detail,
            }),
          },
        };
        const terminationMessage = terminationResult?.confirmed && closed
          ? "its process tree was terminated"
          : terminationResult?.detail ?? "process-tree termination is unconfirmed";
        if (reason === "timeout") {
          reject(
            new UrmaError(
              "MEDIA_ACQUISITION_TIMEOUT",
              `${executable} exceeded its ${timeoutMs} ms timeout; ${terminationMessage}`,
              detail,
            ),
          );
        } else if (reason === "cancelled") {
          reject(
            new UrmaError(
              "CANCELLED",
              `${executable} was cancelled; ${terminationMessage}`,
              detail,
            ),
          );
        } else if (reason === "stdout" || reason === "stderr") {
          reject(
            new UrmaError(
              "OUTPUT_LIMIT_EXCEEDED",
              `${executable} ${reason} exceeded its ${
                reason === "stdout" ? maxStdout : maxStderr
              }-byte safety limit; ${terminationMessage}`,
              detail,
            ),
          );
        } else {
          resolve({
            executable,
            args: [...args],
            code: code ?? -1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            wallMs,
          });
        }
      };
      child.once("close", (code) => {
        closed = true;
        closeCode = code;
        if (reason === null || termination !== undefined) finish(code, termination);
      });
    });
  } finally {
    await inputHandle?.close().catch(() => undefined);
  }
}

export async function runChecked(
  executable: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  const result = await runProcess(executable, args, options);
  if (result.code !== 0) {
    const raw = result.stderr.toString("utf8").trim().slice(-4000) ||
      result.stdout.toString("utf8").trim().slice(-4000);
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      `${executable} failed with exit code ${result.code}: ${
        redactText(raw) || "no diagnostic output"
      }`,
      {
        retryable: true,
        detail: { executable, args: redactArgs(args), exitCode: result.code },
      },
    );
  }
  return result;
}
