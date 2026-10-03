# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""Deck reports on real Frappe:  bench --site <site> run-tests --app ssv_channel --module ssv_channel.tests.test_reports"""

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from ssv_channel import ingest
from ssv_channel.setup import after_install

DIST = "_TEST-DIST-RPT"
ITEM = "_TEST-SSV-DK100"
TALLY_ITEM = "_Test Dant Kanti 100g"


def batch(kind, **payload):
	return {
		"batch_id": str(uuid.uuid4()), "schema": 2, "kind": kind, "principal": "_TESTP", "distributor_id": DIST,
		"tally_company": {"guid": "_test-rpt-company", "name": "Report Test Co"}, "sync_epoch": 0, "agent_version": "test",
		**payload,
	}


def voucher(guid, date, base_type, direction, qty, rate=55, tracked=False, party="_Test Retailer A"):
	return {
		"guid": guid, "masterId": abs(hash(guid)) % 10**6, "alterId": 1, "date": date, "voucherType": base_type,
		"baseType": base_type, "voucherNumber": guid, "partyLedger": party, "isCancelled": False,
		"lines": [{"item": TALLY_ITEM, "direction": direction, "qty": qty, "billedQty": qty, "unit": "Nos", "rate": rate,
			"amount": qty * rate, "tracked": tracked,
			"allocations": [{"godown": "Main", "qty": qty, "billedQty": qty, "amount": qty * rate, "trackingNumber": "DN/1" if tracked else None}]}],
	}


class TestDeckReports(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		after_install()  # classification fields on Item
		frappe.db.set_single_value("SSV Settings", {"principal_code": "_TESTP", "show_margin": 1})
		# Standard records ERPNext's setup wizard normally creates; a fresh test site may lack them.
		if not frappe.db.exists("UOM", "Nos"):
			frappe.get_doc({"doctype": "UOM", "uom_name": "Nos"}).insert(ignore_permissions=True)
		if not frappe.db.exists("Item Group", "All Item Groups"):
			frappe.get_doc({"doctype": "Item Group", "item_group_name": "All Item Groups", "is_group": 1}).insert(ignore_permissions=True)
		if not frappe.db.exists("Item", ITEM):
			item = {"doctype": "Item", "item_code": ITEM, "item_name": TALLY_ITEM, "item_group": "All Item Groups",
				"stock_uom": "Nos", "is_stock_item": 0, "ssv_product_line": "Tooth Paste", "ssv_category": "Paste",
				"ssv_size": "100Gm"}
			# India Compliance makes an HSN code mandatory on Item.
			if frappe.get_meta("Item").has_field("gst_hsn_code"):
				if not frappe.db.exists("GST HSN Code", "33061020"):
					frappe.get_doc({"doctype": "GST HSN Code", "hsn_code": "33061020", "description": "Toothpaste"}).insert(ignore_permissions=True)
				item["gst_hsn_code"] = "33061020"
			frappe.get_doc(item).insert(ignore_permissions=True)
		if not frappe.db.exists("SSV Distributor", DIST):
			frappe.get_doc({"doctype": "SSV Distributor", "distributor_id": DIST, "distributor_name": "Report Test Distributor",
				"enabled": 1, "agent_secret": "x", "share_cost_price": 1}).insert(ignore_permissions=True)
		apply = lambda b: ingest.apply_batch(DIST, json.loads(json.dumps(b)))  # noqa: E731
		# Tally: 492 in stock on 20-Sep, valued at 10 each
		apply(batch("items", as_of_date="2026-09-20", items=[{"name": TALLY_ITEM, "masterId": 501, "closingQty": 492, "closingValue": 4920}]))
		apply(batch("vouchers", vouchers=[
			voucher("_rpt-p1", "2026-09-01", "Purchase", "in", 500, rate=10),
			voucher("_rpt-s1", "2026-09-05", "Sales", "out", 10),
			voucher("_rpt-c1", "2026-09-08", "Credit Note", "in", 2),
			voucher("_rpt-dn", "2026-09-22", "Delivery Note", "out", 6, party="_Test Retailer B"),
			voucher("_rpt-s2", "2026-09-23", "Sales", "out", 6, tracked=True, party="_Test Retailer B"),
		], parties=[{"name": "_Test Retailer A"}, {"name": "_Test Retailer B"}]))

	def run_report(self, name, **filters):
		module = frappe.get_module(f"ssv_channel.ssv_channel.report.{frappe.scrub(name)}.{frappe.scrub(name)}")
		cols, data = module.execute(frappe._dict({"distributor": DIST, "from_date": "2026-09-01", "to_date": "2026-09-30", **filters}))[:2]
		return cols, data

	def leaf(self, data):
		return next(r for r in data if r.get("indent") == max(x.get("indent", 0) for x in data))

	def test_stock_summary_equation(self):
		_c, data = self.run_report("SSV Stock Summary", group_by="Distributor > Item")
		r = self.leaf(data)
		self.assertEqual(r["opening_qty"], 0)
		self.assertEqual(r["purchase_qty"], 500)
		self.assertEqual(r["net_sale_qty"], 14)            # 10 + 6 − 2
		self.assertEqual(r["closing_qty"], 486)            # 492 − 6 on the delivery note; the tracked invoice does not move stock
		self.assertEqual(r["opening_qty"] + r["purchase_qty"] - r["net_sale_qty"] + r["other_qty"], r["closing_qty"])

	def top(self, data):
		"""First top-level row after the Grand Total."""
		return next(r for r in data if r["indent"] == 0 and not r.get("is_total"))

	def test_sales_analysis_by_category_and_month(self):
		_c, data = self.run_report("SSV Sales Analysis", rows="Category > Item", columns="Month", measure="Net Qty")
		self.assertEqual((data[0]["label"], data[0]["Sep 2026::net_qty"]), ("Grand Total", 14), "the deck's Total row comes first")
		top = self.top(data)
		self.assertEqual(top["label"], "Paste")
		self.assertEqual(top["Sep 2026::net_qty"], 14)

	def test_penetration_counts_outlets(self):
		cols, data = self.run_report("SSV Stock Penetration")
		self.assertEqual(self.top(data)["outlets"], 2)
		self.assertEqual(data[0]["outlets"], 2, "Grand Total counts distinct outlets, not a sum")
		self.assertEqual(data[0]["Sep 2026::sale_qty"], data[0]["sale_qty"], "month columns (deck slide 30)")

	def test_stock_summary_zone_columns(self):
		cols, data = self.run_report("SSV Stock Summary", group_by="State > City", columns="Zone")
		self.assertTrue(any(c["fieldname"].endswith("::closing_qty") and not c["fieldname"].startswith("total") for c in cols))
		self.assertEqual(data[0]["total::closing_qty"], 486)

	def test_secondary_sales_month_on_month(self):
		_c, data = self.run_report("SSV Secondary Sales", group_by="Month on Month (Retailer × Item)")
		total, rows = data[0], data[1:]
		self.assertEqual(total["net_qty"], 14)
		self.assertEqual({r["retailer"] for r in rows}, {"_Test Retailer A", "_Test Retailer B"})
		self.assertEqual(rows[0]["category"], "Paste")
		self.assertEqual(sum(r["Sep 2026::qty"] for r in rows), 14)

	def test_retailer_margin_when_consented(self):
		cols, data = self.run_report("SSV Retailer Performance")
		self.assertIn("margin", [c["fieldname"] for c in cols])
		retailer_a = next(r for r in data if r["indent"] == 1 and r["label"] == "_Test Retailer A")
		self.assertEqual(retailer_a["net_qty"], 8)
		self.assertAlmostEqual(retailer_a["cost_value"], 80)  # 8 × valuation rate 10

	def test_distributor_stock_godown_wise(self):
		# Same total (492) on 21-Sep, now with a split that leaves 2 unaccounted for.
		ingest.apply_batch(DIST, batch("items", as_of_date="2026-09-21", items=[{
			"name": TALLY_ITEM, "masterId": 501, "closingQty": 492, "closingValue": 4920,
			"godowns": [{"godown": "Main Location", "qty": 480, "value": 4800}, {"godown": "Pune Depot", "qty": 10, "value": 100}],
		}]))
		godowns = lambda as_of: [(r["godown"], r["closing_qty"]) for r in self.run_report("SSV Distributor Stock", as_of_date=as_of, godown_wise=1)[1]]  # noqa: E731
		self.assertEqual(godowns("2026-09-21"), [("Main Location", 480), ("Pune Depot", 10), ("Unallocated", 2)])
		self.assertEqual(godowns("2026-09-20"), [("(not reported)", 492)])
		_c, rows = self.run_report("SSV Distributor Stock", as_of_date="2026-09-21", godown_wise=1, godown="Pune Depot")
		self.assertEqual([r["closing_qty"] for r in rows], [10])
		_c, rows = self.run_report("SSV Distributor Stock", as_of_date="2026-09-21")
		self.assertEqual([r["closing_qty"] for r in rows], [492], "without the option: one row per item, as before")

	def test_monthly_summary_gives_the_same_figures_as_the_vouchers(self):
		def both(report, keys, **flt):
			out = []
			for no_summary in (False, True):
				frappe.flags.ssv_no_summary = no_summary
				_c, data = self.run_report(report, **flt)
				out.append({r["id"]: tuple(round(r.get(k) or 0, 2) for k in keys) for r in data if any(r.get(k) for k in keys)})
			frappe.flags.ssv_no_summary = False
			return out

		fast, slow = both("SSV Sales Analysis", ["net_qty", "net_value"], rows="Distributor > Item", columns="None", measure="Net Qty and Value")
		self.assertEqual(fast, slow)
		self.assertTrue(frappe.db.exists("SSV Monthly Summary", {"distributor": DIST, "month": "2026-09-01"}), "September is a whole month: summary used")
		fast, slow = both("SSV Stock Summary", ["opening_qty", "purchase_qty", "net_sale_qty", "closing_qty"], group_by="Distributor > Item")
		self.assertEqual(fast, slow)
		# A period starting and ending mid-month mixes summary and vouchers.
		fast, slow = both("SSV Stock Summary", ["opening_qty", "purchase_qty", "net_sale_qty", "closing_qty"],
			group_by="Distributor", from_date="2026-08-15", to_date="2026-09-06")
		self.assertEqual(fast, slow)

	def test_conversion_factor_converts_quantities_not_values(self):
		ci = frappe.db.get_value("SSV Channel Item", {"distributor": DIST, "tally_item_name": TALLY_ITEM})
		frappe.db.set_value("SSV Channel Item", ci, "conversion_factor", 2)  # e.g. Tally sells packs of 2
		try:
			_c, sales = self.run_report("SSV Sales Analysis", rows="Item", columns="None", measure="Net Qty and Value")
			self.assertEqual(sales[0]["net_qty"], 28, "14 packs of 2")
			_c, before = self.run_report("SSV Sales Analysis", rows="Item", columns="None", measure="Net Value")
			_c, stock = self.run_report("SSV Stock Summary", group_by="Distributor > Item")
			self.assertEqual(self.leaf(stock)["closing_qty"], 972)  # 486 packs = 972 of your unit
			self.assertEqual(self.leaf(stock)["net_sale_qty"], 28)
			_c, ds = self.run_report("SSV Distributor Stock", as_of_date="2026-09-20")
			self.assertEqual(ds[0]["closing_qty"], 984)  # the 492 snapshot, doubled
		finally:
			frappe.db.set_value("SSV Channel Item", ci, "conversion_factor", 1)
		_c, after = self.run_report("SSV Sales Analysis", rows="Item", columns="None", measure="Net Value")
		self.assertEqual(before[0]["net_value"], after[0]["net_value"], "values never change")

	def test_dealer_wording(self):
		# Read-only here: apply() would relabel this (manufacturer's) site.
		from ssv_channel.partner_labels import app_messages, relabel

		cases = {
			"SSV Distributor Stock": "SSV Dealer Stock",
			"Data up to date from {0} of {1} distributors": "Data up to date from {0} of {1} dealers",
			"Retailer Performance": "Customer Performance",
			"Distributors whose totals differ": "Dealers whose totals differ",
			"Put the same value in DISTRIBUTOR_ID in the agent's .env": "Put the same value in DISTRIBUTOR_ID in the agent's .env",
			"Shares Cost Price": "Shares Cost Price",
		}
		for text, want in cases.items():
			self.assertEqual(relabel(text, "Dealer", "Customer"), want)
		messages = {m for m, _ctx in app_messages()}
		for must in ("SSV Distributor", "Distributor", "SSV Retailer", "Data up to date from {0} of {1} distributors"):
			self.assertIn(must, messages, "every label naming a distributor or retailer is found")

	def test_dealers_report_under_their_distributor_and_never_add_to_it(self):
		dealer = "_TEST-DEALER-RPT"
		if not frappe.db.exists("SSV Distributor", dealer):
			frappe.get_doc({"doctype": "SSV Distributor", "distributor_id": dealer, "distributor_name": "Report Test Dealer", "enabled": 1,
				"agent_secret": "y", "partner_level": "Dealer", "parent_distributor": DIST}).insert(ignore_permissions=True)
		b = batch("vouchers", vouchers=[voucher("_rpt-dealer-s1", "2026-09-10", "Sales", "out", 3, party="_Test Consumer")],
			parties=[{"name": "_Test Consumer"}])
		ingest.apply_batch(dealer, {**b, "distributor_id": dealer, "tally_company": {"guid": "_test-rpt-dealer-co", "name": "Dealer Co"}})

		_c, data = self.run_report("SSV Sales Analysis", rows="Distributor > Item", columns="None", measure="Net Qty")
		self.assertEqual(data[0]["net_qty"], 14, "default level Distributor: the dealer's sales are not added in")

		_c, data = self.run_report("SSV Sales Analysis", level="Dealer", rows="Distributor > Dealer > Item", columns="None", measure="Net Qty")
		self.assertEqual(data[0]["net_qty"], 3, "choosing the distributor at level Dealer selects its dealers")
		labels = [(r["indent"], r["label"]) for r in data if not r.get("is_total")]
		self.assertEqual(labels[:2], [(0, "Report Test Distributor"), (1, "Report Test Dealer")])

		doc = frappe.get_doc("SSV Distributor", dealer)
		doc.parent_distributor = None
		self.assertRaises(frappe.ValidationError, doc.save)
		doc.reload()
		doc.parent_distributor = dealer
		self.assertRaises(frappe.ValidationError, doc.save)

	def test_sync_health_status(self):
		from frappe.utils import add_to_date, now_datetime

		from ssv_channel.ssv_channel.report.ssv_sync_health.ssv_sync_health import health_status
		now = now_datetime()
		ago = lambda h: add_to_date(now, hours=-h)  # noqa: E731
		self.assertEqual(health_status({"last_ok_run_at": ago(1)}, now), "OK")
		self.assertEqual(health_status({"last_ok_run_at": ago(1), "last_run_status": "Failed"}, now), "Failing")
		self.assertEqual(health_status({"last_seen_at": ago(30)}, now), "Stale")
		self.assertEqual(health_status({"last_seen_at": ago(30), "sync_interval_minutes": 1440}, now), "OK",
			"a once-a-day agent is not stale 30 hours after its last run")
		self.assertEqual(health_status({"last_seen_at": ago(100)}, now), "Silent")
		self.assertEqual(health_status({}, now), "Silent")
		self.assertEqual(health_status({"last_ok_run_at": ago(1), "rejected": 2}, now), "Errors")
		self.assertEqual(health_status({"last_ok_run_at": ago(1), "reconcile_status": "Mismatch"}, now), "Mismatch")
		self.assertEqual(health_status({"last_seen_at": ago(30), "reconcile_status": "Mismatch"}, now), "Stale",
			"no recent data matters more than old totals")

	def test_bill_register_and_sync_log_run(self):
		_c, data = self.run_report("SSV Bill Register")
		self.assertEqual(len(data), 6, "Total row + 5 voucher lines")
		self.assertEqual(data[0]["qty"], sum(r["qty"] for r in data[1:]))
		module = frappe.get_module("ssv_channel.ssv_channel.report.ssv_sync_log.ssv_sync_log")
		_c, rows = module.execute(frappe._dict(month=frappe.utils.today()))
		self.assertTrue(any(r["distributor"] == DIST for r in rows))

	def test_dashboard_and_alerts_build(self):
		from ssv_channel import alerts, dashboard
		d = dashboard.get_data(distributor=DIST)
		self.assertIn("monthly", d)
		self.assertEqual(d["coverage"]["total"], 1)
		self.assertIsInstance(alerts.build_message([], [], 24), str)
