# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Applies batches from the SSV connector agent.

Contract (see ssv-platform/README.md):
  * Request is signed: X-SSV-Signature = HMAC-SHA256(agent_secret, "<X-SSV-Timestamp>.<raw body>")
  * batch_id is unique: a repeat gets 409, which the agent treats as delivered
  * Within a Tally company, newer = higher (sync_epoch, alterId). sync_epoch rises
    when the agent detects a restored Tally backup, after which AlterIDs repeat.
  * kind "items":    item masters + closing stock as of as_of_date, optionally
                     per godown (items[].godowns, agent 0.3.0+)
    kind "vouchers": vouchers (principal's lines only), tombstones, referenced parties
    kind "control":  per month, the bills, quantity and value the agent has delivered
                     here (agent 0.5.3+), compared with what this site holds
"""

import hashlib
import hmac
import json
import time

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, now_datetime
from frappe.utils.password import get_decrypted_password

from ssv_channel import mapping, summary

DT_VOUCHER = "SSV Secondary Voucher"


class Refused(Exception):
	"""Batch can never be applied as sent (wrong principal, unknown kind). Answered with 422."""


class Deferred(Exception):
	"""Batch cannot be applied yet, e.g. consent not recorded. Answered with 503: the agent keeps it and retries."""


def neutralize(obj):
	"""Text from a distributor's Tally and agent ends up in reports and lists, where Frappe
	renders Data values as HTML, and updates here use db.set_value, which skips Frappe's
	save-time sanitising. Angle brackets are escaped on the way in, so nothing a distributor
	sends can become markup or script in a manager's browser."""
	if isinstance(obj, str):
		return obj.replace("<", "&lt;").replace(">", "&gt;") if ("<" in obj or ">" in obj) else obj
	if isinstance(obj, list):
		return [neutralize(x) for x in obj]
	if isinstance(obj, dict):
		return {k: neutralize(v) for k, v in obj.items()}
	return obj


# ── authentication ──────────────────────────────────────────────────────────


def verify_request(distributor_id, timestamp, signature, body: bytes) -> str:
	"""Check the agent's signature and return the SSV Distributor name."""
	if not (distributor_id and timestamp and signature):
		raise frappe.AuthenticationError(_("Missing SSV signature headers"))

	row = frappe.db.get_value("SSV Distributor", distributor_id, ["name", "enabled"], as_dict=True)
	if not row or not row.enabled:
		raise frappe.AuthenticationError(_("Unknown or disabled distributor"))

	skew = cint(frappe.db.get_single_value("SSV Settings", "clock_skew_seconds")) or 300
	if abs(time.time() - cint(timestamp)) > skew:
		raise frappe.AuthenticationError(_("Request time is outside the allowed clock skew; check the PC clock"))

	secret = get_decrypted_password("SSV Distributor", row.name, "agent_secret", raise_exception=False)
	if not secret:
		raise frappe.AuthenticationError(_("Distributor has no agent secret"))
	expected = hmac.new(secret.encode(), str(timestamp).encode() + b"." + body, hashlib.sha256).hexdigest()
	if not hmac.compare_digest(expected, str(signature)):
		raise frappe.AuthenticationError(_("Bad signature"))
	return row.name


def principal_code() -> str:
	code = frappe.db.get_single_value("SSV Settings", "principal_code")
	if not code:
		frappe.throw(_("Set the principal code in SSV Settings first"))
	return code


def distributor_rules(distributor: str) -> dict:
	"""Rules in the shape the agent expects from GET config."""
	rules = frappe.get_all(
		"SSV Distributor Rule",
		filters={"parent": distributor, "parenttype": "SSV Distributor"},
		fields=["rule_type", "tally_value"],
		order_by="idx asc",
	)
	pick = lambda t: [r.tally_value for r in rules if r.rule_type == t]
	return {
		"principals": [
			{
				"code": principal_code(),
				"stockGroups": pick("Stock Group"),
				"stockCategories": pick("Stock Category"),
				"items": pick("Item"),
			}
		]
	}


# ── agent control and run reports ──────────────────────────────────────────


def agent_settings(distributor: str) -> dict:
	"""What the principal controls from the SSV Distributor form. syncRequestedAt is
	an opaque token to the agent: a value it has not handled yet means "Sync now"."""
	interval, requested, auto_update = frappe.db.get_value(
		"SSV Distributor", distributor, ["sync_interval_minutes", "sync_requested_at", "auto_update"]
	)
	out = {
		"syncIntervalMinutes": cint(interval) or None,
		"syncRequestedAt": str(requested) if requested else None,
	}
	s = frappe.get_cached_doc("SSV Settings")
	if auto_update and s.get("agent_version") and s.get("agent_download_url") and s.get("agent_sha256"):
		url = s.agent_download_url
		if url.startswith("/"):
			url = frappe.utils.get_url(url)
		out["update"] = {"version": s.agent_version.strip(), "url": url, "sha256": s.agent_sha256.strip().lower()}
	return out


def record_contact(distributor: str):
	frappe.db.set_value("SSV Distributor", distributor, "last_contact_at", now_datetime(), update_modified=False)


def apply_heartbeat(distributor: str, hb: dict):
	"""A run report, sent by the agent after every sync."""
	hb = neutralize(hb)
	if hb.get("distributor_id") != distributor:
		raise Refused(f"heartbeat is for distributor {hb.get('distributor_id')}, signed by {distributor}")
	run = hb.get("run") or {}
	now = now_datetime()
	ok = bool(run.get("ok"))
	updates = {
		"last_contact_at": now,
		"last_run_at": now,
		"last_run_status": "OK" if ok else "Failed",
		"last_run_problem": None if ok else (run.get("problem") or "")[:1000],
		"agent_version": hb.get("agent_version"),
	}
	if ok:
		updates["last_ok_run_at"] = now
	frappe.db.set_value("SSV Distributor", distributor, updates, update_modified=False)


# ── batches ─────────────────────────────────────────────────────────────────


def apply_batch(distributor: str, batch: dict) -> tuple[int, dict]:
	"""Apply one batch. Returns (HTTP status, response body)."""
	batch = neutralize(batch)
	batch_id = batch.get("batch_id")
	if not batch_id:
		raise Refused("batch_id missing")
	if frappe.db.exists("SSV Ingest Log", batch_id):
		return 409, {"ok": True, "duplicate": True}

	if batch.get("distributor_id") != distributor:
		raise Refused(f"batch is for distributor {batch.get('distributor_id')}, signed by {distributor}")
	if batch.get("principal") != principal_code():
		raise Refused(f"batch is for principal {batch.get('principal')}; this site is {principal_code()}")
	if cint(frappe.db.get_single_value("SSV Settings", "hold_until_consent")) and not frappe.db.get_value(
		"SSV Distributor", distributor, "data_sharing_consent_date"
	):
		raise Deferred("data is held until the Data Sharing Consent Date is recorded on the SSV Distributor")

	epoch = cint(batch.get("sync_epoch"))
	company = get_tally_company(distributor, batch.get("tally_company") or {}, epoch)

	kind = batch.get("kind")
	if kind == "items":
		count = apply_items(distributor, company, batch)
	elif kind == "vouchers":
		count = apply_vouchers(distributor, company, batch, epoch)
	elif kind == "control":
		count = apply_control(distributor, company, batch)
	else:
		raise Refused(f"unknown batch kind {kind!r}")

	frappe.get_doc(
		{
			"doctype": "SSV Ingest Log",
			"batch_id": batch_id,
			"received_at": now_datetime(),
			"distributor": distributor,
			"tally_company": company,
			"kind": kind,
			"records": count,
			"status": "Applied",
			"agent_version": batch.get("agent_version"),
			"sync_epoch": epoch,
		}
	).insert(ignore_permissions=True)
	frappe.db.set_value(
		"SSV Distributor",
		distributor,
		{"last_seen_at": now_datetime(), "last_contact_at": now_datetime(), "agent_version": batch.get("agent_version")},
		update_modified=False,
	)
	return 202, {"ok": True, "applied": count}


def log_refused(distributor: str, batch: dict, reason: str):
	if not batch.get("batch_id") or frappe.db.exists("SSV Ingest Log", batch["batch_id"]):
		return
	frappe.get_doc(
		{
			"doctype": "SSV Ingest Log",
			"batch_id": batch["batch_id"],
			"received_at": now_datetime(),
			"distributor": distributor,
			"kind": batch.get("kind"),
			"status": "Rejected",
			"error": reason[:1000],
			"agent_version": batch.get("agent_version"),
		}
	).insert(ignore_permissions=True)


def get_tally_company(distributor: str, tc: dict, epoch: int) -> str:
	guid = tc.get("guid")
	if not guid:
		raise Refused("tally_company.guid missing")
	name = frappe.db.get_value("SSV Tally Company", {"tally_company_guid": guid}, "name")
	if name:
		owner = frappe.db.get_value("SSV Tally Company", name, "distributor")
		if owner != distributor:
			raise Refused("this Tally company is registered to another distributor")
		updates = {"last_batch_at": now_datetime(), "tally_company_name": tc.get("name")}
		if epoch > cint(frappe.db.get_value("SSV Tally Company", name, "sync_epoch")):
			updates["sync_epoch"] = epoch
		frappe.db.set_value("SSV Tally Company", name, updates, update_modified=False)
		return name
	doc = frappe.get_doc(
		{
			"doctype": "SSV Tally Company",
			"distributor": distributor,
			"tally_company_guid": guid,
			"tally_company_name": tc.get("name"),
			"sync_epoch": epoch,
			"last_batch_at": now_datetime(),
		}
	).insert(ignore_permissions=True)
	return doc.name


# ── reconciliation ──────────────────────────────────────────────────────────


def site_totals(distributor: str, company: str) -> dict:
	"""Per month: live bills, and the sum of qty and amount over their stored rows."""
	rows = frappe.db.sql(
		"""SELECT DATE_FORMAT(v.voucher_date, %(fmt)s) AS month, COUNT(DISTINCT v.name) AS vouchers,
			COALESCE(SUM(i.qty), 0) AS qty, COALESCE(SUM(i.amount), 0) AS amount
		FROM `tabSSV Secondary Voucher` v
		LEFT JOIN `tabSSV Secondary Voucher Item` i ON i.parent = v.name AND i.parenttype = %(dt)s
		WHERE v.distributor = %(d)s AND v.tally_company = %(c)s AND v.is_deleted = 0
		GROUP BY month""",
		{"fmt": "%Y-%m", "dt": DT_VOUCHER, "d": distributor, "c": company},
		as_dict=True,
	)
	return {r.month: r for r in rows}


def apply_control(distributor: str, company: str, batch: dict) -> int:
	"""Compare the agent's per-month totals of what it delivered with what this site holds."""
	agent = {m["month"]: m for m in batch.get("months") or []}
	here = site_totals(distributor, company)
	zero = {"vouchers": 0, "qty": 0, "amount": 0}
	problems = []
	for month in sorted(set(agent) | set(here)):
		a, h = agent.get(month, zero), here.get(month, zero)
		# Bills must match exactly; qty and value allow for rounding on either side.
		if (cint(a["vouchers"]) != cint(h["vouchers"]) or abs(flt(a["qty"]) - flt(h["qty"])) > 0.01
				or abs(flt(a["amount"]) - flt(h["amount"])) > 1):
			problems.append(
				f"{month}: agent sent {cint(a['vouchers'])} bills, qty {flt(a['qty']):g}, value {flt(a['amount']):,.2f}; "
				f"this site has {cint(h['vouchers'])} bills, qty {flt(h['qty']):g}, value {flt(h['amount']):,.2f}"
			)
	refused = cint(batch.get("rejected"))
	if refused:
		problems.insert(0, f"{refused} bill(s) were refused by this site and are missing (SSV Ingest Log, status Rejected)")
	text = "\n".join(problems[:6] + ([f"… and {len(problems) - 6} more"] if len(problems) > 6 else []))
	frappe.db.set_value(
		"SSV Tally Company", company,
		{"reconcile_status": "Mismatch" if problems else "OK", "reconciled_at": now_datetime(), "reconcile_problem": text or None},
		update_modified=False,
	)
	return len(agent)


# ── items and closing stock ─────────────────────────────────────────────────


def find_channel_item(company: str, name: str, master_id=None):
	if master_id is not None:
		found = frappe.db.get_value("SSV Channel Item", {"tally_company": company, "tally_master_id": cint(master_id)}, "name")
		if found:
			return found
	return frappe.db.get_value("SSV Channel Item", {"tally_company": company, "tally_item_name": name}, "name")


def auto_map(tally_name: str):
	"""An ERPNext Item whose code or name equals the Tally item name, if exactly one."""
	code = frappe.db.get_value("Item", tally_name, "name") if frappe.db.exists("Item", tally_name) else None
	if code:
		return code
	matches = frappe.get_all("Item", filters={"item_name": tally_name, "disabled": 0}, pluck="name", limit=2)
	return matches[0] if len(matches) == 1 else None


def upsert_channel_item(distributor: str, company: str, it: dict) -> str:
	fields = {
		"tally_item_name": it.get("name"),
		"tally_item_guid": it.get("guid"),
		"tally_master_id": it.get("masterId"),
		"group_path": " > ".join(it.get("groupPath") or []) or it.get("group"),
		"stock_category": it.get("category"),
		"unit": it.get("baseUnit") or it.get("unit"),
		"part_no": it.get("partNo"),
		"hsn_code": it.get("hsnCode"),
		"gst_rate": flt(it.get("gstRate")),
	}
	name = find_channel_item(company, it.get("name"), it.get("masterId"))
	if name:
		frappe.db.set_value("SSV Channel Item", name, fields)
		return name
	item_code = auto_map(it.get("name"))
	doc = frappe.get_doc(
		{
			"doctype": "SSV Channel Item",
			"distributor": distributor,
			"tally_company": company,
			**fields,
			"item_code": item_code,
			"mapping_status": "Mapped" if item_code else "Unmapped",
		}
	).insert(ignore_permissions=True)
	if not item_code:
		mapping.suggest(doc.name)  # closest Item by name, sizes and part number, for a person to accept
	return doc.name


def apply_items(distributor: str, company: str, batch: dict) -> int:
	as_of = getdate(batch.get("as_of_date"))
	items = batch.get("items") or []
	for it in items:
		ci = upsert_channel_item(distributor, company, it)
		qty, value = flt(it.get("closingQty")), flt(it.get("closingValue"))

		snap = frappe.db.get_value("SSV Stock Snapshot", {"channel_item": ci, "as_of_date": as_of}, "name")
		doc = (
			frappe.get_doc("SSV Stock Snapshot", snap)
			if snap
			else frappe.get_doc(
				{
					"doctype": "SSV Stock Snapshot",
					"distributor": distributor,
					"tally_company": company,
					"channel_item": ci,
					"as_of_date": as_of,
				}
			)
		)
		doc.closing_qty, doc.closing_value = qty, value
		# "godowns" is optional: an agent before 0.3.0 does not send it, and then a
		# split already stored for the day is kept rather than wiped.
		if it.get("godowns") is not None:
			doc.godown_split = 1
			doc.set(
				"godowns",
				[
					{"godown": g.get("godown"), "closing_qty": flt(g.get("qty")), "closing_value": flt(g.get("value"))}
					for g in it["godowns"]
					if g.get("godown")
				],
			)
		if snap:
			doc.save(ignore_permissions=True)
		else:
			doc.insert(ignore_permissions=True)

		current = frappe.db.get_value("SSV Channel Item", ci, "stock_as_of")
		if not current or getdate(current) <= as_of:
			frappe.db.set_value(
				"SSV Channel Item", ci, {"closing_qty": qty, "closing_value": value, "stock_as_of": as_of}
			)
	return len(items)


# ── vouchers ────────────────────────────────────────────────────────────────


def upsert_retailer(distributor: str, company: str, p: dict) -> str:
	fields = {
		"tally_guid": p.get("guid"),
		"ledger_group": p.get("group"),
		"gstin": p.get("gstin"),
		"phone": p.get("phone"),
		"state": p.get("state"),
		"pincode": p.get("pincode"),
		"address": p.get("address"),
		"price_level": p.get("priceLevel"),
	}
	name = frappe.db.get_value("SSV Retailer", {"tally_company": company, "ledger_name": p.get("name")}, "name")
	if name:
		frappe.db.set_value("SSV Retailer", name, fields)
		return name
	return (
		frappe.get_doc(
			{"doctype": "SSV Retailer", "distributor": distributor, "tally_company": company, "ledger_name": p.get("name"), **fields}
		)
		.insert(ignore_permissions=True)
		.name
	)


def retailer_for(distributor: str, company: str, ledger: str | None):
	if not ledger:
		return None
	name = frappe.db.get_value("SSV Retailer", {"tally_company": company, "ledger_name": ledger}, "name")
	return name or upsert_retailer(distributor, company, {"name": ledger})


def is_newer(existing, epoch: int, alter_id) -> bool:
	"""True if (epoch, alter_id) is not older than what is stored."""
	return (epoch, cint(alter_id)) >= (cint(existing.sync_epoch), cint(existing.alter_id))


def voucher_rows(distributor: str, company: str, v: dict) -> list[dict]:
	"""One child row per godown/batch allocation, so godown-wise analysis works."""
	rows = []
	for line in v.get("lines") or []:
		ci = find_channel_item(company, line.get("item")) or upsert_channel_item(
			distributor, company, {"name": line.get("item"), "unit": line.get("unit")}
		)
		allocations = line.get("allocations") or [{}]
		for a in allocations:
			rows.append(
				{
					"channel_item": ci,
					"tally_item_name": line.get("item"),
					"direction": line.get("direction") or "out",
					"qty": flt(a.get("qty", line.get("qty"))),
					"billed_qty": flt(a.get("billedQty", line.get("billedQty"))),
					"unit": line.get("unit"),
					"rate": flt(line.get("rate")),
					"amount": flt(a.get("amount", line.get("amount"))),
					"discount_pct": flt(line.get("discountPct")),
					"godown": a.get("godown"),
					"batch": a.get("batch"),
					"is_tracked": 1 if (a.get("trackingNumber") or (line.get("tracked") and "trackingNumber" not in a)) else 0,
				}
			)
	return rows


def apply_contact_choice(distributor: str, share) -> None:
	"""Agents from 0.5.1 say whether the distributor shares retailer contacts.
	When it does not, delete every contact already held for that distributor."""
	if share is None:
		return  # older agent: nothing said
	withheld = 0 if share else 1
	if withheld:
		frappe.db.sql(
			"""update `tabSSV Retailer` set phone = null, address = null, pincode = null
			where distributor = %s and (phone is not null or address is not null or pincode is not null)""",
			distributor,
		)
	if cint(frappe.db.get_value("SSV Distributor", distributor, "retailer_contacts_withheld")) != withheld:
		frappe.db.set_value("SSV Distributor", distributor, "retailer_contacts_withheld", withheld, update_modified=False)


def apply_vouchers(distributor: str, company: str, batch: dict, epoch: int) -> int:
	apply_contact_choice(distributor, batch.get("party_contacts"))
	for p in batch.get("parties") or []:
		upsert_retailer(distributor, company, p)

	count = 0
	touched = set()  # (distributor, month) whose monthly summary must be rebuilt
	for v in batch.get("vouchers") or []:
		existing = frappe.db.get_value(
			DT_VOUCHER, {"tally_company": company, "tally_guid": v["guid"]},
			["name", "alter_id", "sync_epoch", "voucher_date"], as_dict=True
		)
		if existing and not is_newer(existing, epoch, v.get("alterId")):
			continue  # an older copy arriving late
		if existing and existing.voucher_date:
			touched.add((distributor, existing.voucher_date))  # an edit may move the voucher to another month
		if v.get("date"):
			touched.add((distributor, v["date"]))

		doc = frappe.get_doc(DT_VOUCHER, existing.name) if existing else frappe.new_doc(DT_VOUCHER)
		doc.update(
			{
				"distributor": distributor,
				"tally_company": company,
				"tally_guid": v["guid"],
				"tally_master_id": v.get("masterId"),
				"alter_id": v.get("alterId"),
				"sync_epoch": epoch,
				"voucher_date": v.get("date"),
				"voucher_type": v.get("voucherType"),
				"base_type": v.get("baseType") or v.get("voucherType"),
				"voucher_number": v.get("voucherNumber"),
				"reference": v.get("reference"),
				"party_ledger": v.get("partyLedger"),
				"retailer": retailer_for(distributor, company, v.get("partyLedger")),
				"is_cancelled": 1 if v.get("isCancelled") else 0,
				"is_deleted": 0,
			}
		)
		doc.set("items", voucher_rows(distributor, company, v))
		doc.total_qty = sum(flt(r.qty) for r in doc.get("items"))
		doc.total_amount = sum(flt(r.amount) for r in doc.get("items"))
		doc.flags.ignore_permissions = True
		doc.save() if existing else doc.insert()
		count += 1

	for t in batch.get("tombstones") or []:
		existing = frappe.db.get_value(
			DT_VOUCHER, {"tally_company": company, "tally_guid": t["guid"]},
			["name", "alter_id", "sync_epoch", "voucher_date"], as_dict=True
		)
		if existing and is_newer(existing, epoch, t.get("alterId")):
			frappe.db.set_value(DT_VOUCHER, existing.name, "is_deleted", 1)
			touched.add((distributor, existing.voucher_date))
			count += 1
	summary.rebuild(touched)
	return count


def parse_body(body: bytes) -> dict:
	try:
		return json.loads(body)
	except ValueError as e:
		raise Refused(f"body is not JSON: {e}") from e
