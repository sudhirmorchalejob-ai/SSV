/**
 * store.js
 * ────────
 * Writes what was read from Tally into the local SQLite store, like Biz's
 * updateDiff: new or changed rows are saved with up_to_date = 0 so the
 * uploader picks them up; unchanged rows are left alone.
 */

import { openDb, tx, PENDING } from "../db.js";
import { MOVEMENT_BASE_TYPES } from "../principals.js";
import { logger } from "../logger.js";

/** A voucher we keep: moves stock, is a real (not optional) entry, and still exists. */
export function isRelevant(v, baseTypeOf) {
  return MOVEMENT_BASE_TYPES.has(baseTypeOf(v.voucherType) || v.voucherType) && !v.isOptional && !v.isDeleted;
}

function itemsOf(lines) {
  return (lines || []).map((l) => l.item);
}

/**
 * Save vouchers read from Tally.
 *
 * @param {string} companyGuid
 * @param {object[]} vouchers   parsed vouchers
 * @param {object} o
 * @param {(t: string) => string} o.baseTypeOf
 * @param {string} [o.replaceDay] ISO date: the read covered this whole day, so
 *        local vouchers of that day that Tally no longer returned are deleted.
 * @returns {{ touchedItems: Set<string>, saved: number, deleted: number }}
 */
export function applyVouchers(companyGuid, vouchers, { baseTypeOf, replaceDay = null }) {
  const touchedItems = new Set();
  let saved = 0;
  let deleted = 0;

  tx((d) => {
    const get = d.prepare("SELECT guid, alter_id, is_deleted, data FROM voucher WHERE company_guid = ? AND master_id = ?");
    const spareKey = d.prepare("SELECT MIN(master_id) AS m FROM voucher WHERE company_guid = ?");
    const rekey = d.prepare(`UPDATE voucher SET master_id = ?, is_deleted = 1, up_to_date = ${PENDING} WHERE company_guid = ? AND master_id = ?`);
    const rekeyPrincipals = d.prepare("UPDATE voucher_principal SET master_id = ? WHERE company_guid = ? AND master_id = ?");
    const upsert = d.prepare(`
      INSERT INTO voucher (company_guid, master_id, guid, alter_id, date, voucher_type, is_cancelled, is_optional, is_deleted, data, up_to_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ${PENDING})
      ON CONFLICT(company_guid, master_id) DO UPDATE SET
        guid = excluded.guid, alter_id = excluded.alter_id, date = excluded.date, voucher_type = excluded.voucher_type,
        is_cancelled = excluded.is_cancelled, is_optional = excluded.is_optional, is_deleted = 0,
        data = excluded.data, up_to_date = ${PENDING}`);
    const markDeleted = d.prepare(
      `UPDATE voucher SET is_deleted = 1, up_to_date = ${PENDING} WHERE company_guid = ? AND master_id = ?`);

    const seen = new Set();
    for (const v of vouchers) {
      if (v.masterId === null || v.masterId === undefined) {
        logger.warn(`Voucher ${v.voucherNumber || v.guid} has no MASTERID; skipped`);
        continue;
      }
      seen.add(v.masterId);
      let existing = get.get(companyGuid, v.masterId);

      // MasterID now belongs to a different voucher: after a backup restore Tally
      // hands out MasterIDs again from the backup's counter. Park the old voucher
      // under a spare negative key, marked deleted, so it is withdrawn by GUID.
      if (existing && existing.guid && v.guid && existing.guid !== v.guid) {
        const key = Math.min(0, spareKey.get(companyGuid).m ?? 0) - 1;
        if (!existing.is_deleted) itemsOf(JSON.parse(existing.data).lines).forEach((i) => touchedItems.add(i));
        rekey.run(key, companyGuid, v.masterId);
        rekeyPrincipals.run(key, companyGuid, v.masterId);
        if (!existing.is_deleted) deleted++;
        existing = null;
      }

      if (!isRelevant(v, baseTypeOf)) {
        // Became optional, changed to a non-stock type, or flagged deleted:
        // withdraw it if we held it.
        if (existing && !existing.is_deleted) {
          markDeleted.run(companyGuid, v.masterId);
          itemsOf(JSON.parse(existing.data).lines).forEach((i) => touchedItems.add(i));
          deleted++;
        }
        continue;
      }
      // An equal AlterID alone does not mean unchanged: after a backup restore Tally
      // gives a new voucher the lost one's MasterID, GUID and AlterID all at once
      // (field test 29-Sep). Skip only when the content is identical too.
      const json = JSON.stringify(v);
      if (existing && !existing.is_deleted && existing.alter_id === v.alterId && existing.data === json) continue;

      upsert.run(
        companyGuid, v.masterId, v.guid, v.alterId, v.date, v.voucherType,
        v.isCancelled ? 1 : 0, v.isOptional ? 1 : 0, json,
      );
      itemsOf(v.lines).forEach((i) => touchedItems.add(i));
      if (existing) itemsOf(JSON.parse(existing.data).lines).forEach((i) => touchedItems.add(i));
      saved++;
    }

    if (replaceDay) {
      const local = d.prepare("SELECT master_id, data FROM voucher WHERE company_guid = ? AND date = ? AND is_deleted = 0")
        .all(companyGuid, replaceDay);
      for (const row of local) {
        if (!seen.has(row.master_id)) {
          markDeleted.run(companyGuid, row.master_id);
          itemsOf(JSON.parse(row.data).lines).forEach((i) => touchedItems.add(i));
          deleted++;
        }
      }
    }
  });

  return { touchedItems, saved, deleted };
}

/** Mark vouchers deleted by MASTERID (fallback deleted-voucher check). */
export function markVouchersDeleted(companyGuid, masterIds) {
  const touchedItems = new Set();
  if (!masterIds.length) return touchedItems;
  tx((d) => {
    const get = d.prepare("SELECT data FROM voucher WHERE company_guid = ? AND master_id = ? AND is_deleted = 0");
    const mark = d.prepare(`UPDATE voucher SET is_deleted = 1, up_to_date = ${PENDING} WHERE company_guid = ? AND master_id = ?`);
    for (const id of masterIds) {
      const row = get.get(companyGuid, id);
      if (!row) continue;
      mark.run(companyGuid, id);
      itemsOf(JSON.parse(row.data).lines).forEach((i) => touchedItems.add(i));
    }
  });
  return touchedItems;
}

/**
 * Local voucher counts per voucher type for each period, counted the way
 * Tally's Statistics report counts: not deleted, not cancelled, not optional.
 * @param {{from: string, to: string}[]} periods
 * @returns {Array<Record<string, number>>}
 */
export function localCounts(companyGuid, periods) {
  const q = openDb().prepare(`
    SELECT voucher_type, COUNT(*) AS n FROM voucher
    WHERE company_guid = ? AND date BETWEEN ? AND ? AND is_deleted = 0 AND is_cancelled = 0 AND is_optional = 0
    GROUP BY voucher_type`);
  return periods.map((p) => {
    const out = {};
    for (const r of q.all(companyGuid, p.from, p.to)) out[r.voucher_type] = r.n;
    return out;
  });
}

export function localVoucherCount(companyGuid) {
  return openDb().prepare("SELECT COUNT(*) AS n FROM voucher WHERE company_guid = ? AND is_deleted = 0").get(companyGuid).n;
}

export function maxLocalDate(companyGuid) {
  return openDb().prepare("SELECT MAX(date) AS d FROM voucher WHERE company_guid = ? AND is_deleted = 0").get(companyGuid).d;
}

// ── stock items and parties ─────────────────────────────────────────────────

/**
 * Save stock items. A row goes back to pending when its master data or closing
 * figures changed, or when forcePending is set (daily full snapshot).
 */
export function applyStockItems(companyGuid, items, { forcePending = false } = {}) {
  let changed = 0;
  tx((d) => {
    const get = d.prepare("SELECT data FROM stock_item WHERE company_guid = ? AND master_id = ?");
    const upsert = d.prepare(`
      INSERT INTO stock_item (company_guid, master_id, name, data, closing_qty, closing_value, up_to_date)
      VALUES (?, ?, ?, ?, ?, ?, ${PENDING})
      ON CONFLICT(company_guid, master_id) DO UPDATE SET
        name = excluded.name, data = excluded.data, closing_qty = excluded.closing_qty,
        closing_value = excluded.closing_value, up_to_date = ${PENDING}`);
    for (const it of items) {
      if (it.masterId === null || it.masterId === undefined) continue;
      const json = JSON.stringify(it);
      const existing = get.get(companyGuid, it.masterId);
      if (existing && existing.data === json && !forcePending) continue;
      upsert.run(companyGuid, it.masterId, it.name, json, it.closingQty, it.closingValue);
      changed++;
    }
  });
  return changed;
}

/** name → masterId for the given item names; names not found are returned separately. */
export function stockItemIdsByName(companyGuid, names) {
  const q = openDb().prepare("SELECT master_id FROM stock_item WHERE company_guid = ? AND name = ?");
  const ids = [];
  const missing = [];
  for (const n of names) {
    const r = q.get(companyGuid, n);
    if (r) ids.push(r.master_id); else missing.push(n);
  }
  return { ids, missing };
}

export function allStockItems(companyGuid) {
  return openDb().prepare("SELECT data FROM stock_item WHERE company_guid = ?").all(companyGuid).map((r) => JSON.parse(r.data));
}

/** Store the party ledgers; returns the names of those that are new or changed. */
export function applyParties(companyGuid, parties) {
  const changed = [];
  tx((d) => {
    const get = d.prepare("SELECT data FROM party WHERE company_guid = ? AND name = ?");
    const upsert = d.prepare(`INSERT INTO party (company_guid, name, data) VALUES (?, ?, ?)
      ON CONFLICT(company_guid, name) DO UPDATE SET data = excluded.data`);
    for (const p of parties) {
      const data = JSON.stringify(p);
      if (get.get(companyGuid, p.name)?.data !== data) changed.push(p.name);
      upsert.run(companyGuid, p.name, data);
    }
  });
  return changed;
}

/** {principal: party names} for the live vouchers each principal holds. */
export function partiesHeldByPrincipal(companyGuid) {
  const rows = openDb().prepare(`SELECT DISTINCT vp.principal AS principal, json_extract(v.data, '$.partyLedger') AS party
    FROM voucher v JOIN voucher_principal vp ON vp.company_guid = v.company_guid AND vp.master_id = v.master_id
    WHERE v.company_guid = ? AND v.is_deleted = 0`).all(companyGuid);
  const out = new Map();
  for (const r of rows) {
    if (!r.party) continue;
    if (!out.has(r.principal)) out.set(r.principal, new Set());
    out.get(r.principal).add(r.party);
  }
  return out;
}

export function partiesByName(companyGuid, names) {
  const q = openDb().prepare("SELECT data FROM party WHERE company_guid = ? AND name = ?");
  return names.map((n) => q.get(companyGuid, n)).filter(Boolean).map((r) => JSON.parse(r.data));
}
