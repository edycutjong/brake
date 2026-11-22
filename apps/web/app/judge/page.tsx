import type { Metadata } from "next";
import Link from "next/link";

// A page for exactly one reader: a judge with five minutes. No auth, no session, no data fetch — it renders even when
// the database or chain is down. Every figure below greps to a file in this repo (path given next to it).
export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Brake — for judges",
  description: "The claim, the 30-second path, the receipts and the honest limits of Brake, on one page.",
};

const REPO = "https://github.com/edycutjong/brake";
const blob = (p: string) => `${REPO}/blob/main/${p}`;

const CLAIM = "We gave the agent the inbox. It still can't move a cent.";

export default function Judge() {
  return (
    <>
      <p className="label"><span className="no">J-1</span> For judges · <b>five minutes</b></p>
      <h1>{CLAIM}</h1>
      <p className="lede">
        Finance signs each tUSD8 payment line together with its matching <span className="data">cancelAuthorization</span>. A monitor
        agent reads vendor email and can stop or hold a line before payday. It holds no payment signature and 0 tUSD8, so it cannot
        create a payment or change a payee. The cancel is enforced by the token itself, not by our contract.
      </p>

      <section className="panel" aria-labelledby="path">
        <h2 id="path">The 30-second path</h2>
        <ol className="steps">
          <li>
            <div>
            Open the <a href="https://brake.edycu.dev/">landing page</a> and press Replay on the recorded{" "}
            <span className="data">pnpm demo:hero · fork</span> terminal: four lines ALLOW, a vendor email arrives, line 3 is stopped,
            three lines pay in one batch, line 3&apos;s payment reverts with the token&apos;s own error.
            </div>
          </li>
          <li>
            <div>
            In this app, press <Link href="/">Start a demo run</Link>, then &ldquo;Play the hero&rdquo; on the run sheet (no wallet
            needed; a labelled custodial demo payer signs).
            </div>
          </li>
          <li>
            <div>
            Read the one test that pins the claim:{" "}
            <a href={blob("test/Brake.t.sol")} className="data">
              test_agentHoldsNoSpendingPower_brakeNeverHoldsFunds
            </a>
            .
            </div>
          </li>
          <li>
            <div>
            Check the evidence yourself on <Link href="/verify">Verify</Link>: contracts, tUSD8 observations and an in-browser
            recompute of each evidence hash.
            </div>
          </li>
        </ol>
      </section>

      <section className="panel" aria-labelledby="receipts">
        <h2 id="receipts">Receipts</h2>
        <p className="note">
          Measured on an anvil fork of Aevum testnet 44005 (live tUSD8 bytecode and state at block 3,252,000). The live testnet
          re-run is pending testnet funding; these are fork figures and say so.
        </p>
        <dl className="kv">
          <dt>Tests</dt>
          <dd>
            126 green: 50 Foundry fork tests, 12 brake-signer, 64 engine (<a href={blob("evidence/test-counts.json")}>test-counts.json</a>)
          </dd>
          <dt>Property checks</dt>
          <dd>
            30,000 generated cases, 0 counterexamples: no model output overrides a rule STOP; a fabricated quote never verifies;
            unverified findings never ALLOW (<a href={blob("packages/engine/test/properties.test.ts")}>properties.test.ts</a>)
          </dd>
          <dt>Model-only stop</dt>
          <dd>
            Line 3 stopped in 5/5 runs with zero rules fired; with the model removed, line 3 pays (<a href={blob("DEMO.md")}>DEMO.md</a>)
          </dd>
          <dt>Injection suite</dt>
          <dd>19/19 tuning, 6/6 held out with the model; rules alone 4/19 and 2/6 — a 25-email regression suite, not a detection rate</dd>
          <dt>Email → cancel confirmed</dt>
          <dd>
            p50 4,116 ms · p95 6,285 ms, n=11, fork (<a href={blob("bench/results.json")}>bench/results.json</a>)
          </dd>
          <dt>Agent-initiated transfers</dt>
          <dd>0</dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="repro">
        <h2 id="repro">Reproduce</h2>
        <pre className="data" style={{ overflowX: "auto", maxWidth: "100%", whiteSpace: "pre" }}>{`pnpm install && forge test          # 50 fork tests against live tUSD8 bytecode
pnpm fork:up                         # anvil fork of 44005, deploys Brake + registries
pnpm demo:hero                       # the hero, with a real model (Anthropic key or claude-cli)
python3 scripts/bench.py             # re-derives p50/p95 from evidence/bench-rows.json`}</pre>
        <p className="note">
          The model path is real: with no model configured the engine fails closed and holds every line. The ablation
          (<span className="data">BRAKE_MODEL=none</span>) exists only to show what the rules alone miss.
        </p>
      </section>

      <section className="panel" aria-labelledby="limits">
        <h2 id="limits">Honest limitations</h2>
        <ul>
          <li>Brake stops only what its rules or model flag; a missed fraud pays as it would without Brake.</li>
          <li>
            The cancellation budget binds only the Brake path: anyone holding a raw cancel signature can submit it, so a compromised
            server could cancel every line (it still could not pay one).
          </li>
          <li>Demo mode signs with a server-held testnet key; the non-custodial path is the local signing script.</li>
          <li>The tUSD8 issuer holds pause and blacklist powers. Tested on Aevum testnet only.</li>
        </ul>
      </section>

      <section className="panel" aria-labelledby="links" style={{ overflowWrap: "anywhere" }}>
        <h2 id="links">Links</h2>
        <ul>
          <li>
            Repo: <a href={REPO}>{REPO}</a>
          </li>
          <li>
            Landing: <a href="https://brake.edycu.dev/">brake.edycu.dev</a> · Deck:{" "}
            <a href="https://brake.edycu.dev/pitch/">brake.edycu.dev/pitch</a>
          </li>
          <li>
            Architecture: <a href={blob("ARCHITECTURE.md")}>ARCHITECTURE.md</a> · Demo and reproduce: <a href={blob("DEMO.md")}>DEMO.md</a>
          </li>
          <li>
            tUSD8 on the explorer:{" "}
            <a href="https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483" className="data">
              0x4565…3483
            </a>
          </li>
        </ul>
      </section>
    </>
  );
}
