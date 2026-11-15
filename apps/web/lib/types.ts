export interface LineView {
  idx: number; vendorId: string; invoice: string; payee: string; amountUnits: string; status: string;
  validAfter: string; evidenceRev: number; paidTx: string | null; stopTx: string | null; proofTx: string | null;
  proofReason: string | null; reissuedFrom: number | null; requestHash: string | null;
}
export interface Finding { line: number; intent: string; quotes: { messageId: string; text: string }[]; note: string }
export interface DecisionView {
  idx: number; verdict: "ALLOW" | "STOP" | "HOLD" | "FINANCE_ALLOW" | "FINANCE_STOP"; rev: number; reason_code: string | null;
  rules_fired: { id: string; reason: string; detail: string }[]; quotes?: { messageId: string; text: string }[]; findings?: Finding[];
  model: string | null; evidence_hash: string; tx: string | null; chain_status: string | null; created_at: string;
}
export interface TicketView { id: string; kind: string; idx: number | null; body: string; status: string; created_at: string }
export interface VendorView { vendor_id: string; name: string; domain: string; payee: string; payee_change_verified: string | null }
export interface RunView {
  id: string; runId: string; scenario: string; payer: string; agent: string; agentId: string; validAfter: string; validBefore: string;
  maxStops: number; openTx: string | null; sweepTx: string | null; settledAt: string | null; reviewsLeft: number; explorer: string;
  seedScale: number; contracts: Record<string, string>; deployment: string; vendors: VendorView[]; lines: LineView[];
  decisions: DecisionView[]; jobs: { id: string; trigger: string; status: string; attempts: number; error: string | null; created_at: string }[];
  tickets: TicketView[]; revokedTx: string | null; revokedAt: string | null; session: boolean;
}
export interface Message { id: string; fromAddr: string; fromDomain: string; subject: string; body: string; receivedAt: string; vendorId: string | null; source: string }
export interface PaydayResult {
  notYet: { idx: number; secondsLeft: number }[]; paid: { idx: number; tx: string }[];
  proofs: { idx: number; tx: string; replayed: string }[]; held: { idx: number; reason: string }[]; batchTx?: string;
}
