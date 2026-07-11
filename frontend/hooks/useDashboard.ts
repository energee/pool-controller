// useDashboard(): polls GET /state every 3s ({cache:'no-store'}) and exposes the
// snapshot plus connection metadata. refresh() is the explicit re-fetch used
// after a command (the former afterChange()).
import { useCallback, useEffect, useRef, useState } from "react";

import { getState } from "../lib/api";
import type { State } from "../types";

const POLL_MS = 3000;

export interface Dashboard {
  state: State | null;
  connected: boolean;
  error: string | null;
  age: number | null;
  refresh: () => Promise<void>;
}

export function useDashboard(): Dashboard {
  const [state, setState] = useState<State | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await getState();
      if (!mounted.current) return;
      setState(s);
      setConnected(true);
      // s.error carries any backend-reported bus error; "" reads as no error.
      setError(s.error ?? null);
    } catch (e) {
      if (!mounted.current) return;
      // Network/HTTP failure -> surface "unreachable" in the connection pill.
      setConnected(false);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (mounted.current) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  // age is reported by the backend on the snapshot (seconds since last packet).
  const age = state?.age ?? null;
  return { state, connected, error, age, refresh };
}
