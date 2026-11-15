import type { Db } from "./db.js";
import { migrate } from "./db.js";
import { invoiceFixtures, mailTemplates, payeeAddress, toUnits, vendorFixtures } from "./fixtures.js";

/** Load the seed TEMPLATES (vendors, invoices, inbox with run_id = null). Runs snapshot them at creation. Idempotent. */
export async function seed(db: Db, opts: { mnemonic: string; scale: number; now?: Date }) {
  await migrate(db);
  const now = opts.now ?? new Date();
  let vendors = 0;
  for (const v of vendorFixtures()) {
    await db.query(
      `insert into vendors (id, name, domain, payee, genuine_payee, payee_changed_at, payee_change_source,
         payee_change_verified, payee_change_verified_by, contract_contact)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do update set name=excluded.name, domain=excluded.domain, payee=excluded.payee,
         genuine_payee=excluded.genuine_payee, payee_changed_at=excluded.payee_changed_at,
         payee_change_source=excluded.payee_change_source, payee_change_verified=excluded.payee_change_verified,
         payee_change_verified_by=excluded.payee_change_verified_by, contract_contact=excluded.contract_contact`,
      [
        v.id,
        v.name,
        v.domain,
        payeeAddress(opts.mnemonic, v.payeeIdx),
        payeeAddress(opts.mnemonic, v.genuineIdx),
        v.payeeChangedDaysAgo ? new Date(now.getTime() - v.payeeChangedDaysAgo * 864e5) : null,
        v.changeSource,
        v.verified,
        v.verifiedBy ?? null,
        v.contractContact,
      ],
    );
    vendors++;
  }
  let invoices = 0;
  for (const i of invoiceFixtures()) {
    await db.query(
      `insert into invoices (id, vendor_id, amount_units, status) values ($1,$2,$3,$4)
       on conflict (id) do update set vendor_id=excluded.vendor_id, amount_units=excluded.amount_units, status=excluded.status`,
      [i.id, i.vendorId, toUnits(i.amount, opts.scale).toString(), i.status],
    );
    invoices++;
  }
  let mails = 0;
  for (const t of mailTemplates()) {
    await db.query(
      `insert into inbox (id, run_id, seed_id, from_addr, from_domain, subject, body, source)
       values ($1, null, $2, $3, $4, $5, $6, 'seed')
       on conflict (id) do update set from_addr=excluded.from_addr, from_domain=excluded.from_domain,
         subject=excluded.subject, body=excluded.body`,
      [`tpl_${t.id}`, t.id, t.from, t.from.split("@")[1] ?? "", t.subject, t.body],
    );
    mails++;
  }
  return { vendors, invoices, mails };
}
