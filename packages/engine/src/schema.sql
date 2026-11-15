-- Brake schema. The chain is the source of truth for line status; these rows are the off-chain record and job state.
create table if not exists vendors (
  id text primary key, name text not null, domain text not null, payee text not null, genuine_payee text not null,
  payee_changed_at timestamptz, payee_change_source text, payee_change_verified text, payee_change_verified_by text,
  contract_contact text);
create table if not exists invoices (
  id text primary key, vendor_id text not null references vendors, amount_units numeric not null, status text not null);

create table if not exists runs (
  id text primary key, run_id text not null unique, scenario text not null, payer text not null, agent text not null,
  agent_id numeric not null, valid_after timestamptz not null, valid_before timestamptz not null,
  max_stops int not null, alarm_at int not null, open_tx text, session_hash text not null,
  demo boolean not null default true, reviews_used int not null default 0, created_at timestamptz not null default now());

-- per-run snapshots: finance changes and re-issues write here only, so one visitor's run never changes the next
create table if not exists run_vendors (
  run_id text not null references runs on delete cascade, vendor_id text not null, name text not null, domain text not null,
  payee text not null, genuine_payee text not null, payee_changed_at timestamptz, payee_change_source text,
  payee_change_verified text, payee_change_verified_by text, contract_contact text, primary key (run_id, vendor_id));
create table if not exists run_invoices (
  run_id text not null references runs on delete cascade, invoice_id text not null, vendor_id text not null,
  amount_units numeric not null, status text not null, primary key (run_id, invoice_id));

create table if not exists lines (
  run_id text not null references runs on delete cascade, idx int not null, vendor_id text not null, invoice_id text not null,
  payee text not null, amount_units numeric not null, nonce text not null, request_hash text,
  status text not null, -- OPEN ALLOWED HELD STOPPED CONSUMED TOO_LATE EXTERNALLY_CANCELLED PAID REISSUED FAILED EXPIRED
  valid_after timestamptz not null, valid_before timestamptz not null, window_start timestamptz not null,
  paid_tx text, stop_tx text, proof_tx text, reissued_from int, evidence_rev int not null default 0,
  primary key (run_id, idx));

create table if not exists signatures (
  run_id text not null, idx int not null, kind text not null check (kind in ('payment','cancel')),
  ciphertext bytea not null, iv bytea not null, tag bytea not null, primary key (run_id, idx, kind));

create table if not exists inbox (
  id text primary key, run_id text references runs on delete cascade, -- null = seed template, never read by an agent
  seed_id text, vendor_id text, from_addr text not null, from_domain text not null, subject text not null, body text not null,
  source text not null check (source in ('seed','composer')), received_at timestamptz not null default now());

create table if not exists review_jobs (
  id text primary key, run_id text not null references runs on delete cascade, trigger text not null,
  status text not null check (status in ('queued','running','done','failed')), attempts int not null default 0,
  lease_until timestamptz, error text, created_at timestamptz not null default now());

create table if not exists decisions (
  id text primary key, run_id text not null, idx int not null,
  verdict text not null check (verdict in ('ALLOW','STOP','HOLD','FINANCE_ALLOW','FINANCE_STOP')),
  rev int not null, reason_code text, rules_fired jsonb not null default '[]', quotes jsonb not null default '[]',
  model text, evidence jsonb not null, evidence_hash text not null, idempotency_key text not null unique,
  tx text, chain_status text, created_at timestamptz not null default now());

create table if not exists tx_queue (
  id text primary key, sender text not null, run_id text, idx int, action text not null, idempotency_key text unique,
  evidence_rev int, nonce bigint, tx_hash text,
  status text not null check (status in ('queued','sent','mined','reverted','dropped','replaced')),
  attempts int not null default 0, error text, created_at timestamptz not null default now());

create table if not exists tickets (
  id text primary key, kind text not null check (kind in ('recovery','alarm','escalation','held','unexplained')),
  run_id text, idx int, body text not null, status text not null default 'open', created_at timestamptz not null default now());

create table if not exists cursors (name text primary key, last_block bigint not null);

create table if not exists chain_events (
  tx_hash text not null, log_index int not null, block_number bigint not null, address text not null, name text not null,
  run_id text, idx int, args jsonb not null, primary key (tx_hash, log_index));

-- Day 3: admission control, liquidity reservation, sweep-back
alter table runs add column if not exists reserved_units numeric not null default 0;
alter table runs add column if not exists settled_at timestamptz;
alter table runs add column if not exists sweep_tx text;
alter table runs add column if not exists creator_ip text;
alter table lines add column if not exists payee_idx int;
alter table lines add column if not exists proof_reason text;
create table if not exists rate_limits (key text primary key, window_start timestamptz not null, count int not null);
create index if not exists inbox_run on inbox (run_id, received_at);
create index if not exists decisions_line on decisions (run_id, idx, created_at);
create index if not exists jobs_queue on review_jobs (status, created_at);
alter table tx_queue add column if not exists settled_at timestamptz; -- wall-clock when the receipt came back (bench: email → cancel confirmed)
