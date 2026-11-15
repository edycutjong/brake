"use client";
import { useState } from "react";
import { ApiError, useRunCtx } from "@/lib/client";
import type { RunView } from "@/lib/types";
import { fmtTime, short, tusd } from "@/lib/format";
import { ExplorerLink, PaidMark, RecoveryTicket, StopStamp, TxStatus } from "@/components/ui";

function heldWhy(run: RunView, idx: number) {
  const latest = [...run.decisions].reverse().find((d) => d.idx === idx);
  // a budget hold is recorded as the agent's STOP decision whose chain action became a hold (executor: StopBudgetExhausted → sendHold)
  if (latest?.verdict === "STOP" && latest.chain_status === "HELD")
    return `Held — the agent wanted to stop this line (${latest.reason_code ?? "STOP"}), but its ${run.maxStops}-stop budget for this run was used up. Held on-chain; finance decides.`;
  const h = [...run.decisions].reverse().find((d) => d.idx === idx && d.verdict === "HOLD");
  if (h?.reason_code === "BUDGET_EXHAUSTED") return `Held — the agent wanted to stop this line, but its ${run.maxStops}-stop budget for this run was used up. Finance decides.`;
  if (h?.reason_code) return `Held (${h.reason_code}) — finance decides.`;
  return "Held — the agent has no current decision for this line (a newer email arrived after its review). Finance decides.";
}

export default function Payday() {
  const { run, act, payday } = useRunCtx();
  const [phoned, setPhoned] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!run) return null;
  const vendor = (id: string) => run.vendors.find((v) => v.vendor_id === id);
  const stopAt = (idx: number) => [...run.decisions].reverse().find((d) => d.idx === idx && /STOP/.test(d.verdict))?.created_at;
  const allDone = run.lines.every((l) => ["PAID", "TOO_LATE", "STOPPED", "CONSUMED", "REISSUED", "EXPIRED", "EXTERNALLY_CANCELLED", "FAILED"].includes(l.status));
  const due = Math.min(...run.lines.map((l) => new Date(l.validAfter).getTime()));
  const wrap = async (k: string, fn: () => Promise<unknown>) => {
    setBusy(k); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof ApiError || e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  return (
    <>
      <h2>Payday &amp; receipts</h2>
      <p className="lede">Payday is one batched <span className="data">transferWithAuthorization</span> call for every allowed line. A stopped line is replayed too — and must revert.</p>
      <div className="actions">
        <button className="btn" disabled={!run.session || payday.busy || !!run.settledAt || allDone} onClick={() => { if (run.scenario === "hero" && !run.decisions.some((d) => d.verdict === "STOP") && !window.confirm("No vendor email has been delivered yet, so every allowed line — including line 3 — pays the address on file. To see the agent stop line 3, cancel and use Play the hero on the Run sheet. Run payday anyway?")) return; void payday.run(!run.lines.some((l) => l.status === "STOPPED" && !run.lines.some((x) => x.reissuedFrom === l.idx))); }}>
          {payday.busy ? "Running payday…" : "Run payday now"}
        </button>
        <span className="note" role="status">{payday.busy ? payday.note : run.settledAt || allDone ? `Settled${run.settledAt ? ` ${fmtTime(run.settledAt)} — unused funds swept back` : " — no line is waiting for payday"}.` : `Scheduled for ${fmtTime(new Date(due).toISOString())}; the keeper also runs it by itself.`}</span>
      </div>
      {payday.error ? <p className="err" role="alert">{payday.error}</p> : null}
      {err ? <p className="err" role="alert">{err}</p> : null}
      {run.sweepTx ? <p className="note">Unused funds swept back to the payer: <ExplorerLink run={run} hash={run.sweepTx} /></p> : null}

      {run.lines.map((l) => {
        const v = vendor(l.vendorId);
        const ticket = run.tickets.find((t) => t.idx === l.idx && t.kind === "recovery");
        return (
          <section key={l.idx} className="card" aria-label={`Line ${l.idx + 1}`}>
            <div className="actions" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>Line {l.idx + 1} · {v?.name ?? l.vendorId} · <span className="data">{l.invoice}</span></h3>
              <span className="data" style={{ fontSize: 22 }}>{tusd(l.amountUnits)} tUSD8</span>
            </div>
            <p className="note">Pay to <span className="data">{short(l.payee)}</span>{l.reissuedFrom !== null ? ` · re-issue of line ${l.reissuedFrom + 1}` : ""}</p>

            {l.status === "PAID" ? <PaidMark run={run} tx={l.paidTx} /> : null}
            {l.stopTx && (l.status === "STOPPED" || l.status === "REISSUED") ? (
              <div>
                <StopStamp run={run} tx={l.stopTx} at={stopAt(l.idx)} />
                {l.proofTx ? (
                  <dl className="kv">
                    <dt>Proof of stop</dt><dd><ExplorerLink run={run} hash={l.proofTx} /></dd>
                    <dt>Returned</dt><dd className="data">{l.proofReason ?? "—"}</dd>
                  </dl>
                ) : <p className="note">Proof of stop appears when payday replays this payment.</p>}
                {l.proofTx ? <p className="note">Expected: this payment can no longer clear.</p> : null}
                {l.status === "STOPPED" && !run.lines.some((x) => x.reissuedFrom === l.idx) ? (
                  <div style={{ marginTop: 10 }}>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0", minHeight: 44 }}>
                      <input type="checkbox" style={{ width: 24, minHeight: 24 }} checked={!!phoned[l.idx]} onChange={(e) => setPhoned({ ...phoned, [l.idx]: e.target.checked })} />
                      <span>I phoned {v?.name} on the number in our contract file <span className="tag">simulated in demo</span></span>
                    </label>
                    <p className="note">Re-issue only pays the vendor&apos;s on-file genuine wallet.</p>
                    <button className="btn small" disabled={!run.session || !phoned[l.idx] || busy === `r${l.idx}`} onClick={() => wrap(`r${l.idx}`, async () => { await act(`/lines/${l.idx}/reissue`); })}>
                      {busy === `r${l.idx}` ? "Re-issuing…" : "Re-issue to the genuine wallet"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {l.status === "CONSUMED" || l.status === "TOO_LATE" ? (
              <>
                <p className="err">This line was already paid — it can&apos;t be stopped. We opened a recovery ticket.</p>
                <ExplorerLink run={run} hash={l.paidTx} />
                {ticket ? <RecoveryTicket ticket={ticket} /> : null}
              </>
            ) : null}
            {l.status === "HELD" ? (
              <div>
                <p className="err">{heldWhy(run, l.idx)}</p>
                <div className="actions">
                  <button className="btn small" disabled={!run.session || !!busy} onClick={() => wrap(`a${l.idx}`, () => act(`/lines/${l.idx}/decide`, { action: "allow" }))}>Allow</button>
                  <button className="btn danger small" disabled={!run.session || !!busy} onClick={() => wrap(`s${l.idx}`, () => act(`/lines/${l.idx}/decide`, { action: "stop" }))}>Stop</button>
                </div>
              </div>
            ) : null}
            {l.status === "EXTERNALLY_CANCELLED" ? <p className="err" role="alert">Unexplained cancel — this payment was cancelled outside Brake. Finance should investigate.</p> : null}
            {l.status === "REISSUED" ? <p className="note">Superseded by line {(run.lines.find((x) => x.reissuedFrom === l.idx)?.idx ?? 0) + 1} — re-issued to the vendor&apos;s genuine wallet.</p> : null}
            {["OPEN", "ALLOWED", "SIGNED"].includes(l.status) ? <p className="note">Scheduled — pays at {fmtTime(l.validAfter)}.</p> : null}
            {payday.busy && ["OPEN", "ALLOWED"].includes(l.status) ? <p role="status"><TxStatus run={run} hash={null} state="sent" /> payment batch</p> : null}
          </section>
        );
      })}
    </>
  );
}
