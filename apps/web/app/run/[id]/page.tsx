"use client";
import { useRunCtx } from "@/lib/client";
import { fmtTime, short, STATUS_LABEL, tusd } from "@/lib/format";
import { ExplorerLink, PaidMark, StopStamp } from "@/components/ui";
import HeroWalk from "@/components/HeroWalk";

export default function RunSheet() {
  const { run } = useRunCtx();
  if (!run) return null;
  const vendor = (id: string) => run.vendors.find((v) => v.vendor_id === id);
  const signed = run.lines.filter((l) => l.status !== "REISSUED").length;
  const stopDecision = (idx: number) => [...run.decisions].reverse().find((d) => d.idx === idx && (d.verdict === "STOP" || d.verdict === "FINANCE_STOP"));
  return (
    <>
      <HeroWalk />
      <h2>Run sheet</h2>
      <p className="note" role="status">
        Signed {signed} of {signed} · <b>demo mode</b>: the server signed these with a labelled custodial demo payer
        (non-custodial signing: <span className="data">scripts/sign_local.ts</span>). Run{" "}
        <span className="data" title={run.runId}>{short(run.runId, 8, 6)}</span> opened by{" "}
        <ExplorerLink run={run} hash={run.openTx} label="open tx" />.
      </p>
      <table className="ledger">
        <caption className="sr">Payment run lines</caption>
        <thead>
          <tr><th scope="col">#</th><th scope="col">Vendor</th><th scope="col">Pay to</th><th scope="col">Invoice</th><th scope="col" className="amt">Amount (tUSD8)</th><th scope="col">Payday</th><th scope="col">Status</th></tr>
        </thead>
        <tbody>
          {run.lines.map((l) => {
            const v = vendor(l.vendorId);
            const [label, tone] = STATUS_LABEL[l.status] ?? [l.status, "muted"];
            const sd = stopDecision(l.idx);
            const stopped = ["STOPPED", "CONSUMED"].includes(l.status);
            return (
              <tr key={l.idx} className={l.stopTx && ["STOPPED", "REISSUED"].includes(l.status) ? "stopped" : ""} data-line={l.idx + 1}>
                <td className="n">{l.idx + 1}</td>
                <td>{v?.name ?? l.vendorId}{l.reissuedFrom !== null ? <span className="sub">re-issue of line {l.reissuedFrom + 1}</span> : null}</td>
                <td><span className="data">{short(l.payee)}</span><span className="sub">{v?.domain}</span></td>
                <td className="data">{l.invoice}</td>
                <td className="amt"><span className="v">{tusd(l.amountUnits)}</span></td>
                <td>{fmtTime(l.validAfter)}</td>
                <td className="stampcell">
                  <span className={`st ${tone}`}>{label}</span>
                  {l.status === "PAID" ? <div><PaidMark run={run} tx={l.paidTx} /></div> : null}
                  {l.stopTx && ["STOPPED", "REISSUED"].includes(l.status) ? <div style={{ marginTop: 8 }}><StopStamp run={run} tx={l.stopTx} at={sd?.created_at} /></div> : null}
                  {stopped && l.status !== "STOPPED" ? <div className="sub">see Payday</div> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="note">
        Testnet amounts are the seed invoice figures × {run.seedScale} (the faucet yields about 1 tUSD8 per claim).
      </p>
    </>
  );
}
