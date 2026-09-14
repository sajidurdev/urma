import { spawn } from "node:child_process";
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

/**
 * Child processes must not inherit credentials, proxy settings, runtime hooks,
 * browser paths, or arbitrary application state from the Urma host.
 */
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

function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* process already ended */
      }
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* process already ended */
      }
    }
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let reason: "timeout" | "cancelled" | "stdout" | "stderr" | null = null;
    let settled = false;
    const stop = (next: typeof reason) => {
      if (reason === null) reason = next;
      terminateTree(child.pid);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    timer.unref();
    const onAbort = () => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        stop("stdout");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderr) {
        stop("stderr");
        return;
      }
      stderr.push(chunk);
    });
    const cleanup = () => {
      clearTimeout(timer);
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
    child.once("close", (code) => {
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
      });
      const detail = {
        retryable: true,
        detail: { executable, args: redactArgs(args) },
      };
      if (reason === "timeout") {
        reject(
          new UrmaError(
            "MEDIA_ACQUISITION_TIMEOUT",
            `${executable} exceeded its ${timeoutMs} ms timeout and its process tree was terminated`,
            detail,
          ),
        );
      } else if (reason === "cancelled") {
        reject(
          new UrmaError(
            "CANCELLED",
            `${executable} was cancelled and its process tree was terminated`,
            detail,
          ),
        );
      } else if (reason === "stdout" || reason === "stderr") {
        reject(
          new UrmaError(
            "OUTPUT_LIMIT_EXCEEDED",
            `${executable} ${reason} exceeded its ${
              reason === "stdout" ? maxStdout : maxStderr
            }-byte safety limit and its process tree was terminated`,
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
    });
  });
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
