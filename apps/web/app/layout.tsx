import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Ibarra_Real_Nova, Libre_Franklin, Courier_Prime } from "next/font/google";
import "./globals.css";

const display = Ibarra_Real_Nova({ subsets: ["latin"], weight: ["400", "700"], variable: "--nf-display", display: "swap" });
const body = Libre_Franklin({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--nf-body", display: "swap" });
const data = Courier_Prime({ subsets: ["latin"], weight: ["400", "700"], variable: "--nf-data", display: "swap" });

export const metadata: Metadata = {
  title: "Brake — stop a payment run before it clears",
  description: "A stop-payment order for pre-signed tUSD8 payment runs on Aevum: an agent reads vendor email and can only cancel, never pay.",
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
            <span className="note">Aevum testnet · demo mode</span>
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
