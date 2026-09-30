"use client";
import { useCallback, useEffect, useRef } from "react";

/** What a request settles as when a newer one replaced it first. */
export const SUPERSEDED = Symbol("superseded");

/**
 * A channel where only the newest request may land. Starting one aborts the
 * one before it, and an answer that arrives after a newer request started
 * is discarded even when it could not be aborted, so an earlier answer can
 * never overwrite a later one. Unmounting cancels whatever is in flight.
 */
export function useLatestRequest() {
  const current = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    const pending = current.current;
    current.current = null;
    pending?.abort();
  }, []);
  useEffect(() => cancel, [cancel]);
  const run = useCallback(
    async <T>(
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T | typeof SUPERSEDED> => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      try {
        const value = await work(controller.signal);
        return current.current === controller ? value : SUPERSEDED;
      } catch (error) {
        if (current.current !== controller) return SUPERSEDED;
        throw error;
      } finally {
        if (current.current === controller) current.current = null;
      }
    },
    [],
  );
  return { run, cancel };
}

/** The longest wait between attempts while requests keep failing. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Runs `work` every `intervalMs` while the page is visible, never two at a
 * time: the next run is scheduled only once the previous one has settled.
 * After a failure the wait doubles, up to a minute, until a run succeeds.
 * A hidden tab stops polling; becoming visible again runs straight away.
 */
export function usePolling(work: () => Promise<unknown>, intervalMs: number) {
  const latest = useRef(work);
  useEffect(() => {
    latest.current = work;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false,
      running = false,
      failures = 0;
    const schedule = () => {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      timer = setTimeout(
        tick,
        Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS),
      );
    };
    const tick = async () => {
      if (stopped || running || document.hidden) return;
      running = true;
      try {
        await latest.current();
        failures = 0;
      } catch {
        failures += 1;
      } finally {
        running = false;
        schedule();
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [intervalMs]);
}
