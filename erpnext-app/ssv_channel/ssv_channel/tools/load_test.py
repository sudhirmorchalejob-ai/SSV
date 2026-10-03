# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Synthetic volume for the SSV reports. TEST SITES ONLY: every function refuses to
run unless the site has `allow_tests` set.

Batches go through ingest.apply_batch, the path the agent's batches take, so a
run measures ingest speed as well as report speed. Every record belongs to a
distributor whose ID starts with LOAD-; cleanup() removes them and all they own.
Items, brands and territories are shared masters and are left in place.

  bench --site ssv-test execute ssv_channel.tools.load_test.setup_catalogue
  bench --site ssv-test execute ssv_channel.tools.load_test.generate --kwargs "{'distributors': 25}"
  bench --site ssv-test execute ssv_channel.tools.load_test.timings
  bench --site ssv-test execute ssv_channel.tools.load_test.cleanup

What a distributor looks like: 20–60 retailers; every day of the period (not only
the 1st, 2nd and 31st Educational-mode Tally allows), sales bills from Main
Location or a branch godown, weekly purchases from CEAT, returns, delivery notes
invoiced a few days later, a monthly godown transfer, and a closing-stock
snapshot at every month end and today. A few distributors are left stale,
silent or failing so the sync reports have something to show.
"""

import json
import math
import os
import random
import time
import uuid
from collections import defaultdict
from datetime import date, timedelta

import frappe
from frappe.utils import add_days, add_months, get_first_day, get_last_day, getdate, now_datetime

from ssv_channel import ingest

PREFIX = "LOAD-"
PRINCIPAL_RULE = "Ceat Tyre"
CATALOGUE = os.path.join(os.path.dirname(__file__), "catalogue.json")
HSN = "40111010"  # new pneumatic tyres of rubber, for motor cars

CITIES = [
	("North Zone", "Delhi", "New Delhi"), ("North Zone", "Uttar Pradesh", "Lucknow"), ("North Zone", "Uttar Pradesh", "Kanpur"),
	("North Zone", "Punjab", "Ludhiana"), ("North Zone", "Rajasthan", "Jaipur"),
	("South Zone", "Karnataka", "Bengaluru"), ("South Zone", "Karnataka", "Mysuru"), ("South Zone", "Tamil Nadu", "Chennai"),
	("South Zone", "Tamil Nadu", "Coimbatore"), ("South Zone", "Telangana", "Hyderabad"), ("South Zone", "Kerala", "Kochi"),
	("East Zone", "West Bengal", "Kolkata"), ("East Zone", "Odisha", "Bhubaneswar"), ("East Zone", "Bihar", "Patna"),
	("East Zone", "Assam", "Guwahati"),
	("West Zone", "Maharashtra", "Mumbai"), ("West Zone", "Maharashtra", "Nagpur"), ("West Zone", "Maharashtra", "Nashik"),
	("West Zone", "Gujarat", "Ahmedabad"), ("West Zone", "Gujarat", "Surat"), ("West Zone", "Madhya Pradesh", "Indore"),
]
SHOPS = ["Sri Balaji Tyres", "Apex Tyre Agencies", "Metro Wheels", "Highway Tyre Depot", "Royal Tyre House", "Star Auto Tyres",
	"Om Sai Tyre Traders", "Ganesh Wheel Care", "New India Tyres", "Maruti Tyre Agency", "Jai Hind Tyres", "Prakash Tyre Co"]
RETAIL_A = ["Sai", "Shree", "Om", "Balaji", "Ganesh", "Laxmi", "New", "Royal", "City", "Highway", "Star", "Maruti",
	"Jai Hind", "Metro", "Prakash", "Kumar", "Sharma", "Gupta", "Patel", "Reddy", "Singh", "Iyer", "Das", "Khan"]
RETAIL_B = ["Tyres", "Auto Parts", "Tyre House", "Motors", "Wheel Care", "Tyre Point", "Auto Centre", "Tyre Traders", "Garage"]
SEASON = {1: 0.9, 2: 0.85, 3: 1.0, 4: 1.0, 5: 1.05, 6: 0.9, 7: 0.8, 8: 0.85, 9: 1.0, 10: 1.3, 11: 1.35, 12: 1.1}


def _guard():
	if not frappe.conf.get("allow_tests"):
		frappe.throw("Load tests only run on a test site (site_config allow_tests = 1).")


def _catalogue():
	with open(CATALOGUE, encoding="utf-8") as f:
		return json.load(f)


# ── masters ─────────────────────────────────────────────────────────────────


def _territory(name, parent, is_group):
	if not frappe.db.exists("Territory", name):
		frappe.get_doc({"doctype": "Territory", "territory_name": name, "parent_territory": parent, "is_group": is_group}).insert(ignore_permissions=True)
	return name


def setup_catalogue():
	"""CEAT Items with the channel classification, and the Territory tree for the load-test cities."""
	_guard()
	cat = _catalogue()
	if not frappe.db.exists("Brand", "CEAT"):
		frappe.get_doc({"doctype": "Brand", "brand": "CEAT"}).insert(ignore_permissions=True)
	group = "CEAT Tyres" if frappe.db.exists("Item Group", "CEAT Tyres") else "All Item Groups"
	has_hsn = frappe.get_meta("Item").has_field("gst_hsn_code")
	if has_hsn and not frappe.db.exists("GST HSN Code", HSN):
		frappe.get_doc({"doctype": "GST HSN Code", "hsn_code": HSN, "description": "Tyres"}).insert(ignore_permissions=True)
	for it in cat["items"]:
		if not it["in_erpnext"]:
			continue
		fields = {"item_name": it["tally_name"], "brand": it["brand"], "ssv_product_line": it["product_line"],
			"ssv_category": it["category"], "ssv_sub_category": it["sub_category"], "ssv_size": it["size"],
			"ssv_size_group": it["size_group"], "ssv_size_sort": it["size_sort"], "ssv_product_class": it["product_class"]}
		if frappe.db.exists("Item", it["item_code"]):
			frappe.db.set_value("Item", it["item_code"], fields)
		else:
			doc = {"doctype": "Item", "item_code": it["item_code"], "item_group": group, "stock_uom": "Nos",
				"is_stock_item": 0, **fields}
			if has_hsn:
				doc["gst_hsn_code"] = HSN
			frappe.get_doc(doc).insert(ignore_permissions=True)
	root = frappe.db.get_value("Territory", {"is_group": 1, "parent_territory": ["in", ["", None]]}, "name") or "All Territories"
	india = _territory("India", root, 1)
	for zone, state, city in CITIES:
		_territory(zone, india, 1)
		_territory(state, zone, 1)
		_territory(city, state, 0)
	frappe.db.commit()
	print(f"CEAT items: {sum(1 for i in cat['items'] if i['in_erpnext'])} in ERPNext; territories for {len(CITIES)} cities")


# ── one distributor's books ─────────────────────────────────────────────────


class Books:
	"""A distributor's Tally, simulated: vouchers in agent format plus stock per godown."""

	def __init__(self, rng, key, items, scale):
		self.rng, self.key, self.items, self.scale = rng, key, items, scale
		self.seq = 0
		self.stock = defaultdict(float)  # (item, godown) -> qty
		self.vouchers = []
		self.expected = defaultdict(lambda: defaultdict(float))  # month -> measure -> value

	def _next(self):
		self.seq += 1
		return self.seq

	def add(self, day, vtype, number_prefix, party, lines):
		n = self._next()
		self.vouchers.append({
			"guid": f"{self.key}-{n}", "masterId": n, "alterId": n, "date": day.isoformat(), "voucherType": vtype,
			"baseType": vtype, "voucherNumber": f"{number_prefix}/{n}", "partyLedger": party, "isCancelled": False,
			"lines": lines,
		})

	def line(self, item, direction, qty, rate, godown, tracked=None):
		amount = round(qty * rate, 2)
		sign = -1 if direction == "out" else 1
		if not tracked:
			self.stock[(item["tally_name"], godown)] += sign * qty
		return {"item": item["tally_name"], "direction": direction, "qty": qty, "billedQty": qty, "unit": "Nos",
			"rate": rate, "amount": amount, "discountPct": 0, "tracked": bool(tracked),
			"allocations": [{"godown": godown, "batch": "Primary Batch", "qty": qty, "billedQty": qty, "amount": amount,
				"trackingNumber": tracked}]}

	def pick_godown(self, item, qty):
		main = self.stock[(item["tally_name"], "Main Location")]
		return "Main Location" if main >= qty or self.rng.random() < 0.7 else "Branch Godown"


def _items_with_weights(cat):
	items = cat["items"]
	return items, [i["weight"] for i in items]


def _qty(rng, item):
	return rng.randint(1, 4) if item["category"] == "Truck Tyre" else rng.randint(2, 12)


def _simulate(rng, key, cat, retailers, start, end, scale, stop_at):
	items, weights = _items_with_weights(cat)
	b = Books(rng, key, items, scale)
	pending_dn = []  # (invoice_day, retailer, dn_no, [(item, qty, rate)])
	pending_cn = []  # (return_day, retailer, item, qty, rate)
	ret_weights = [1 / (k + 1) ** 0.8 for k in range(len(retailers))]  # a few big buyers, a long tail
	day = start
	while day <= min(end, stop_at):
		month_key = day.strftime("%Y-%m")
		# Weekly purchase on Monday (and on the first day): top every item up to about a month of sales.
		if day.weekday() == 0 or day == start:
			lines = []
			for it in items:
				target = round(it["weight"] * scale * 12)
				have = b.stock[(it["tally_name"], "Main Location")] + b.stock[(it["tally_name"], "Branch Godown")]
				qty = int(math.ceil(max(0, target - have) / 5.0) * 5)
				if qty:
					lines.append(b.line(it, "in", qty, it["buy"], "Main Location"))
			if lines:
				b.add(day, "Purchase", "PUR", "CEAT Ltd", lines)
		# Monthly transfer: a fifth of Main Location to the branch.
		if day.day == 1:
			lines = []
			for it in items:
				move = int(b.stock[(it["tally_name"], "Main Location")] * 0.2)
				if move > 0:
					lines.append(b.line(it, "out", move, 0, "Main Location"))
					lines.append(b.line(it, "in", move, 0, "Branch Godown"))
			if lines:
				b.add(day, "Stock Journal", "SJ", None, lines)
		# Sales bills.
		lam = 5 * scale * SEASON[day.month] * (0.25 if day.weekday() == 6 else 1.0)
		for _ in range(max(0, int(round(lam + rng.gauss(0, math.sqrt(lam)))))):
			retailer = rng.choices(retailers, weights=ret_weights)[0]
			chosen = []
			for it in rng.choices(items, weights=weights, k=rng.choice([1, 1, 2, 2, 3, 4])):
				if it not in chosen:
					chosen.append(it)
			disc = rng.choice([0, 0, 0.02, 0.03, 0.05])
			if rng.random() < 0.06:
				# Delivery note today, invoice against it 1–3 days later.
				dn = [(it, _qty(rng, it), round(it["sell"] * (1 - disc), 2)) for it in chosen]
				lines = [b.line(it, "out", q, r, "Main Location") for it, q, r in dn]
				b.add(day, "Delivery Note", "DN", retailer, lines)
				pending_dn.append((add_days(day, rng.randint(1, 3)), retailer, f"DN/{b.seq}", dn))
				continue
			lines = []
			for it in chosen:
				q = _qty(rng, it)
				r = round(it["sell"] * (1 - disc), 2)
				lines.append(b.line(it, "out", q, r, b.pick_godown(it, q)))
				b.expected[month_key]["sale_qty"] += q
				b.expected[month_key]["sale_value"] += round(q * r, 2)
				if rng.random() < 0.03:
					pending_cn.append((add_days(day, rng.randint(2, 10)), retailer, it, max(1, q // 3), r))
			b.add(day, "Sales", "INV", retailer, lines)
		# Invoices against delivery notes, and returns, that fall due today.
		for due, retailer, dn_no, dn in [p for p in pending_dn if getdate(p[0]) == day]:
			lines = [b.line(it, "out", q, r, "Main Location", tracked=dn_no) for it, q, r in dn]
			for it, q, r in dn:
				b.expected[month_key]["sale_qty"] += q
				b.expected[month_key]["sale_value"] += round(q * r, 2)
			b.add(day, "Sales", "INV", retailer, lines)
		pending_dn = [p for p in pending_dn if getdate(p[0]) != day]
		for due, retailer, it, q, r in [p for p in pending_cn if getdate(p[0]) == day]:
			b.add(day, "Credit Note", "CN", retailer, [b.line(it, "in", q, r, "Main Location")])
			b.expected[month_key]["return_qty"] += q
			b.expected[month_key]["return_value"] += round(q * r, 2)
		pending_cn = [p for p in pending_cn if getdate(p[0]) != day]
		day = day + timedelta(days=1)
	return b


def _stock_at(b, items, as_of):
	"""Closing per item and godown on a date, replayed from the vouchers (tracked lines do not move stock)."""
	s = defaultdict(float)
	for v in b.vouchers:
		if v["date"] > as_of.isoformat():
			break
		for ln in v["lines"]:
			if ln["tracked"]:
				continue
			sign = -1 if ln["direction"] == "out" else 1
			s[(ln["item"], ln["allocations"][0]["godown"])] += sign * ln["qty"]
	out = []
	for it in items:
		godowns = [{"godown": g, "qty": s[(it["tally_name"], g)], "value": round(s[(it["tally_name"], g)] * it["buy"], 2)}
			for g in ("Branch Godown", "Main Location") if s[(it["tally_name"], g)]]
		qty = sum(g["qty"] for g in godowns)
		out.append({"name": it["tally_name"], "masterId": 900 + items.index(it), "groupPath": ["Ceat Tyre", it["group"]],
			"group": it["group"], "baseUnit": "Nos", "hsnCode": HSN, "closingQty": qty,
			"closingValue": round(qty * it["buy"], 2), "godowns": godowns})
	return out


def _send(did, company, kind, payload):
	batch = {"batch_id": str(uuid.uuid4()), "schema": 2, "kind": kind, "principal": ingest.principal_code(),
		"distributor_id": did, "tally_company": company, "sync_epoch": 0, "agent_version": "load-test", **payload}
	status, _res = ingest.apply_batch(did, batch)
	frappe.db.commit()
	return status


# ── commands ────────────────────────────────────────────────────────────────


def generate(distributors=25, months=18, seed=7, bills_per_day=None):
	"""Create LOAD- distributors and push their books through ingest. Safe to re-run: existing LOAD- IDs are skipped."""
	_guard()
	frappe.flags.mute_emails = True
	cat = _catalogue()
	rng = random.Random(seed)
	today = getdate()
	start = get_first_day(add_months(today, -(months - 1)))
	expected_all = {}
	t0 = time.time()
	total_vouchers = 0
	for i in range(int(distributors)):
		did = f"{PREFIX}{i + 1:03d}"
		zone, state, city = CITIES[i % len(CITIES)]
		name = f"{SHOPS[i % len(SHOPS)]} {city}"
		if frappe.db.exists("SSV Distributor", did):
			print(f"{did} exists, skipped")
			continue
		frappe.get_doc({"doctype": "SSV Distributor", "distributor_id": did, "distributor_name": name, "territory": city,
			"enabled": 1, "share_cost_price": 1 if i % 3 == 0 else 0, "sync_interval_minutes": rng.choice([5, 15, 30, 60, 1440]),
			"data_sharing_consent_date": start,
			"rules": [{"rule_type": "Stock Group", "tally_value": PRINCIPAL_RULE}]}).insert(ignore_permissions=True)
		company = {"guid": f"load-company-{i + 1:03d}", "name": f"{name} (load test)"}
		n_ret = rng.randint(20, 60)
		names = set()
		while len(names) < n_ret:
			names.add(f"{rng.choice(RETAIL_A)} {rng.choice(RETAIL_B)} {rng.randint(1, 99)}")
		retailers = sorted(names)
		scale = rng.uniform(0.5, 2.0) * (float(bills_per_day) / 5 if bills_per_day else 1)
		# A few distributors stopped sending: stale (4 days), silent (10 days).
		stop_at = add_days(today, -4) if i == 6 else add_days(today, -10) if i == 12 else today
		b = _simulate(rng, company["guid"], cat, retailers, start, today, scale, getdate(stop_at))

		parties = [{"name": r, "group": "Sundry Debtors", "state": state} for r in retailers]
		sent = 0
		for k in range(0, len(b.vouchers), 500):
			payload = {"vouchers": b.vouchers[k:k + 500]}
			if k == 0:
				payload["parties"] = parties
			_send(did, company, "vouchers", payload)
			sent += len(payload["vouchers"])
		# Month-end snapshots, then today (or the day it stopped).
		items = cat["items"]
		d = get_last_day(start)
		last = getdate(stop_at)
		while d < last:
			_send(did, company, "items", {"as_of_date": d.isoformat(), "items": _stock_at(b, items, d)})
			d = get_last_day(add_days(d, 1))
		_send(did, company, "items", {"as_of_date": last.isoformat(), "items": _stock_at(b, items, last)})

		# Run reports, as the agent's heartbeat would set them.
		status = {"last_run_status": "OK", "last_run_problem": None, "last_ok_run_at": now_datetime(), "last_run_at": now_datetime(),
			"last_contact_at": now_datetime(), "agent_version": "0.4.0"}
		if i == 4:
			status.update(last_run_status="Failed", last_run_problem="TallyPrime is not reachable on http://localhost:9000.")
		if i in (6, 12):
			status = {"last_run_status": None, "last_ok_run_at": None, "last_run_at": None, "last_contact_at": None}
			frappe.db.set_value("SSV Distributor", did, "last_seen_at", f"{last} 18:00:00", update_modified=False)
		frappe.db.set_value("SSV Distributor", did, status, update_modified=False)
		frappe.db.commit()

		expected_all[did] = {m: dict(v) for m, v in b.expected.items()}
		total_vouchers += sent
		print(f"{did} {name}: {sent} vouchers, {len(retailers)} retailers, total so far {total_vouchers} "
			f"in {time.time() - t0:.0f}s ({total_vouchers / max(1, time.time() - t0):.0f} vouchers/s)")

	path = frappe.get_site_path("private", "load_test_expected.json")
	old = {}
	if os.path.exists(path):
		with open(path) as f:
			old = json.load(f)
	old.update(expected_all)
	with open(path, "w") as f:
		json.dump(old, f)
	print(f"Done: {total_vouchers} vouchers in {time.time() - t0:.0f}s. Expected totals saved to {path}")


def _run(report, **flt):
	mod = frappe.get_module(f"ssv_channel.ssv_channel.report.{frappe.scrub(report)}.{frappe.scrub(report)}")
	t = time.time()
	res = mod.execute(frappe._dict(flt))
	return time.time() - t, res


def timings():
	"""How long each deck report takes at the current volume, and whether LOAD- sales totals match the generator."""
	_guard()
	frappe.set_user("Administrator")
	today = getdate()
	fy_from = date(today.year if today.month >= 4 else today.year - 1, 4, 1)
	counts = frappe.db.sql("""SELECT COUNT(*) FROM `tabSSV Secondary Voucher`""")[0][0], \
		frappe.db.sql("""SELECT COUNT(*) FROM `tabSSV Secondary Voucher Item`""")[0][0]
	print(f"Volume: {counts[0]} vouchers, {counts[1]} voucher lines, {frappe.db.count('SSV Distributor')} distributors")
	FY = dict(from_date=fy_from, to_date=today)
	checks = [
		("SSV Sales Analysis", dict(rows="Distributor > Item", columns="Month", measure="Net Qty", **FY)),
		("SSV Sales Analysis", dict(rows="Product Line > Brand > Category > Item", columns="Distributor", measure="Net Qty and Value", **FY)),
		("SSV Sales Analysis", dict(rows="Zone > State > City", columns="Month", measure="Net Value", **FY)),
		("SSV Stock Summary", dict(group_by="Distributor > Item", **FY)),
		("SSV Stock Summary", dict(group_by="Zone > State > City > Distributor", period="Current Month")),
		("SSV Stock Penetration", dict(period="Current Week")),
		("SSV Retailer Performance", dict(period="Current Month")),
		("SSV Bill Register", dict(period="Current Month")),
		("SSV Distributor Stock", dict(as_of_date=today, godown_wise=1)),
		("SSV Sync Log", dict(month=today)),
		("SSV Sync Health", dict(from_date=add_days(today, -7), to_date=today)),
	]
	for report, flt in checks:
		try:
			secs, res = _run(report, **flt)
			print(f"  {secs:6.2f}s  {report:<26} {flt.get('rows') or flt.get('group_by') or flt.get('period') or ''}  rows={len(res[1])}")
		except Exception as e:
			print(f"  ERROR    {report}: {e}")
	from ssv_channel import dashboard
	t = time.time()
	dashboard.get_data()
	print(f"  {time.time() - t:6.2f}s  SSV Dashboard")

	# The summary path must give exactly what the voucher lines give.
	def totals(report, keys, **flt):
		_s, res = _run(report, **flt)
		return {r["id"]: tuple(round(r.get(k) or 0, 2) for k in keys) for r in res[1] if any(r.get(k) for k in keys)}

	compare = [
		("SSV Sales Analysis", ["net_qty", "net_value"], dict(rows="Distributor > Item", columns="None", measure="Net Qty and Value", **FY)),
		("SSV Sales Analysis", ["net_qty"], dict(rows="Zone > State > City", columns="None", measure="Net Qty",
			from_date=add_days(fy_from, 10), to_date=add_days(today, -3))),
		("SSV Stock Summary", ["opening_qty", "purchase_qty", "net_sale_qty", "closing_qty", "closing_value"], dict(group_by="Distributor > Item", **FY)),
		("SSV Stock Summary", ["opening_qty", "purchase_qty", "net_sale_qty", "closing_qty"], dict(group_by="Distributor",
			from_date=add_days(fy_from, -45), to_date=add_days(today, -20))),
	]
	for report, keys, flt in compare:
		fast = totals(report, keys, **flt)
		frappe.flags.ssv_no_summary = True
		t = time.time()
		slow = totals(report, keys, **flt)
		secs = time.time() - t
		frappe.flags.ssv_no_summary = False
		diff = [k for k in set(fast) | set(slow) if fast.get(k) != slow.get(k)]
		print(f"  summary vs vouchers, {report} {flt.get('rows') or flt.get('group_by')} ({flt['from_date']} → {flt['to_date']}): "
			f"{'identical' if not diff else f'{len(diff)} rows differ, e.g. {diff[:2]}'} over {len(slow)} rows (voucher path {secs:.1f}s)")
		for k in diff[:3]:
			print(f"      {k}: summary {fast.get(k)} vs vouchers {slow.get(k)}")

	# Correctness: net sales per LOAD- distributor this FY = generator's expectation.
	path = frappe.get_site_path("private", "load_test_expected.json")
	if not os.path.exists(path):
		return
	with open(path) as f:
		expected = json.load(f)
	_secs, (cols, data, *_rest) = _run("SSV Sales Analysis", rows="Distributor", columns="None", measure="Net Qty and Value", **FY)
	got = {r["label"]: r for r in data}
	names = dict(frappe.get_all("SSV Distributor", filters={"name": ["like", f"{PREFIX}%"]}, fields=["name", "distributor_name"], as_list=True))
	bad = 0
	for did, months_ in expected.items():
		want_q = sum(m.get("sale_qty", 0) - m.get("return_qty", 0) for k, m in months_.items() if k >= fy_from.strftime("%Y-%m"))
		want_v = sum(m.get("sale_value", 0) - m.get("return_value", 0) for k, m in months_.items() if k >= fy_from.strftime("%Y-%m"))
		r = got.get(names.get(did), {})
		if abs((r.get("net_qty") or 0) - want_q) > 0.001 or abs((r.get("net_value") or 0) - want_v) > 0.5:
			bad += 1
			print(f"  MISMATCH {did}: report {r.get('net_qty')} / {r.get('net_value')}, generator {want_q} / {round(want_v, 2)}")
	print(f"Net sales this FY match the generator for {len(expected) - bad} of {len(expected)} load-test distributors")


def cleanup():
	"""Remove every LOAD- distributor and everything it owns. Shared masters stay."""
	_guard()
	dists = frappe.get_all("SSV Distributor", filters={"name": ["like", f"{PREFIX}%"]}, pluck="name")
	if not dists:
		print("Nothing to remove")
		return
	p = {"d": dists}
	q = frappe.db.sql
	q("""DELETE i FROM `tabSSV Secondary Voucher Item` i JOIN `tabSSV Secondary Voucher` v ON v.name = i.parent WHERE v.distributor IN %(d)s""", p)
	q("""DELETE FROM `tabSSV Secondary Voucher` WHERE distributor IN %(d)s""", p)
	q("""DELETE g FROM `tabSSV Stock Snapshot Godown` g JOIN `tabSSV Stock Snapshot` s ON s.name = g.parent WHERE s.distributor IN %(d)s""", p)
	q("""DELETE FROM `tabSSV Stock Snapshot` WHERE distributor IN %(d)s""", p)
	for dt in ("SSV Monthly Summary", "SSV Channel Item", "SSV Retailer", "SSV Tally Company", "SSV Ingest Log"):
		q(f"""DELETE FROM `tab{dt}` WHERE distributor IN %(d)s""", p)
	q("""DELETE FROM `tabSSV Distributor Rule` WHERE parent IN %(d)s""", p)
	q("""DELETE FROM `tabSSV Distributor` WHERE name IN %(d)s""", p)
	frappe.db.commit()
	path = frappe.get_site_path("private", "load_test_expected.json")
	if os.path.exists(path):
		os.remove(path)
	print(f"Removed {len(dists)} load-test distributors and their data")
