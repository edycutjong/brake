"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { call } from "@/lib/client";
import { short, plain } from "@/lib/format";
import { Copy, StopStamp } from "@/components/ui";

interface Ev { tx_hash: string; log_index: number; block_number: string; address: string; name: string; run_id: string | null; idx: number | null; args: Record<string, unknown>; final: boolean; finalized: boolean; link: string | null }
interface Events { head: string; finalized: string; confirmations: number; events: Ev[] }
interface Obs { payer: string; agent: string; token: string; allowance: string; agentBalance: string; block: string }
interface Health { deployment: string; contracts: Record<string, string> }
const EXPLORER = "https://explorer-test.qday.info";

function Recompute() {
  const params = useSearchParams();
  const [hash, setHash] = useState(params.get("hash") ?? "");
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setOut(null);
    try {
      const r = await call<{ redacted: boolean; label: string; evidence: unknown }>(`/api/evidence/${hash.trim()}`);
      if (r.redacted) { setOut({ ok: false, text: `${r.label}. Open it from the run that wrote it.` }); return; }
      const { evidenceHash } = await import("brake-signer");
      const again = evidenceHash(r.evidence);
      setOut({ ok: again.toLowerCase() === hash.trim().toLowerCase(), text: `recomputed keccak256(canonical JSON) = ${again}` });
    } catch (e) { setOut({ ok: false, text: plain(e) }); } finally { setBusy(false); }
  }
  useEffect(() => { if (params.get("hash")) void go(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return (
    <section className="panel" aria-labelledby="rc">
      <h3 id="rc">Evidence-hash recompute</h3>
      <p className="note">Fetch the stored evidence bundle and re-hash it in your browser. It must equal the hash written into the ERC-8004 response on-chain.</p>
      <div className="field"><label htmlFor="eh">Evidence hash</label><input id="eh" className="data" value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" /></div>
      <button className="btn small" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash.trim())} onClick={go}>{busy ? "Recomputing…" : "Recompute"}</button>
      {out ? <p role="status" className={out.ok ? "ok data" : "err"} style={{ wordBreak: "break-all" }}>{out.ok ? "MATCH · " : "NO MATCH · "}{out.text}</p> : null}
    </section>
  );
}

export default function Verify() {
  const [ev, setEv] = useState<Events | null>(null);
  const [obs, setObs] = useState<Obs | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const e = await call<Events>("/api/verify/events"); if (live) { setEv(e); setErr(null); } } catch (e) { if (live) setErr(plain(e)); }
    };
    void tick();
    const h = setInterval(() => { if (!document.hidden) void tick(); }, 3000);
    call<Obs>("/api/verify/observations").then((o) => live && setObs(o), () => {});
    call<Health>("/api/health").then((x) => live && setHealth(x), () => {});
    return () => { live = false; clearInterval(h); };
  }, []);
  const live = health?.deployment === "live";
  const fakeRun = { explorer: EXPLORER, deployment: health?.deployment ?? "fork" };
  return (
    <>
      <nav className="nav" aria-label="Screens" style={{ marginTop: 6 }}><Link href="/">Home</Link><Link href="/verify" aria-current="page">Verify</Link></nav>
      <h1>Verify</h1>
      <p className="lede">Everything here is read from the chain or recomputed in your browser — nothing is taken on trust from this page.</p>

      <h2>Contracts</h2>
      {health ? (
        <dl className="kv">
          {Object.entries(health.contracts).map(([k, v]) => (
            <><dt key={k}>{k}</dt><dd key={k + "v"} className="data">{live ? <a href={`${EXPLORER}/address/${v}`} target="_blank" rel="noopener noreferrer">{v}</a> : v}</dd></>
          ))}
        </dl>
      ) : <p className="muted">Loading…</p>}
      {!live && health ? <p className="note">Local fork deployment — addresses exist only on a local copy of Aevum (44005).</p> : null}

      <h2>Live observations <span className="tag">observations, not proof</span></h2>
      {obs ? (
        <dl className="kv">
          <dt>Allowance payer → agent</dt><dd className="data"><b>{obs.allowance}</b> <span className="note">(tUSD8 units; read at block {obs.block})</span></dd>
          <dt>Agent&apos;s tUSD8 balance</dt><dd className="data">{obs.agentBalance} <span className="note">— unsolicited transfers only, not payer funds</span></dd>
        </dl>
      ) : <p className="muted">{err ? "Observations unavailable." : "Reading tUSD8…"}</p>}

      <h2>On-chain events <span className="note" role="status">· polled every 3 s{ev ? ` · head ${ev.head} · finalized ${ev.finalized}` : ""}</span></h2>
      {err ? <p className="err" role="alert">{err}</p> : null}
      {ev && ev.events.length === 0 ? <div className="empty">No events yet — start a demo run and play the hero.</div> : null}
      {ev && ev.events.length ? (
        <div style={{ overflowX: "auto" }}>
          <table className="verify-table">
            <thead><tr><th>Event</th><th>Line</th><th>Block</th><th>Depth</th><th>Tx</th></tr></thead>
            <tbody>
              {ev.events.map((e) => (
                <tr key={e.tx_hash + e.log_index}>
                  <td>{e.name === "LineStopped" ? <StopStamp run={fakeRun as never} tx={null} small /> : null} {e.name}</td>
                  <td className="data">{e.idx === null ? "—" : e.idx + 1}</td>
                  <td className="data">{e.block_number}</td>
                  <td>{e.finalized ? "finalized" : e.final ? `${ev.confirmations}+ blocks` : "in block"}</td>
                  <td className="data">{e.link ? <a href={e.link} target="_blank" rel="noopener noreferrer">{short(e.tx_hash)}<span className="sr"> (opens the explorer in a new tab)</span></a> : <span title="local fork — no explorer">{short(e.tx_hash)} <span className="tag">fork</span></span>} <Copy text={e.tx_hash} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="note">Aevum&apos;s &ldquo;finalized&rdquo; tag lags the head by thousands of blocks (observed ~78 min); the depth column reports soft confirmations and finalization separately.</p>

      <Suspense fallback={null}><Recompute /></Suspense>
    </>
  );
}
