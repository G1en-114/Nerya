"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type OverviewResource<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  refresh: () => Promise<void>;
};

/** Independent panels: a slow feed never blocks account or risk information. */
export function useOverviewResource<T>(load: () => Promise<T>, seconds: number): OverviewResource<T> {
  const [state, setState] = useState<Omit<OverviewResource<T>, "refresh">>({ data: null, error: null, loading: true, updatedAt: null });
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const current = generation.current;
    setState((previous) => ({ ...previous, loading: true }));
    const request = (async () => {
      try {
        const data = await load();
        if (data && typeof data === "object" && "ok" in data && data.ok === false) {
          throw new Error("error" in data ? String(data.error) : "Data unavailable");
        }
        if (current === generation.current) setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (error) {
        if (current === generation.current) setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error), loading: false }));
      } finally {
        if (current === generation.current) inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  }, [load]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    setState({ data: null, error: null, loading: true, updatedAt: null });
    void refresh();
    return () => { generation.current += 1; inFlight.current = null; };
  }, [refresh]);

  useEffect(() => {
    if (!seconds) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, Math.max(5, seconds) * 1000);
    return () => clearInterval(timer);
  }, [refresh, seconds]);
  return { ...state, refresh };
}
