"use client";
import { useEffect, useState } from "react";

/**
 * A render-safe clock for relative times ("checked 2 minutes ago"). Renders
 * stay pure: the time comes from state and advances on an interval.
 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
