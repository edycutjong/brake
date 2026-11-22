"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, call, setToken } from "@/lib/client";
import { plain } from "@/lib/format";
// The last recorded live run on Aevum 44005. Every hash on this page comes from these two files, nothing is typed in.
import live from "../../../evidence/hero-live.json";
import vendors from "../../../seed/vendors.json";

const EXPLORER = "https://explorer-test.qday.info/tx/";
const short = (h: string, a = 6, b = 4) => `${h.slice(0, a)}…${h.slice(-b)}`;
const vendorOf = (line: number, reissuedFrom: number | null) => vendors[(reissuedFrom ?? line) - 1];
const step = (prefix: string) => live.steps.find((s) => s.step.startsWith(prefix));
const emailMs = step("deliver E4")?.sinceStartMs ?? 0;
const stopMs = step("review (seed:E4)")?.sinceStartMs ?? 0;
const stopLine = live.lines.find((l) => l.stopTx)!;

function Tx({ h, children }: { h: string; children?: React.ReactNode }) {
  return <a href={EXPLORER + h} target="_blank" rel="noopener noreferrer" title={h}>{children ?? short(h)}<span className="sr"> (opens the explorer)</span></a>;
}

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const r = await call<{ id: string; token: string }>("/api/runs", { method: "POST", body: { scenario: "hero" } });
      setToken(r.id, r.token);
      router.push(`/run/${r.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : plain(e));
      setBusy(false);
    }
  }

  return (
    <>
      <section className="hero">
        <div className="grid">
          <div>
            <p className="label"><span className="no">SP-1</span> Stop-payment order · <b>Live on Aevum testnet 44005</b></p>
            <h1><span className="stamp">Stop</span> a payment run before it clears.</h1>
            <p className="sub">
              Finance pre-signs a week of vendor payments. An agent reads the vendors&apos; email. When one says &ldquo;we changed our bank
              details&rdquo;, the agent can stop that one line on-chain, and it can do nothing else. <strong>It holds no money and no spending allowance.</strong>
            </p>
            <ul className="hp">
              <li><b>0</b>tUSD8 held by the agent</li>
              <li><b>5/5</b>runs where the model alone made the stop</li>
              <li><b>{(live.totalMs / 1000).toFixed(0)} s</b>live hero run, end to end</li>
            </ul>
            <div className="hero-cta">
              <div className="actions">
                <button className="btn" onClick={start} disabled={busy} aria-describedby="start-note">
                  {busy ? "Signing the run…" : "Start a demo run"}
                </button>
                <Link className="btn ghost" href="/verify">Verify on-chain</Link>
                <Link className="btn ghost" href="/judge">For judges</Link>
              </div>
              <p id="start-note" className="note" style={{ margin: 0 }}>
                No wallet needed. A labelled custodial demo payer signs four invoices, opens the run on Aevum testnet and lets the agent
                review Monday&apos;s mail. Then press &ldquo;Play the hero&rdquo; on the run sheet.
              </p>
              {err ? <p className="err" role="alert">{err}</p> : null}
            </div>
          </div>

          <figure className="register" aria-label="The last live payment run">
            <header>
              <h2>Last live run</h2>
              <span>{live.run}<br />{live.model} · tUSD8</span>
            </header>
            <div className="rl head" aria-hidden="true"><span>#</span><span>Vendor · invoice</span><span style={{ textAlign: "right" }}>Amount</span><span>Status</span></div>
            {live.lines.map((l) => {
              const v = vendorOf(l.line, l.reissuedFrom);
              const stopped = !!l.stopTx;
              return (
                <div key={l.line} className={`rl${stopped ? " stopped" : ""}`}>
                  <span>{l.line}</span>
                  <span className="v">{v?.name}<small>{l.invoice} · {l.reissuedFrom ? `re-issue of line ${l.reissuedFrom}` : short(l.payee)}</small></span>
                  <span className="amt">{l.amount}</span>
                  {stopped ? (
                    <span className="stamp bigstamp"><Tx h={l.stopTx!}><b>Stop payment</b><small>No. {short(l.stopTx!)}</small></Tx></span>
                  ) : (
                    <span className="st"><span className="paid">PAID</span><br /><Tx h={l.paidTx!} /></span>
                  )}
                </div>
              );
            })}
            <footer>
              Line 3&apos;s replay on payday reverted (<Tx h={stopLine.proofTx!}>{short(stopLine.proofTx!)}</Tx>):{" "}
              <code>FiatTokenV2: authorization is used or canceled</code>. Every hash opens on the Aevum explorer.
            </footer>
          </figure>
        </div>
      </section>

      <section className="how" aria-label="What happens in the demo">
        <div>
          <p className="d">Monday<small>review</small></p>
          <p>The agent reads each vendor&apos;s mail and allows all four lines on-chain.</p>
          <p className="act">ALLOW ×4 · <Tx h={live.decisions[0].tx} /></p>
        </div>
        <div>
          <p className="d">Tuesday<small>the vendor&apos;s mailbox is compromised</small></p>
          <p>&ldquo;Acme&rdquo; confirms a new payout address. The model stops line 3, {((stopMs - emailMs) / 1000).toFixed(0)} s after the email arrived, with no rule fired.</p>
          <p className="act red">STOP line 3 · <Tx h={stopLine.stopTx!} /></p>
        </div>
        <div>
          <p className="d">Payday<small>one batch</small></p>
          <p>Lines 1, 2 and 4 pay in one Multicall3 batch. Finance phones Acme, re-issues line 3 to the genuine wallet, and it pays.</p>
          <p className="act green">PAID · <Tx h={live.lines[0].paidTx!} /></p>
        </div>
      </section>
    </>
  );
}
