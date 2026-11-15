import type { RunView } from "./types";

/** tUSD8 has 6 decimals. */
export function tusd(units: string | bigint): string {
  const s = BigInt(units).toString().padStart(7, "0");
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
export const short = (h: string | null | undefined, a = 6, b = 4) => (h ? `${h.slice(0, a)}…${h.slice(-b)}` : "—");
export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export function txUrl(run: Pick<RunView, "explorer" | "deployment">, h: string) {
  return run.deployment === "live" ? `${run.explorer}/tx/${h}` : null;
}
export const TERMINAL = ["STOPPED", "CONSUMED", "TOO_LATE", "EXTERNALLY_CANCELLED", "PAID", "REISSUED", "FAILED", "EXPIRED"];
export const STATUS_LABEL: Record<string, [string, "before" | "after" | "cleared" | "muted"]> = {
  SIGNED: ["Signing", "muted"], OPEN: ["Scheduled", "before"], ALLOWED: ["Scheduled · agent allowed", "before"], HELD: ["Held", "muted"],
  STOPPED: ["Stopped", "after"], CONSUMED: ["Too late", "after"], TOO_LATE: ["Too late", "after"],
  EXTERNALLY_CANCELLED: ["Unexplained cancel", "after"], PAID: ["Paid", "cleared"], REISSUED: ["Superseded by re-issue", "muted"],
  FAILED: ["Failed", "after"], EXPIRED: ["Expired", "muted"],
};
/** Plain-language errors (ui.md): the API's message is already plain; map the bare transport cases. */
export function plain(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror/i.test(m)) return "Can't reach the server. Check your connection and try again.";
  return m;
}
