import { UrmaError } from "../core/errors.js";

type Entry = {
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  observers: number;
  settled: boolean;
};

/**
 * Coalesces identical in-flight acquisition work while keeping cancellation
 * local to each observer. The shared worker is cancelled only after every
 * observer has detached.
 */
export class Singleflight {
  readonly #entries = new Map<string, Entry>();

  get size(): number {
    return this.#entries.size;
  }

  run<T>(
    key: string,
    signal: AbortSignal | undefined,
    worker: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!key) {
      return Promise.reject(
        new UrmaError(
          "INTERNAL_ERROR",
          "Singleflight acquisition key must not be empty",
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new UrmaError(
          "CANCELLED",
          "Operation was cancelled before acquisition began",
        ),
      );
    }

    let entry = this.#entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) {
          throw new UrmaError(
            "CANCELLED",
            "Shared acquisition was cancelled before its worker began",
          );
        }
        return worker(controller.signal);
      });
      entry = { controller, promise, observers: 0, settled: false };
      this.#entries.set(key, entry);
      const created = entry;
      void promise.then(
        () => this.#settle(key, created),
        () => this.#settle(key, created),
      );
    }

    entry.observers += 1;
    const observed = entry;
    return new Promise<T>((resolve, reject) => {
      let attached = true;
      const detach = () => {
        if (!attached) return;
        attached = false;
        signal?.removeEventListener("abort", onAbort);
        observed.observers -= 1;
        if (observed.observers === 0 && !observed.settled) {
          observed.controller.abort();
        }
      };
      const onAbort = () => {
        detach();
        reject(
          new UrmaError(
            "CANCELLED",
            "Operation was cancelled while waiting for shared acquisition work",
          ),
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void observed.promise.then(
        (value) => {
          if (!attached) return;
          detach();
          resolve(value as T);
        },
        (error: unknown) => {
          if (!attached) return;
          detach();
          reject(error);
        },
      );
    });
  }

  #settle(key: string, entry: Entry): void {
    entry.settled = true;
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
  }
}
