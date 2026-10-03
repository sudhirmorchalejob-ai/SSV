/**
 * xml.js
 * ──────
 * Value helpers for TallyPrime XML, forked from the Tally-ERPNext Middleware
 * tallyClient.js. Two behaviours differ on purpose from the original:
 *
 *   • parseQty keeps zero as zero. The original returned 1 for a zero or
 *     missing quantity, which inflated sales for free-goods and service lines.
 *   • parseSigned keeps the sign. The original ran every amount through
 *     Math.abs, so credit notes and returns looked like sales.
 */

import { parseStringPromise } from "xml2js";

export function escapeXml(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Strip Tally control characters (EOT etc.) that survive xml2js and break
// string comparisons, e.g. parent = "\u0004 Primary".
export function cleanVal(s) {
  if (!s) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127 || c === 8203 || c === 8204 || c === 8205 || c === 65279) continue;
    out += s[i];
  }
  return out.trim();
}

/** Scalar value of an xml2js node (explicitArray:false), or null. */
export function val(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return val(v[0]);
  if (typeof v === "object") return v._ !== undefined ? cleanVal(String(v._)) : null;
  return cleanVal(String(v));
}

/** Always an array, for list nodes that xml2js collapses when there is one child. */
export function list(v) {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

export function yes(v) {
  return val(v) === "Yes";
}

/**
 * Leading signed number of a Tally numeric string, or null.
 *   "1,250.50"      →  1250.5
 *   "-72 Nos"       → -72
 *   "79.00/Nos"     →  79
 *   "(-)12.00"      → -12      (Tally's negative display form)
 *   "2 Box 5 Nos"   →  2       (compound unit: primary unit only)
 */
export function parseNumber(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith("(-)")) { negative = true; s = s.slice(3).trim(); }
  const m = s.replace(/,/g, "").match(/^[-+]?\d*\.?\d+/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  if (isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** Signed amount/quantity; missing or unparseable → 0. Never coerces 0 to 1. */
export function parseSigned(raw) {
  return parseNumber(raw) ?? 0;
}

/** Quantity magnitude; missing or unparseable → 0. */
export function parseQty(raw) {
  return Math.abs(parseSigned(raw));
}

/** Unit of a Tally quantity string: "10 Nos" → "Nos", "79.00/Nos" → "Nos". */
export function parseUnit(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^[-+(),.\d\s]*\/?\s*([^\d\s][^\s]*)/);
  return m ? m[1] : null;
}

/** "20260923" or "2026-09-23" → "2026-09-23". */
export function tallyDateToISO(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/-/g, "").trim();
  if (s.length < 8 || !/^\d{8}/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-04-01" → "01-Apr-2026", the form Tally parses reliably in <SVFROMDATE TYPE="Date">. */
export function formatTallyDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}-${MONTHS[parseInt(m, 10) - 1]}-${y}`;
}

/**
 * Decode a Tally HTTP response body. Tally answers in UTF-16LE when asked in
 * UTF-16 (which keeps Hindi and other non-Latin names intact), otherwise UTF-8.
 */
export function decodeTallyBody(buf) {
  if (!buf || buf.length === 0) return "";
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  // "<" as UTF-16LE is 3C 00.
  if (buf.length > 1 && buf[1] === 0x00) return buf.toString("utf16le");
  return buf.toString("utf8");
}

const VALID_ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;

function isXmlChar(n) {
  return n === 0x9 || n === 0xa || n === 0xd || (n >= 0x20 && n <= 0xd7ff) ||
    (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
}

/**
 * Make Tally's XML parseable by a strict parser. Tally master exports contain
 *   • bare "&" in names ("Fixed Asset 3rt & 4rt", "F&B"),
 *   • character references to control characters, e.g. "&#4;" (the marker
 *     Tally puts before reserved names like "Primary"),
 *   • raw control characters.
 * Each one makes the whole response unparseable. Bare "&" becomes "&amp;";
 * invalid references and raw control characters are dropped, as cleanVal()
 * would drop them from the value anyway.
 */
export function sanitizeTallyXml(raw) {
  if (!raw) return raw;
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&#(x[0-9a-fA-F]+|\d+);/g, (m, code) =>
      (isXmlChar(code[0] === "x" || code[0] === "X" ? parseInt(code.slice(1), 16) : parseInt(code, 10)) ? m : ""))
    .replace(/&/g, (m, offset, s) => (VALID_ENTITY.test(s.slice(offset, offset + 12)) ? m : "&amp;"));
}

export async function parseXml(raw) {
  return parseStringPromise(sanitizeTallyXml(raw), { explicitArray: false });
}

/** Items of an inline-TDL Collection export: ENVELOPE > BODY > DATA > COLLECTION > <tag>. */
export function collectionItems(parsed, ...tags) {
  const body = parsed?.ENVELOPE?.BODY;
  const coll = body?.DATA?.COLLECTION ?? body?.DATA ?? body?.TALLYMESSAGE;
  if (!coll) return [];
  for (const t of tags) {
    if (coll[t] !== undefined) return list(coll[t]);
  }
  return [];
}

/** Name of a master: Tally puts it in the NAME attribute, older builds in a NAME child. */
export function masterName(node) {
  return cleanVal(node?.$?.NAME) || val(node?.NAME) || null;
}
