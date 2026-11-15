"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { RunContext, useRunState, useRunCtx } from "@/lib/client";
import { agentStops, fmtTime, tusd } from "@/lib/format";
import { AlarmBanner } from "./ui";

function Money() {
  const { run } = useRunCtx();
  if (!run) return null;
  const live = run.lines.filter((l) => l.status !== "REISSUED");
  const total = live.reduce((s, l) => s + BigInt(l.amountUnits), 0n);
  const stopped = run.lines.filter((l) => l.stopTx && ["STOPPED", "REISSUED"].includes(l.status)).reduce((s, l) => s + BigInt(l.amountUnits), 0n);
  const paid = live.filter((l) => l.status === "PAID" || (l.status === "TOO_LATE" && l.paidTx)).reduce((s, l) => s + BigInt(l.amountUnits), 0n);
  return (
    <div className="stat" aria-live="polite">
      <div><div className="label">Run total</div><div className="big">{tusd(total)} <span className="label">tUSD8</span></div></div>
      <div><div className="label">Stopped before it cleared</div><div className="big" style={{ color: stopped > 0n ? "var(--after)" : undefined }}>{tusd(stopped)}</div></div>
      <Countdown />
      <div><div className="label">Paid</div><div className="big" style={{ color: paid > 0n ? "var(--cleared)" : undefined }}>{tusd(paid)}</div></div>
    </div>
  );
}

function Countdown() {
  const { run } = useRunCtx();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);
  if (!run || run.settledAt) return null;
  const open = run.lines.filter((l) => !["PAID", "REISSUED", "STOPPED", "CONSUMED", "TOO_LATE"].includes(l.status));
  if (!open.length) return null;
  const due = Math.min(...open.map((l) => new Date(l.validAfter).getTime()));
  const s = Math.max(0, Math.round((due - now) / 1000));
  return <div><div className="label">Payday</div><div className="big" style={{ fontSize: 28 }}>{s > 0 ? `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "window open"}</div></div>;
}

function GrantBar() {
  const { run, act } = useRunCtx();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!run) return null;
  const used = agentStops(run);
  return (
    <div className="panel" aria-label="Agent grant">
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <div>
          {run.revokedTx ? <b className="alarm-text">Agent revoked{run.revokedAt ? ` at ${fmtTime(run.revokedAt)}` : ""} — no further stops through Brake.</b> : <b>Agent may cancel {run.maxStops} of {run.lines.filter((l) => l.reissuedFrom === null).length} lines</b>} · stops used {Math.min(used, run.maxStops)}/{run.maxStops} ·
          expires {fmtTime(run.validBefore)} <span className="note">(= validBefore, payday + 48 h)</span>
          <div className="note">The agent holds no spending allowance and no funds — its only power is submitting a pre-signed cancel.</div>
        </div>
        <button className="btn ghost small" disabled={busy || !run.session || !!run.settledAt || !!run.revokedTx} onClick={async () => {
          setBusy(true); setErr(null);
          try { await act("/revoke"); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
        }}>{run.revokedTx ? "Revoked" : busy ? "Revoking…" : "Revoke agent"}</button>
      </div>
      {err ? <p className="err" role="alert">{err}</p> : null}
    </div>
  );
}

const TABS = [["", "Run sheet"], ["/agent", "Agent desk"], ["/payday", "Payday & receipts"]] as const;

export default function RunShell({ id, children }: { id: string; children: ReactNode }) {
  const ctx = useRunState(id);
  const path = usePathname();
  const base = `/run/${id}`;
  const { run, error } = ctx;
  return (
    <RunContext.Provider value={ctx}>
      <nav className="nav" aria-label="Run screens" style={{ marginTop: 6 }}>
        {TABS.map(([p, l]) => (
          <Link key={l} href={base + p} aria-current={path === base + p ? "page" : undefined}>{l}</Link>
        ))}
        <Link href="/verify" aria-current={path === "/verify" ? "page" : undefined}>Verify</Link>
      </nav>
      <h1>Payment run · week 47</h1>
      {error && !run ? (
        <div className="panel alarm" role="alert"><h3>This run could not be loaded</h3><p>{error}</p><p><Link href="/">Start a new demo run</Link></p></div>
      ) : !run ? (
        <p className="muted" role="status">Loading the run…</p>
      ) : (
        <>
          {run.deployment !== "live" ? (
            <p className="note" role="note">Local fork — transactions exist only on a local copy of Aevum and have no explorer links.</p>
          ) : null}
          <Money />
          {!run.session ? (
            <div className="panel" role="note"><b>Read-only view.</b> This run belongs to another visitor&apos;s session. <Link href="/">Start your own demo run</Link>.</div>
          ) : null}
          <AlarmBanner run={run} />
          <GrantBar />
          {children}
        </>
      )}
    </RunContext.Provider>
  );
}
