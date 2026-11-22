import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Ibarra_Real_Nova, Libre_Franklin, Courier_Prime } from "next/font/google";
import "./globals.css";

const display = Ibarra_Real_Nova({ subsets: ["latin"], weight: ["400", "700"], variable: "--nf-display", display: "swap" });
const body = Libre_Franklin({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--nf-body", display: "swap" });
const data = Courier_Prime({ subsets: ["latin"], weight: ["400", "700"], variable: "--nf-data", display: "swap" });

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
  openGraph: { title: TITLE, description: DESCRIPTION, siteName: "Brake", type: "website", locale: "en_US" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F3F1E7" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${data.variable}`}>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <div className="wrap">
          <header className="top">
            <Link href="/" className="brand"><i>B</i> Brake</Link>
            <span className="note">
              Aevum testnet · demo mode · <Link href="/judge">for judges</Link>
            </span>
          </header>
          <main id="main">{children}</main>
          <footer className="foot">
            Testnet only. Demo runs are signed server-side by a labelled custodial demo payer; amounts are the seed invoices scaled for the faucet.
            Seed emails are authored demo data.
          </footer>
        </div>
      </body>
    </html>
  );
}
