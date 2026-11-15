"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Message, PaydayResult, RunView } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) { super(message); }
}
const tokenKey = (id: string) => `brake:token:${id}`;
export const getToken = (id: string) => (typeof localStorage === "undefined" ? null : localStorage.getItem(tokenKey(id)));
export const setToken = (id: string, t: string) => { localStorage.setItem(tokenKey(id), t); localStorage.setItem("brake:last", id); };

export async function call<T>(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(j.error ?? res.statusText), j);
  return j as T;
}

export interface RunCtx {
  id: string; run: RunView | null; messages: Message[]; error: string | null; token: string | null;
  reload: () => Promise<void>;
  act: <T>(path: string, body?: unknown) => Promise<T>;
  payday: { busy: boolean; note: string | null; result: PaydayResult | null; error: string | null; run: (sweep?: boolean) => Promise<void> };
}
export const RunContext = createContext<RunCtx | null>(null);
export const useRunCtx = () => {
  const c = useContext(RunContext);
  if (!c) throw new Error("outside RunContext");
  return c;
};

/** Polls the run (and its inbox) every 2 s; the demo token lives in localStorage and is sent as a bearer. */
export function useRunState(id: string): RunCtx {
  const [run, setRun] = useState<RunView | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [token, setTok] = useState<string | null>(null);
  const [pd, setPd] = useState<RunCtx["payday"]>({ busy: false, note: null, result: null, error: null, run: async () => {} });
  const busy = useRef(false);

  useEffect(() => setTok(getToken(id)), [id]);
  const reload = useCallback(async () => {
    try {
      const t = getToken(id);
      const r = await call<RunView>(`/api/runs/${id}`, { token: t });
      setRun(r);
      setError(null);
      if (r.session && t) setMessages((await call<{ messages: Message[] }>(`/api/runs/${id}/inbox`, { token: t })).messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);
  useEffect(() => {
    void reload();
    const h = setInterval(() => { if (!document.hidden) void reload(); }, 2000);
    return () => clearInterval(h);
  }, [reload]);

  const act = useCallback(async <T,>(path: string, body?: unknown) => {
    const r = await call<T>(`/api/runs/${id}${path}`, { method: "POST", body: body ?? {}, token: getToken(id) });
    void reload();
    return r;
  }, [id, reload]);

  // payday: retried until the payment window opens (the validAfter wait), then once more for anything newly due
  const runPayday = useCallback(async (sweep = false) => {
    if (busy.current) return;
    busy.current = true;
    setPd({ busy: true, note: "Sending payday…", result: null, error: null, run: runPayday });
    try {
      for (;;) {
        const r = await call<PaydayResult>(`/api/runs/${id}/payday?wait=1${sweep ? "&sweep=1" : ""}`, { method: "POST", body: {}, token: getToken(id) });
        void reload();
        if (r.notYet.length && !r.batchTx && !r.proofs.length) {
          const wait = Math.max(...r.notYet.map((n) => n.secondsLeft));
          for (let s = wait; s > 0; s--) {
            setPd((p) => ({ ...p, note: `Payment window opens in ${s}s — payday will run by itself.` }));
            await new Promise((x) => setTimeout(x, 1000));
          }
          continue;
        }
        setPd({ busy: false, note: null, result: r, error: null, run: runPayday });
        return;
      }
    } catch (e) {
      setPd({ busy: false, note: null, result: null, error: e instanceof Error ? e.message : String(e), run: runPayday });
    } finally {
      busy.current = false;
    }
  }, [id, reload]);
  return { id, run, messages, error, token, reload, act, payday: { ...pd, run: runPayday } };
}
