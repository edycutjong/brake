import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Ibarra_Real_Nova, Libre_Franklin, Courier_Prime } from "next/font/google";
import "./globals.css";
import Mast, { Mark } from "@/components/Mast";

// fallbacks are the metric-matched faces measured for the landing page (globals.css), so the swap does not shift layout
const display = Ibarra_Real_Nova({ subsets: ["latin"], weight: ["400", "700"], variable: "--nf-display", display: "swap", adjustFontFallback: false, fallback: ["Ibarra Fallback", "Georgia", "serif"] });
const body = Libre_Franklin({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--nf-body", display: "swap", adjustFontFallback: false, fallback: ["Franklin Fallback", "Arial", "sans-serif"] });
// next/font has no monospace fallback metrics (it would fall back to Arial and reflow every data line); Courier New is metric-matched
const data = Courier_Prime({ subsets: ["latin"], weight: ["400", "700"], variable: "--nf-data", display: "swap", adjustFontFallback: false, fallback: ["Courier Fallback", "Courier New", "monospace"] });

const TITLE = "Brake — stop a payment run before it clears";
const DESCRIPTION =
  "A stop-payment order for pre-signed tUSD8 payment runs on Aevum: an agent reads vendor email and can only cancel, never pay.";
// Absolute base for og:image / canonical: PUBLIC_URL when set, else the Vercel production host, else local dev.
const BASE =
  process.env.PUBLIC_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

// icon.svg and opengraph-image.png in this folder are picked up by the App Router file conventions.
export const metadata: Metadata = {
  metadataBase: new URL(BASE),
  title: TITLE,
  description: DESCRIPTION,
  authors: [{ name: "Edy Cu", url: "https://github.com/edycutjong" }],
  creator: "Edy Cu",
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", siteName: "Brake", type: "website", locale: "en_US" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, creator: "@edycutjong" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F3F1E7" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${data.variable}`}>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <Mast />
        <main id="main" className="wrap">{children}</main>
        <footer className="foot">
          <div className="wrap">
            <div>
              <Link href="/" className="brand" style={{ fontSize: "1.3rem" }}><Mark />Brake</Link>
              <p>Pre-signed stop-payments for stablecoin payment runs on Aevum testnet. Built for the QDay Aevum Builder Challenge #1 on DoraHacks.</p>
            </div>
            <div>
              <h2 className="fh">App</h2>
              <ul><li><Link href="/">Start a demo run</Link></li><li><Link href="/verify">Verify on-chain</Link></li><li><Link href="/judge">For judges</Link></li></ul>
            </div>
            <div>
              <h2 className="fh">Project</h2>
              <ul><li><a href="https://brake.edycu.dev/">Landing page</a></li><li><a href="https://brake.edycu.dev/pitch/">Pitch deck</a></li><li><a href="https://github.com/edycutjong/brake">Source on GitHub</a></li></ul>
            </div>
            <p className="legal">
              Testnet only. Demo runs are signed server-side by a labelled custodial demo payer; amounts are the seed invoices scaled for the faucet.
              Seed emails are authored demo data.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
