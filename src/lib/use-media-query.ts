"use client";
import { useCallback, useSyncExternalStore } from "react";

/** Whether a CSS media query matches now, updating when it changes. */
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (changed: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
