# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""Run on the bench:  bench --site <site> run-tests --app ssv_channel"""

import hashlib
import hmac
import json
import time
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from ssv_channel import ingest

SECRET = "test-agent-secret"
DIST = "_TEST-DIST-SSV"


def signed(body: bytes, ts=None):
	ts = str(ts or int(time.time()))
	sig = hmac.new(SECRET.encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()
	return DIST, ts, sig, body


def batch(kind, **payload):
	return {
		"batch_id": str(uuid.uuid4()),
		"schema": 2,
		"kind": kind,
		"principal": "_TESTP",
		"distributor_id": DIST,
		"tally_company": {"guid": "_test-company-guid", "name": "Test Distributor Co"},
		"sync_epoch": payload.pop("sync_epoch", 0),
		"agent_version": "test",
		**payload,
	}


def voucher(guid="_test-v1", alter=10, qty=10, vtype="Sales", direction="out"):
	return {
		"guid": guid, "masterId": 1, "alterId": alter, "date": "2026-09-20",
		"voucherType": vtype, "baseType": vtype, "voucherNumber": "INV/1", "partyLedger": "Test Retailer",
		"isCancelled": False,
		"lines": [{
			"item": "Test Toothpaste 100g", "direction": direction, "qty": qty, "billedQty": qty, "unit": "Nos",
			"rate": 55, "amount": qty * 55, "discountPct": 0,
			"allocations": [{"godown": "Main", "batch": None, "qty": qty, "billedQty": qty, "amount": qty * 55}],
		}],
	}


class TestIngest(FrappeTestCase):
	def setUp(self):
		frappe.db.set_single_value("SSV Settings", {"principal_code": "_TESTP", "clock_skew_seconds": 300})
		if not frappe.db.exists("SSV Distributor", DIST):
			frappe.get_doc({
				"doctype": "SSV Distributor", "distributor_id": DIST, "distributor_name": "Test Distributor",
				"enabled": 1, "agent_secret": SECRET,
				"rules": [{"rule_type": "Stock Group", "tally_value": "Test Brand"}],
			}).insert(ignore_permissions=True)

	def apply(self, b):
		body = json.dumps(b).encode()
		distributor = ingest.verify_request(*signed(body))
		return ingest.apply_batch(distributor, json.loads(body))

	def test_signature_checks(self):
		body = b"{}"
		self.assertEqual(ingest.verify_request(*signed(body)), DIST)
		dist, ts, sig, _ = signed(body)
		self.assertRaises(frappe.AuthenticationError, ingest.verify_request, dist, ts, sig, b'{"x":1}')
		self.assertRaises(frappe.AuthenticationError, ingest.verify_request, *signed(body, ts=int(time.time()) - 3600))
		self.assertRaises(frappe.AuthenticationError, ingest.verify_request, "nobody", ts, sig, body)

	def test_config_returns_this_distributors_rules(self):
		rules = ingest.distributor_rules(DIST)
		self.assertEqual(rules["principals"][0]["code"], "_TESTP")
		self.assertEqual(rules["principals"][0]["stockGroups"], ["Test Brand"])

	def test_agent_settings_and_sync_now(self):
		frappe.db.set_value("SSV Distributor", DIST, {"sync_interval_minutes": 60, "sync_requested_at": None})
		s = ingest.agent_settings(DIST)  # may also offer an update approved on this site
		self.assertEqual((s["syncIntervalMinutes"], s["syncRequestedAt"]), (60, None))
		frappe.get_doc("SSV Distributor", DIST).request_sync()
		token = ingest.agent_settings(DIST)["syncRequestedAt"]
		self.assertTrue(token)

		doc = frappe.get_doc("SSV Distributor", DIST)
		doc.sync_interval_minutes = 2
		self.assertRaises(frappe.ValidationError, doc.save)

	def test_config_offers_the_approved_agent_update(self):
		fields = ("agent_version", "agent_download_url", "agent_sha256")
		approved = {f: frappe.db.get_single_value("SSV Settings", f) for f in fields}  # the site's real approval
		frappe.db.set_single_value("SSV Settings", {"agent_version": "0.5.0", "agent_download_url": "https://example.com/ssv-agent.exe",
			"agent_sha256": "AB" * 32})
		frappe.clear_document_cache("SSV Settings", "SSV Settings")
		try:
			frappe.db.set_value("SSV Distributor", DIST, "auto_update", 1)
			self.assertEqual(ingest.agent_settings(DIST)["update"],
				{"version": "0.5.0", "url": "https://example.com/ssv-agent.exe", "sha256": "ab" * 32})
			frappe.db.set_value("SSV Distributor", DIST, "auto_update", 0)
			self.assertNotIn("update", ingest.agent_settings(DIST), "distributor opted out")
		finally:
			frappe.db.set_single_value("SSV Settings", approved)
			frappe.clear_document_cache("SSV Settings", "SSV Settings")

	def test_heartbeat_records_the_run(self):
		ingest.apply_heartbeat(DIST, {"distributor_id": DIST, "agent_version": "0.4.0", "run": {"ok": True, "problem": None}})
		d = frappe.db.get_value("SSV Distributor", DIST, ["last_run_status", "last_ok_run_at", "last_contact_at", "agent_version"], as_dict=True)
		self.assertEqual((d.last_run_status, d.agent_version), ("OK", "0.4.0"))
		self.assertTrue(d.last_ok_run_at and d.last_contact_at)

		ingest.apply_heartbeat(DIST, {"distributor_id": DIST, "run": {"ok": False, "problem": "TallyPrime is not reachable"}})
		d = frappe.db.get_value("SSV Distributor", DIST, ["last_run_status", "last_run_problem", "last_ok_run_at"], as_dict=True)
		self.assertEqual((d.last_run_status, d.last_run_problem), ("Failed", "TallyPrime is not reachable"))
		self.assertTrue(d.last_ok_run_at, "the last successful run is kept")

		self.assertRaises(ingest.Refused, ingest.apply_heartbeat, DIST, {"distributor_id": "SOMEONE", "run": {"ok": True}})

	def test_items_create_channel_item_and_snapshot(self):
		status, _ = self.apply(batch("items", as_of_date="2026-09-24", items=[
			{"name": "Test Toothpaste 100g", "masterId": 7, "groupPath": ["Test Brand"], "closingQty": -4, "closingValue": 0},
		]))
		self.assertEqual(status, 202)
		ci = frappe.get_doc("SSV Channel Item", {"tally_item_name": "Test Toothpaste 100g"})
		self.assertEqual(ci.closing_qty, -4, "negative stock is kept")
		self.assertTrue(frappe.db.exists("SSV Stock Snapshot", {"channel_item": ci.name, "as_of_date": "2026-09-24"}))

	def test_items_with_godown_split(self):
		item = {"name": "Test Tyre Godown", "masterId": 8, "groupPath": ["Test Brand"], "closingQty": 100, "closingValue": 5000}
		split = [{"godown": "Main Location", "qty": 70, "value": 3500}, {"godown": "Pune Depot", "qty": 30, "value": 1500}]
		self.apply(batch("items", as_of_date="2026-09-25", items=[{**item, "godowns": split}]))
		ci = frappe.db.get_value("SSV Channel Item", {"tally_item_name": "Test Tyre Godown"})
		snap = frappe.get_doc("SSV Stock Snapshot", {"channel_item": ci, "as_of_date": "2026-09-25"})
		self.assertEqual(snap.godown_split, 1)
		self.assertEqual([(g.godown, g.closing_qty) for g in snap.godowns], [("Main Location", 70), ("Pune Depot", 30)])

		# Same day, sent by an agent without the split: the stored split stays.
		self.apply(batch("items", as_of_date="2026-09-25", items=[{**item, "closingQty": 100}]))
		self.assertEqual(len(frappe.get_doc("SSV Stock Snapshot", snap.name).godowns), 2)

		# A transfer: same total, new split replaces the old one.
		moved = [{"godown": "Main Location", "qty": 40, "value": 2000}, {"godown": "Pune Depot", "qty": 60, "value": 3000}]
		self.apply(batch("items", as_of_date="2026-09-25", items=[{**item, "godowns": moved}]))
		self.assertEqual([(g.godown, g.closing_qty) for g in frappe.get_doc("SSV Stock Snapshot", snap.name).godowns],
			[("Main Location", 40), ("Pune Depot", 60)])

	def test_unmapped_item_gets_a_suggestion_a_person_can_accept(self):
		from ssv_channel import mapping

		code = "_TEST-SSV-ZOOM-205"
		if not frappe.db.exists("Item", code):
			if not frappe.db.exists("UOM", "Nos"):
				frappe.get_doc({"doctype": "UOM", "uom_name": "Nos"}).insert(ignore_permissions=True)
			item = {"doctype": "Item", "item_code": code, "item_name": "Test Tyreco Zoom 205/55 R16 Car Tyre",
				"item_group": "All Item Groups", "stock_uom": "Nos", "is_stock_item": 0}
			if frappe.get_meta("Item").has_field("gst_hsn_code"):
				if not frappe.db.exists("GST HSN Code", "40111010"):
					frappe.get_doc({"doctype": "GST HSN Code", "hsn_code": "40111010", "description": "Tyres"}).insert(ignore_permissions=True)
				item["gst_hsn_code"] = "40111010"
			frappe.get_doc(item).insert(ignore_permissions=True)
		frappe.local.ssv_items = None  # see the Item just created
		self.apply(batch("items", as_of_date="2026-09-26", items=[
			{"name": "TYRECO ZOOM 205-55-16", "masterId": 77, "groupPath": ["Test Brand"], "closingQty": 3, "closingValue": 0}]))
		ci = frappe.get_doc("SSV Channel Item", {"tally_item_name": "TYRECO ZOOM 205-55-16"})
		self.assertEqual((ci.mapping_status, ci.suggested_item), ("Unmapped", code))
		self.assertGreater(ci.suggestion_score, 55)
		mapping.accept_suggestions([ci.name])
		ci.reload()
		self.assertEqual((ci.mapping_status, ci.item_code, ci.suggested_item), ("Mapped", code, None))

	def test_voucher_upsert_ordering_and_tombstone(self):
		self.assertEqual(self.apply(batch("vouchers", vouchers=[voucher(alter=10, qty=10)], parties=[{"name": "Test Retailer", "gstin": "27AAAAA0000A1Z5"}]))[0], 202)
		name = frappe.db.get_value("SSV Secondary Voucher", {"tally_guid": "_test-v1"})
		self.assertEqual(frappe.get_doc("SSV Secondary Voucher", name).total_qty, 10)

		self.apply(batch("vouchers", vouchers=[voucher(alter=12, qty=7)]))  # edit
		self.apply(batch("vouchers", vouchers=[voucher(alter=11, qty=99)]))  # older copy arriving late: ignored
		self.assertEqual(frappe.get_doc("SSV Secondary Voucher", name).total_qty, 7)

		self.apply(batch("vouchers", sync_epoch=1, vouchers=[voucher(alter=3, qty=5)]))  # after a Tally restore
		self.assertEqual(frappe.get_doc("SSV Secondary Voucher", name).total_qty, 5)

		self.apply(batch("vouchers", sync_epoch=1, tombstones=[{"guid": "_test-v1", "alterId": 3, "reason": "deleted"}]))
		self.assertEqual(frappe.db.get_value("SSV Secondary Voucher", name, "is_deleted"), 1)

	def test_monthly_summary_follows_edits_moves_and_deletions(self):
		def summary(month):
			return frappe.db.get_value("SSV Monthly Summary", {"distributor": DIST, "month": month}, ["sale_qty", "sale_value"]) or (None, None)

		# Months no other test uses.
		self.apply(batch("vouchers", vouchers=[{**voucher(guid="_test-sum", alter=1, qty=10), "date": "2025-01-15"}]))
		self.assertEqual(summary("2025-01-01"), (10, 550))
		self.apply(batch("vouchers", vouchers=[{**voucher(guid="_test-sum", alter=2, qty=4), "date": "2025-01-15"}]))  # edit
		self.assertEqual(summary("2025-01-01"), (4, 220))
		self.apply(batch("vouchers", vouchers=[{**voucher(guid="_test-sum", alter=3, qty=4), "date": "2024-12-31"}]))  # re-dated
		self.assertEqual(summary("2025-01-01"), (None, None))
		self.assertEqual(summary("2024-12-01"), (4, 220))
		self.apply(batch("vouchers", tombstones=[{"guid": "_test-sum", "alterId": 4, "reason": "deleted"}]))
		self.assertEqual(summary("2024-12-01"), (None, None))

	def test_withheld_retailer_contacts_are_deleted(self):
		contact = {"name": "Contact Retailer", "gstin": "27BBBBB0000B1Z5", "phone": "98220 00000", "pincode": "440001", "address": "Shop 4"}
		v = {**voucher(guid="_test-contacts"), "partyLedger": "Contact Retailer"}
		self.apply(batch("vouchers", vouchers=[v], parties=[contact], party_contacts=True))
		ret = {"distributor": DIST, "ledger_name": "Contact Retailer"}
		self.assertEqual(frappe.db.get_value("SSV Retailer", ret, "phone"), "98220 00000")
		self.assertEqual(frappe.db.get_value("SSV Distributor", DIST, "retailer_contacts_withheld"), 0)

		# The distributor switches sharing off: this retailer is not in the batch, yet its contacts go.
		self.apply(batch("vouchers", vouchers=[{**voucher(guid="_test-contacts-2"), "partyLedger": None}], party_contacts=False))
		self.assertEqual(frappe.db.get_value("SSV Retailer", ret, ["phone", "pincode", "address", "gstin"]), (None, None, None, "27BBBBB0000B1Z5"))
		self.assertEqual(frappe.db.get_value("SSV Distributor", DIST, "retailer_contacts_withheld"), 1)

		# An older agent says nothing: the choice stands.
		self.apply(batch("vouchers", vouchers=[{**voucher(guid="_test-contacts-3"), "partyLedger": None}]))
		self.assertEqual(frappe.db.get_value("SSV Distributor", DIST, "retailer_contacts_withheld"), 1)

	def test_control_totals_reconcile(self):
		co = {"guid": "_test-company-recon", "name": "Recon Test Co"}
		self.apply({**batch("vouchers", vouchers=[{**voucher(guid="_test-rec-1", qty=10), "date": "2026-06-10"}]), "tally_company": co})
		company = frappe.db.get_value("SSV Tally Company", {"tally_company_guid": co["guid"]})
		state = lambda: frappe.db.get_value("SSV Tally Company", company, ["reconcile_status", "reconcile_problem"])

		june = {"month": "2026-06", "vouchers": 1, "qty": 10, "amount": 550}
		self.assertEqual(self.apply({**batch("control", months=[june], rejected=0), "tally_company": co})[0], 202)
		self.assertEqual(state(), ("OK", None))

		# The agent delivered a bill this site does not hold (lost batch, a row deleted by hand...).
		self.apply({**batch("control", months=[{**june, "vouchers": 2, "qty": 15, "amount": 825}]), "tally_company": co})
		status, problem = state()
		self.assertEqual(status, "Mismatch")
		self.assertIn("2026-06: agent sent 2 bills", problem)

		# A month held here that the agent no longer has, and bills this site refused.
		self.apply({**batch("control", months=[], rejected=3), "tally_company": co})
		status, problem = state()
		self.assertEqual(status, "Mismatch")
		self.assertIn("3 bill(s) were refused", problem)
		self.assertIn("this site has 1 bills", problem)

	def test_data_held_until_consent_is_recorded(self):
		frappe.db.set_single_value("SSV Settings", "hold_until_consent", 1)
		try:
			frappe.db.set_value("SSV Distributor", DIST, "data_sharing_consent_date", None)
			self.assertRaises(ingest.Deferred, self.apply, batch("vouchers", vouchers=[voucher(guid="_test-consent")]))
			self.assertFalse(frappe.db.exists("SSV Secondary Voucher", {"tally_guid": "_test-consent"}))

			frappe.db.set_value("SSV Distributor", DIST, "data_sharing_consent_date", "2026-09-29")
			self.assertEqual(self.apply(batch("vouchers", vouchers=[voucher(guid="_test-consent")]))[0], 202)
		finally:
			frappe.db.set_single_value("SSV Settings", "hold_until_consent", 0)

	def test_markup_from_a_distributor_is_neutralized(self):
		evil = "<img src=x onerror=alert(1)>"
		v = voucher(guid="_test-xss")
		v["partyLedger"] = f"Shop {evil}"
		v["lines"][0]["item"] = f"Tyre {evil}"
		self.apply(batch("vouchers", vouchers=[v], parties=[{"name": f"Shop {evil}", "address": evil}]))
		item = frappe.db.get_value("SSV Channel Item", {"tally_item_name": ["like", "Tyre %"]}, "tally_item_name")
		shop = frappe.db.get_value("SSV Retailer", {"ledger_name": ["like", "Shop %"]}, ["ledger_name", "address"])
		for text in (item, *shop):
			self.assertNotIn("<", text)
			self.assertIn("&lt;img", text)

		ingest.apply_heartbeat(DIST, {"distributor_id": DIST, "agent_version": "<b>9</b>", "run": {"ok": False, "problem": "<script>x</script>"}})
		self.assertEqual(frappe.db.get_value("SSV Distributor", DIST, ["agent_version", "last_run_problem"]),
			("&lt;b&gt;9&lt;/b&gt;", "&lt;script&gt;x&lt;/script&gt;"))

	def test_delete_channel_data_when_consent_ends(self):
		other = "_TEST-DIST-DEL"
		if not frappe.db.exists("SSV Distributor", other):
			frappe.get_doc({"doctype": "SSV Distributor", "distributor_id": other, "distributor_name": "Leaving Distributor",
				"enabled": 1, "agent_secret": "old-secret"}).insert(ignore_permissions=True)
		co = {"guid": "_test-company-del", "name": "Leaving Co"}
		ingest.apply_batch(other, {**batch("vouchers", vouchers=[voucher(guid="_test-del-1")], parties=[{"name": "Test Retailer"}]),
			"distributor_id": other, "tally_company": co})
		ingest.apply_batch(other, {**batch("items", as_of_date="2026-09-20",
			items=[{"name": "Test Toothpaste 100g", "masterId": 7, "closingQty": 5, "closingValue": 250,
				"godowns": [{"godown": "Main", "qty": 5, "value": 250}]}]),
			"distributor_id": other, "tally_company": co})
		self.apply(batch("vouchers", vouchers=[voucher(guid="_test-keep")]))  # another distributor's data must stay

		doc = frappe.get_doc("SSV Distributor", other)
		self.assertRaises(frappe.ValidationError, doc.delete_channel_data, other)  # still enabled
		doc.enabled = 0
		doc.save()
		self.assertRaises(frappe.ValidationError, doc.delete_channel_data, "wrong id")

		counts = doc.delete_channel_data(other)
		self.assertEqual(counts["SSV Secondary Voucher"], 1)
		self.assertGreaterEqual(counts["SSV Stock Snapshot"], 1)
		for dt in ("SSV Secondary Voucher", "SSV Stock Snapshot", "SSV Channel Item", "SSV Retailer", "SSV Tally Company", "SSV Ingest Log"):
			self.assertFalse(frappe.db.count(dt, {"distributor": other}), dt)
		self.assertFalse(frappe.db.sql("""select count(*) from `tabSSV Secondary Voucher Item` i
			left join `tabSSV Secondary Voucher` v on v.name = i.parent where v.name is null""")[0][0], "no orphaned lines")
		self.assertFalse(frappe.db.sql("""select count(*) from `tabSSV Stock Snapshot Godown` g
			left join `tabSSV Stock Snapshot` s on s.name = g.parent where s.name is null""")[0][0], "no orphaned godown rows")
		self.assertTrue(frappe.db.exists("SSV Secondary Voucher", {"tally_guid": "_test-keep"}))
		self.assertNotEqual(doc.get_password("agent_secret"), "old-secret")
		self.assertTrue(frappe.db.exists("Comment", {"reference_doctype": "SSV Distributor", "reference_name": other,
			"content": ["like", "Channel data deleted%"]}))

	def test_create_items_from_tally_names(self):
		from ssv_channel import mapping

		tyre = {"name": "_Test Zoom 145/80 R12", "masterId": 91, "groupPath": ["_Test Tyres Top", "_Test Car Tyres"], "unit": "Nos",
			"hsnCode": "40111010", "closingQty": 1, "closingValue": 10}
		for guid in ("_test-company-cat-a", "_test-company-cat-b"):  # the same item from two senders
			self.apply({**batch("items", as_of_date="2026-09-20", items=[tyre]), "tally_company": {"guid": guid, "name": guid}})
		names = frappe.get_all("SSV Channel Item", filters={"tally_item_name": tyre["name"]}, pluck="name")
		self.assertEqual(len(names), 2)

		result = mapping.create_items([names[0]])
		self.assertEqual(result, {"created": 1, "mapped": 2, "skipped": []})
		self.assertEqual(frappe.db.get_value("Item", tyre["name"], ["item_group", "stock_uom"]), ("_Test Car Tyres", "Nos"))
		self.assertEqual(frappe.db.get_value("Item Group", "_Test Car Tyres", "parent_item_group"), "_Test Tyres Top")
		for n in names:
			self.assertEqual(frappe.db.get_value("SSV Channel Item", n, ["item_code", "mapping_status"]), (tyre["name"], "Mapped"))
		self.assertEqual(mapping.create_items([names[1]])["mapped"], 0, "already mapped: nothing to do")

		# Without an HSN code, a GST site refuses the Item: it is reported, not an error.
		bare = {**tyre, "name": "_Test No HSN Tyre", "masterId": 92, "hsnCode": None}
		self.apply({**batch("items", as_of_date="2026-09-20", items=[bare]), "tally_company": {"guid": "_test-company-cat-a", "name": "a"}})
		n = frappe.db.get_value("SSV Channel Item", {"tally_item_name": bare["name"]})
		result = mapping.create_items([n])
		if frappe.get_meta("Item").has_field("gst_hsn_code"):
			self.assertEqual((result["created"], len(result["skipped"])), (0, 1))
			self.assertIn("_Test No HSN Tyre", result["skipped"][0])
		else:
			self.assertEqual(result["created"], 1)

	def test_duplicate_batch_is_409(self):
		b = batch("vouchers", vouchers=[voucher(guid="_test-dup")])
		self.assertEqual(self.apply(b)[0], 202)
		self.assertEqual(self.apply(b)[0], 409)

	def test_wrong_principal_is_refused(self):
		b = batch("vouchers", vouchers=[voucher(guid="_test-other")])
		b["principal"] = "SOMEONE_ELSE"
		self.assertRaises(ingest.Refused, self.apply, b)
