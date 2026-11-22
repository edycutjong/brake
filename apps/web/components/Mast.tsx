"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// The landing page's mark (docs/index.html): double-ruled box with a serif B.
export function Mark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect x="3" y="3" width="58" height="58" fill="none" stroke="currentColor" strokeWidth="4" />
      <rect x="10" y="10" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="32" y="45" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="34" fill="currentColor">B</text>
    </svg>
  );
}

const LINKS = [
  ["/", "Demo run", false],
  ["/verify", "Verify", false],
  ["/judge", "For judges", false],
] as const;

export default function Mast() {
  const path = usePathname();
  const cur = (href: string) => (href === "/" ? path === "/" || path.startsWith("/run/") : path.startsWith(href));
  return (
    <header className="mast">
      <div className="wrap">
        <Link href="/" className="brand" aria-label="Brake, home">
          <Mark />
          Brake
          <span className="env" title="Aevum testnet, chain 44005">testnet</span>
        </Link>
        <nav aria-label="Main">
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} className="nl" aria-current={cur(href) ? "page" : undefined}>{label}</Link>
          ))}
          <a className="nl opt" href="https://brake.edycu.dev/">About</a>
          <a className="btn ghost sm" href="https://brake.edycu.dev/pitch/">Pitch deck</a>
        </nav>
      </div>
    </header>
  );
}
