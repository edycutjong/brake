import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { REPO_ROOT } from "./config.js";

const SEED = join(REPO_ROOT, "seed");
const json = <T>(f: string): T => JSON.parse(readFileSync(join(SEED, f), "utf8")) as T;

export interface VendorFixture {
  id: string;
  name: string;
  domain: string;
  payeeIdx: number;
  genuineIdx: number;
  payeeChangedDaysAgo: number | null;
  changeSource: string | null;
  verified: string | null;
  verifiedBy?: string;
  contractContact: string;
}
export interface InvoiceFixture {
  id: string;
  vendorId: string;
  amount: number;
  status: string;
}
export interface RunFixture {
  lines: string[];
  maxStops: number;
  alarmAt: number;
  paydayDelaySec: number;
  windowHours: number;
  copy: string[];
  deliver: string[];
}
export interface MailTemplate {
  id: string;
  from: string;
  subject: string;
  /** "-20d" (history before the window), "+Ns" (seconds after run creation), or "deliver" (scripted delivery) */
  at: string;
  body: string;
}

export const vendorFixtures = () => json<VendorFixture[]>("vendors.json");
export const invoiceFixtures = () => json<InvoiceFixture[]>("invoices.json");
export const runFixtures = () => json<Record<string, RunFixture>>("runs.json");

export function payeeAddress(mnemonic: string, idx: number): Address {
  return mnemonicToAccount(mnemonic, { addressIndex: idx }).address;
}

/** tUSD8 has 6 decimals; seed amounts are whole tUSD8 scaled by SEED_SCALE. */
export const toUnits = (amount: number, scale: number): bigint => BigInt(Math.round(amount * scale * 1e6));
export const fromUnits = (u: bigint): string => {
  const s = u.toString().padStart(7, "0");
  // trim trailing zeros of the fraction by index, not regex (CodeQL js/polynomial-redos on /\.?0+$/)
  let frac = s.slice(-6);
  let end = frac.length;
  while (end > 0 && frac[end - 1] === "0") end--;
  frac = frac.slice(0, end);
  const whole = s.slice(0, -6);
  return frac ? `${whole}.${frac}` : whole;
};

export function parseEml(id: string, text: string): MailTemplate {
  const [head, ...rest] = text.split(/\r?\n\r?\n/);
  const h: Record<string, string> = {};
  for (const line of head!.split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) h[m[1]!.toLowerCase()] = m[2]!;
  }
  return { id, from: h.from ?? "", subject: h.subject ?? "", at: h["x-brake-at"] ?? "deliver", body: rest.join("\n\n").trim() };
}

export function mailTemplates(dir = join(SEED, "inbox")): MailTemplate[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".eml"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => parseEml(f.replace(/\.eml$/, ""), readFileSync(join(dir, f), "utf8")));
}

export function fill(s: string, vars: Record<string, string>): string {
  return s.replace(/\{([\w-]+)\}/g, (all, k: string) => vars[k] ?? all);
}

/** Received-at for a template relative to run creation; null = scripted delivery (now). */
export function templateTime(at: string, createdAt: Date): Date | null {
  if (at === "deliver") return null;
  const m = /^([+-]\d+)([smhd])$/.exec(at);
  if (!m) throw new Error(`bad X-Brake-At: ${at}`);
  const mult = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as "s"];
  return new Date(createdAt.getTime() + Number(m[1]) * mult);
}
