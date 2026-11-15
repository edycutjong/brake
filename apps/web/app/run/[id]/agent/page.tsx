"use client";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ApiError, useRunCtx } from "@/lib/client";
import { fmtClock, fmtTime, short, tusd } from "@/lib/format";
import { Copy, ExplorerLink } from "@/components/ui";
import type { DecisionView, Message } from "@/lib/types";

function highlight(body: string, quotes: string[]): ReactNode {
  const hit = quotes.map((q) => ({ q, i: body.indexOf(q) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0];
  if (!hit) return body;
  return <>{body.slice(0, hit.i)}<mark>{hit.q}</mark>{body.slice(hit.i + hit.q.length)}</>;
}

function Mail({ m, quotes }: { m: Message; quotes: string[] }) {
  return (
    <article className={`mail ${m.source === "composer" ? "mine" : ""}`}>
      <div className="h"><span><b>{m.subject}</b> <span className="tag">{m.source === "composer" ? "written by you" : "seed"}</span></span><span className="data">{fmtTime(m.receivedAt)}</span></div>
      <div className="h"><span className="data">from {m.fromAddr}</span></div>
      <div className="b">{highlight(m.body, quotes)}</div>
    </article>
  );
}

const VERDICT_TEXT: Record<string, string> = {
  ALLOW: "ALLOW", STOP: "STOP", HOLD: "HOLD", FINANCE_ALLOW: "Finance allowed", FINANCE_STOP: "Finance stopped",
};
const chipClass = (v: string) => (v === "STOP" || v === "FINANCE_STOP" ? "stop" : v === "FINANCE_ALLOW" ? "fin" : v === "ALLOW" ? "allow" : "");

function DecisionCard({ d, older, explain }: { d: DecisionView; older: DecisionView[]; explain?: string }) {
  const { run } = useRunCtx();
  if (!run) return null;
  const note = d.findings?.map((f) => f.note).filter(Boolean).join(" ");
  const modelOnly = d.verdict === "STOP" && d.rules_fired.length === 0;
  return (
    <div className={`card s-${d.verdict}`}>
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Line {d.idx + 1} · {VERDICT_TEXT[d.verdict]}</h3>
        <span className="data note">{fmtClock(d.created_at)}</span>
      </div>
      <div>{d.reason_code ? <span className={`chip ${chipClass(d.verdict)}`}>{d.reason_code}</span> : null}{d.chain_status ? <span className="chip">chain: {d.chain_status}</span> : null}</div>
      {note ? <p>{note}</p> : null}
      {explain ? <p className="note">{explain}</p> : null}
      <p className="note">
        {d.rules_fired.length
          ? <>Rules fired: {d.rules_fired.map((r) => <span key={r.id} className="chip">{r.id}</span>)}{d.rules_fired.map((r) => r.reason).join("; ")}</>
          : modelOnly ? "Rules fired: none — the model read the email as a payment-detail change (model-only stop)." : "Rules fired: none."}
      </p>
      <dl className="kv">
        <dt>Evidence</dt><dd className="data hash">{short(d.evidence_hash, 10, 8)} <Link href={`/verify?hash=${d.evidence_hash}`}>recompute</Link> <Copy text={d.evidence_hash} /></dd>
        <dt>Tx</dt><dd><ExplorerLink run={run} hash={d.tx} /></dd>
        {d.model && d.model !== "finance" ? <><dt>Model</dt><dd className="data">{d.model}</dd></> : null}
      </dl>
      {older.length ? (
        <div className="hist">History: {older.map((o) => `${fmtClock(o.created_at)} ${o.verdict}`).join(" · ")} → {fmtClock(d.created_at)} {d.verdict}</div>
      ) : null}
    </div>
  );
}

function Composer() {
  const { run, act } = useRunCtx();
  const [vendor, setVendor] = useState("");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("Updated payment details");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<{ linked: string; linkedLines: number[]; asked: string | null; note?: string } | null>(null);
  if (!run) return null;
  const v = run.vendors.find((x) => x.vendor_id === (vendor || run.vendors[0]?.vendor_id));
  const effFrom = from || (v ? `billing@${v.domain}` : "");
  const pickVendor = (id: string) => { setVendor(id); setFrom(""); };

  async function send() {
    setBusy(true); setErr(null); setOut(null);
    try {
      const r = await act<{ linked: string; linkedLines: number[]; note?: string }>("/inbox", { vendor_id: v?.vendor_id, from_addr: effFrom, subject, body });
      setOut({ ...r, asked: /0x[0-9a-fA-F]{40}/.exec(body)?.[0] ?? null });
      setBody("");
    } catch (e) { setErr(e instanceof ApiError || e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const out_ = out;
  return (
    <section className="panel" aria-labelledby="composer-h">
      <h3 id="composer-h">Write an email as a vendor</h3>
      <p className="note">The one control you can turn. Try a lookalike domain, or ask for a new wallet — and watch what the agent does.</p>
      <div className="field"><label htmlFor="vp">Write as</label>
        <select id="vp" value={v?.vendor_id ?? ""} onChange={(e) => pickVendor(e.target.value)}>
          {run.vendors.map((x) => <option key={x.vendor_id} value={x.vendor_id}>{x.name}</option>)}
        </select></div>
      <div className="field"><label htmlFor="fr">From</label><input id="fr" className="data" value={effFrom} onChange={(e) => setFrom(e.target.value)} /></div>
      <div className="field"><label htmlFor="su">Subject</label><input id="su" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
      <div className="field"><label htmlFor="bo">Message</label><textarea id="bo" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Please pay invoice … to our new wallet 0x…" /></div>
      <div className="actions">
        <button className="btn" disabled={busy || !body.trim() || !run.session || run.reviewsLeft <= 0} onClick={send}>{busy ? "Delivering…" : "Send to the agent"}</button>
        <span className="note" role="status">Reviews left {run.reviewsLeft}/10</span>
      </div>
      {run.reviewsLeft <= 0 ? <p className="err">Review budget used for this run — start a new demo run to keep testing.</p> : null}
      {err ? <p className="err" role="alert">{err}</p> : null}
      {out_ ? (
        <div role="status" style={{ marginTop: 10 }}>
          <p><b>{out_.linked}.</b> {out_.note ? <span className="err">{out_.note}</span> : "The agent is reading it now."}</p>
          {out_.linkedLines.map((i) => (
            <p key={i} className="data">Will pay {short(run.lines[i]?.payee)} (signed payee, line {i + 1}) · the email asked for {out_.asked ? short(out_.asked) : "no address"}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default function AgentDesk() {
  const { run, messages } = useRunCtx();
  const byLine = useMemo(() => {
    const m = new Map<number, DecisionView[]>();
    for (const d of run?.decisions ?? []) m.set(d.idx, [...(m.get(d.idx) ?? []), d]);
    return m;
  }, [run?.decisions]);
  if (!run) return null;
  const quotesFor = (id: string) => (run.decisions.flatMap((d) => d.findings ?? []).flatMap((f) => f.quotes).filter((q) => q.messageId === id).map((q) => q.text));
  const vendorOf = (idx: number) => run.vendors.find((v) => v.vendor_id === run.lines[idx]?.vendorId);
  const busy = run.jobs.some((j) => j.status === "queued" || j.status === "running");
  return (
    <>
      <h2>Agent desk</h2>
      <p className="lede">The agent reads vendor email and writes one decision per line. Every decision is an evidence bundle hashed into the ERC-8004 receipt on-chain.</p>
      <div className="desk">
        <div className="col-inbox">
          <h3>Inbox <span className="note">({messages.length})</span></h3>
          {!run.session ? <div className="empty">The inbox is private to the visitor who started this run.</div> : null}
          {run.session && messages.length === 0 ? <div className="empty">No emails yet — write an email as a vendor and try to trick the agent.</div> : null}
          {messages.slice().reverse().map((m) => <Mail key={m.id} m={m} quotes={quotesFor(m.id)} />)}
          {run.session ? <Composer /> : null}
        </div>
        <div className="col-decisions">
          <h3>Decisions {busy ? <span className="note" role="status">· agent reading…</span> : null}</h3>
          {run.decisions.length === 0 ? <div className="empty">{busy ? "The agent is reviewing Monday's mail…" : "No decisions yet."}</div> : null}
          {[...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([idx, ds]) => {
            const latest = ds[ds.length - 1]!;
            const v = vendorOf(idx);
            const explain = latest.verdict === "ALLOW" && v?.payee_change_verified
              ? `${v.name}'s payee changed earlier — verified by ${v.payee_change_verified} (clerk attestation in the vendor file), so the agent let it through.` : undefined;
            return <DecisionCard key={idx} d={latest} older={ds.slice(0, -1)} explain={explain} />;
          })}
          <p className="note">Amounts on the lines: {run.lines.map((l) => `#${l.idx + 1} ${tusd(l.amountUnits)}`).join(" · ")} tUSD8</p>
        </div>
      </div>
    </>
  );
}
