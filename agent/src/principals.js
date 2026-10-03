/**
 * principals.js
 * ─────────────
 * Decides which principal (manufacturer) each stock item belongs to, and cuts
 * every voucher down to that principal's lines. This runs on the distributor's
 * PC so one principal's data never leaves the machine for another principal
 * (blueprint decision AD-2).
 *
 * Rules come from the middleware (or principals.json in development):
 * [
 *   { "code": "PATANJALI", "stockGroups": ["Patanjali"], "stockCategories": [], "items": [] },
 *   { "code": "COLGATE",   "stockGroups": ["Colgate Palmolive"] }
 * ]
 * An item belongs to a principal when its stock group (or any parent group) is
 * listed, or its stock category is listed, or its exact name is listed.
 */

import { ancestryIndex } from "./tally/masters.js";

/** Voucher base types that move stock and matter for visibility. */
export const MOVEMENT_BASE_TYPES = new Set([
  "Sales", "Credit Note", "Purchase", "Debit Note",
  "Delivery Note", "Receipt Note", "Rejections In", "Rejections Out",
  "Stock Journal", "Physical Stock",
]);

/**
 * An item goes to one principal, except where the hub approved a pair to receive the
 * same items (rule.sharesWith): a dealer's CEAT lines for CEAT and for the distributor
 * supplying them. Any other overlap is a mistake in the rules; the first rule wins and
 * the clash is reported, so a competitor never receives another manufacturer's items.
 *
 * @returns {{ principalOf: (itemName: string) => string|null,
 *             principalsOf: (itemName: string) => string[], conflicts: Array }}
 */
export function buildItemClassifier(rules, stockItems, stockGroups) {
  const groups = ancestryIndex(stockGroups);
  const codesOf = new Map();
  const conflicts = [];
  const shares = (a, b) => (a.sharesWith || []).includes(b.code) && (b.sharesWith || []).includes(a.code);

  for (const item of stockItems) {
    const chain = groups.chain(item.group);
    const matches = rules.filter((r) =>
      (r.items || []).includes(item.name) ||
      (r.stockGroups || []).some((g) => chain.includes(g)) ||
      (item.category && (r.stockCategories || []).includes(item.category)));

    if (matches.length === 0) continue;
    // Explicit item rules beat group rules; otherwise first rule wins.
    const explicit = matches.find((r) => (r.items || []).includes(item.name));
    const chosen = [explicit || matches[0]];
    for (const m of matches) {
      if (!chosen.includes(m) && chosen.every((c) => shares(c, m))) chosen.push(m);
    }
    const left = matches.filter((m) => !chosen.includes(m));
    if (!explicit && left.length) {
      conflicts.push({ item: item.name, principals: matches.map((m) => m.code), chosen: chosen.map((c) => c.code).join(", ") });
    }
    codesOf.set(item.name, chosen.map((c) => c.code));
  }

  return {
    principalOf: (name) => codesOf.get(name)?.[0] || null,
    principalsOf: (name) => codesOf.get(name) || [],
    conflicts,
  };
}

/**
 * Split parsed vouchers per principal.
 *
 * @param vouchers         parsed vouchers (see tally/vouchers.js)
 * @param principalOf      item → principal code
 * @param baseTypeOf       voucher type name → predefined base type
 * @param previouslySentTo guid → principal codes that got this voucher last time
 * @returns Map<code, { vouchers: [], tombstones: [] }>, plus sentTo: guid → codes now
 */
export function splitByPrincipal(vouchers, { principalOf, principalsOf, baseTypeOf, previouslySentTo = () => [] }) {
  const codesOf = principalsOf || ((item) => [principalOf(item)].filter(Boolean));
  const out = new Map();
  const sentTo = new Map();
  const bucket = (code) => {
    if (!out.has(code)) out.set(code, { vouchers: [], tombstones: [] });
    return out.get(code);
  };

  for (const v of vouchers) {
    const baseType = baseTypeOf(v.voucherType) || v.voucherType;
    const relevant = MOVEMENT_BASE_TYPES.has(baseType) && !v.isOptional;

    const linesByPrincipal = new Map();
    if (relevant) {
      for (const line of v.lines) {
        for (const code of codesOf(line.item)) {
          if (!linesByPrincipal.has(code)) linesByPrincipal.set(code, []);
          linesByPrincipal.get(code).push(line);
        }
      }
    }

    for (const [code, lines] of linesByPrincipal) {
      bucket(code).vouchers.push({
        guid: v.guid,
        masterId: v.masterId,
        alterId: v.alterId,
        date: v.date,
        voucherType: v.voucherType,
        baseType,
        voucherNumber: v.voucherNumber,
        reference: v.reference,
        partyLedger: v.partyLedger,
        isCancelled: v.isCancelled,
        // partyAmount is deliberately not sent: it is the whole bill, including
        // other principals' items. Each principal sees only its own line values.
        lines,
      });
    }

    // A voucher edited so it no longer holds a principal's items (or turned
    // optional) must be withdrawn from that principal's copy.
    for (const code of previouslySentTo(v.guid)) {
      if (!linesByPrincipal.has(code)) {
        bucket(code).tombstones.push({ guid: v.guid, alterId: v.alterId, reason: "no-longer-relevant" });
      }
    }
    sentTo.set(v.guid, [...linesByPrincipal.keys()]);
  }

  return { perPrincipal: out, sentTo };
}
