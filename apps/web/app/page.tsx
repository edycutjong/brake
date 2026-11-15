"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, call, setToken } from "@/lib/client";
import { plain } from "@/lib/format";

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
      <h1>Stop a payment run before it clears.</h1>
      <p className="lede">
        Finance pre-signs a week of vendor payments. An agent reads the vendors&apos; email. When one says &ldquo;we changed our bank details&rdquo;,
        the agent can stop that one line on-chain — and it can do nothing else. It holds no money and no spending allowance.
      </p>
      <div className="hero-cta">
        <button className="btn" onClick={start} disabled={busy} aria-describedby="start-note">
          {busy ? "Signing the run…" : "Start a demo run (no wallet needed)"}
        </button>
        <p id="start-note" className="note">
          Signs four invoices with a labelled custodial demo payer, opens the run on Aevum testnet, and lets the agent review Monday&apos;s mail.
          Then press &ldquo;Play the hero&rdquo; on the run sheet.
        </p>
        {err ? <p className="err" role="alert">{err}</p> : null}
        <p><Link href="/verify">Verify on-chain events and evidence</Link></p>
      </div>
    </>
  );
}
