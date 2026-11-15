"use client";
import Link from "next/link";
import { useState } from "react";
import { useRunCtx } from "@/lib/client";
import { ApiError } from "@/lib/client";

/** "Play the hero": the four labelled steps a cold visitor walks, derived from the run's own state (no hidden shortcuts). */
export default function HeroWalk() {
  const { run, act, payday, id } = useRunCtx();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [phoned, setPhoned] = useState(false);
  const [flag, setFlag] = useState(() => typeof localStorage !== "undefined" && !!localStorage.getItem(`brake:e4:${id}`));
  if (!run || run.scenario !== "hero") return null;

  const real = run.lines.filter((l) => l.reissuedFrom === null);
  const reading = run.jobs.some((j) => j.status === "queued" || j.status === "running");
  const monday = !!run.openTx && real.every((l) => run.decisions.some((d) => d.idx === l.idx)) && !reading;
  const tuesday = run.decisions.some((d) => d.verdict === "STOP") || (flag && monday && !reading);
  const stoppedLines = run.lines.filter((l) => l.status === "STOPPED");
  const paidDay = run.lines.some((l) => l.status === "PAID" || l.proofTx);
  const reissued = run.lines.some((l) => l.reissuedFrom !== null);
  const finished = run.lines.some((l) => l.reissuedFrom !== null && l.status === "PAID");

  const missed = paidDay && !tuesday && !run.lines.some((l) => l.stopTx);
  const cur = !monday ? 1 : !tuesday ? 2 : !paidDay ? 3 : !finished ? 4 : 5;
  const state = (n: number) => (n < cur ? "done" : n === cur ? "cur" : "todo");

  async function run_(name: string, fn: () => Promise<unknown>) {
    setBusy(name); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  if (!run.session) {
    return (
      <section className="panel" aria-labelledby="hero-h">
        <h2 id="hero-h" style={{ marginTop: 0 }}>Play the hero</h2>
        <p>This run belongs to someone else&apos;s session, so its buttons are off. <Link href="/">Start your own demo run</Link> — two minutes, no wallet.</p>
      </section>
    );
  }
  if (missed) {
    return (
      <section className="panel alarm" aria-labelledby="hero-h" role="alert">
        <h2 id="hero-h" style={{ marginTop: 0 }}>Payday already ran</h2>
        <p>Payday ran before Tuesday&apos;s email, so every line was paid to the address on file — including line 3. That is what happens with no agent review. <Link href="/">Start a new demo run</Link> to play the hero from the top.</p>
      </section>
    );
  }
  return (
    <section className="panel" aria-labelledby="hero-h">
      <h2 id="hero-h" style={{ marginTop: 0 }}>Play the hero</h2>
      <p className="lede" style={{ marginBottom: 6 }}>A compromised vendor mailbox asks to move a payment. Four steps, each one a real action — about two minutes.</p>
      <ol className="steps">
        <li className={state(1)}>
          <div><div className="t">Monday — the agent reviews all {real.length} lines</div>
            <div className="d" role="status">{monday ? "All lines read and allowed on-chain." : run.openTx ? "The agent is reading Monday's mail…" : "Opening the run on Aevum…"}</div></div>
          <span />
        </li>
        <li className={state(2)}>
          <div><div className="t">Tuesday — deliver the vendor&apos;s email</div>
            <div className="d">&ldquo;We&apos;ve changed our bank details.&rdquo; The agent should stop line 3 — see the reasoning on the <Link href={`/run/${id}/agent`}>Agent desk</Link>.</div></div>
          {state(2) === "cur" ? (
            <button className="btn small" disabled={!run.session || busy === "e4" || flag} onClick={() => run_("e4", async () => { await act("/inbox", { seed: "E4" }); localStorage.setItem(`brake:e4:${id}`, "1"); setFlag(true); })}>
              {busy === "e4" || flag ? "Agent reading…" : "Deliver Tuesday's email"}
            </button>
          ) : <span />}
        </li>
        <li className={state(3)}>
          <div><div className="t">Payday — pay the clean lines, prove the stopped one can&apos;t clear</div>
            <div className="d" role="status">{payday.busy ? payday.note : "One batched transfer pays what was allowed; the stopped line is replayed and reverts."}</div></div>
          {state(3) === "cur" ? (
            <button className="btn small" disabled={!run.session || payday.busy || !tuesday} onClick={() => void payday.run()}>{payday.busy ? (payday.note?.startsWith("Payment window") ? payday.note.replace(" — payday will run by itself.", "") : "Running payday…") : "Run payday now"}</button>
          ) : <span />}
        </li>
        <li className={state(4)}>
          <div><div className="t">Re-issue — finance pays the vendor&apos;s genuine wallet</div>
            <div className="d">Out-of-band check first: finance phones the vendor on the number in the contract file (simulated in demo).</div>
            {state(4) === "cur" ? (
              <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0", minHeight: 44 }}>
                <input type="checkbox" style={{ width: 24, minHeight: 24 }} checked={phoned} onChange={(e) => setPhoned(e.target.checked)} />
                <span>I phoned the vendor on the number in our contract file <span className="tag">simulated</span></span>
              </label>
            ) : null}</div>
          {state(4) === "cur" ? (
            <button className="btn small" disabled={!run.session || !phoned || busy === "re" || payday.busy} onClick={() => run_("re", async () => {
              for (const s of stoppedLines) await act(`/lines/${s.idx}/reissue`);
              await payday.run(true);
            })}>{busy === "re" ? "Re-issuing…" : "Re-issue and pay"}</button>
          ) : <span />}
        </li>
      </ol>
      {finished ? <p className="ok" role="status">Done — the stopped payment never cleared, and the re-issued one did. See <Link href={`/run/${id}/payday`}>Payday &amp; receipts</Link> and <Link href="/verify">Verify</Link>.</p> : null}
      {err ? <p className="err" role="alert">{err}</p> : null}
      {payday.error ? <p className="err" role="alert">{payday.error}</p> : null}
    </section>
  );
}
