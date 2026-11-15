"use client";
import { useState } from "react";
import type { RunView, TicketView } from "@/lib/types";
import { short, txUrl, fmtTime } from "@/lib/format";

/** A tx hash: a link to explorer-test.qday.info on the live deployment; plain text labelled "fork" on a local fork (no explorer). */
export function ExplorerLink({ run, hash, label }: { run: Pick<RunView, "explorer" | "deployment">; hash: string | null | undefined; label?: string }) {
  if (!hash) return <span className="muted">—</span>;
  const url = txUrl(run, hash);
  const text = label ?? short(hash);
  return url ? (
    <a className="data" href={url} target="_blank" rel="noopener noreferrer" title={hash}>{text}<span className="sr"> (opens the explorer in a new tab)</span></a>
  ) : (
    <span className="data" title={`${hash} — local fork, no explorer`}>{text}<span className="tag">fork</span></span>
  );
}

export function PaidMark({ run, tx }: { run: RunView; tx: string | null }) {
  return (
    <span><span className="paid">PAID</span> <ExplorerLink run={run} hash={tx} /></span>
  );
}

/** Signature element: the STOP PAYMENT stamp. Serial = short cancel tx hash, date = when the stop was recorded. */
export function StopStamp({ run, tx, at, small }: { run: RunView; tx: string | null; at?: string | null; small?: boolean }) {
  if (small) return <span className="stamp sm" aria-label="stopped"><b>STOP</b></span>;
  return (
    <span className="stamp" role="img" aria-label={`Stop payment stamp, serial ${tx ?? "pending"}`}>
      <b>STOP PAYMENT</b>
      <small>No. <ExplorerLink run={run} hash={tx} /></small>
      {at ? <small title="time the stop was recorded">{fmtTime(at)}</small> : null}
    </span>
  );
}

export function TxStatus({ run, hash, state }: { run: RunView; hash: string | null | undefined; state: "sent" | "in block" | "confirmed" | "failed"; }) {
  const label = { sent: "sent…", "in block": "in a block", confirmed: "confirmed", failed: "failed" }[state];
  return <span><span className={state === "failed" ? "err" : state === "confirmed" ? "ok" : "muted"}>{label}</span> <ExplorerLink run={run} hash={hash} /></span>;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn ghost small" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "Copied" : label}
    </button>
  );
}

export function RecoveryTicket({ ticket }: { ticket: TicketView }) {
  return (
    <div className="panel alarm" role="note">
      <h3>Too late — recovery ticket {ticket.id.slice(-6)}</h3>
      <p>{ticket.body}</p>
      <p className="note">Status: {ticket.status}. Brake does not claim a recovery; finance contacts the vendor.</p>
    </div>
  );
}

export function AlarmBanner({ run }: { run: RunView }) {
  const stops = run.lines.filter((l) => ["STOPPED", "CONSUMED", "TOO_LATE"].includes(l.status) && l.reissuedFrom === null).length;
  const alarm = run.tickets.find((t) => t.kind === "alarm" || t.kind === "escalation");
  if (!alarm && stops < run.maxStops) return null;
  return (
    <div className="panel alarm" role="alert">
      <h3>Agent has used its {run.maxStops} stops for this run.</h3>
      <p>Further stops need you: a line the agent can no longer stop is held — <b>Stop it or Allow it yourself</b> on the Payday screen.</p>
    </div>
  );
}
