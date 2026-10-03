# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""Retailer layer (0.8.0). Run on the bench:  bench --site <site> run-tests --app ssv_channel --module ssv_channel.tests.test_retailers"""

import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, today

from ssv_channel import ingest, retailers
from ssv_channel.patches.v0_8 import retailer_ids

PRINCIPAL = "_TESTP"
USER = "ssv-retailer-test@example.com"


def uid(prefix=""):
	return f"{prefix}{uuid.uuid4().hex[:10]}"


def make_distributor(name=None):
	name = name or uid("_TRD-")
	frappe.get_doc({
		"doctype": "SSV Distributor", "distributor_id": name, "distributor_name": f"Distributor {name}",
		"enabled": 1, "agent_secret": uid(), "rules": [{"rule_type": "Stock Group", "tally_value": "Ceat Tyre"}],
	}).insert(ignore_permissions=True)
	return name


def bill(party, days_ago=5, vtype="Sales", qty=10, rate=100, cancelled=False, guid=None, alter=10, item="Ceat Milaze 145/80 R12"):
	direction = "in" if vtype in ("Credit Note", "Purchase") else "out"
	guid = guid or uid("v-")
	return {
		"guid": guid, "masterId": 1, "alterId": alter, "date": add_days(today(), -days_ago),
		"voucherType": vtype, "baseType": vtype, "voucherNumber": guid, "partyLedger": party, "isCancelled": cancelled,
		"lines": [{
			"item": item, "direction": direction, "qty": qty, "billedQty": qty, "unit": "Nos", "rate": rate,
			"amount": qty * rate, "discountPct": 0,
			"allocations": [{"godown": "Main", "batch": None, "qty": qty, "billedQty": qty, "amount": qty * rate}],
		}],
	}


def send(distributor, company_guid, vouchers=(), parties=(), tombstones=()):
	status, result = ingest.apply_batch(distributor, {
		"batch_id": uid(), "schema": 2, "kind": "vouchers", "principal": PRINCIPAL, "distributor_id": distributor,
		"tally_company": {"guid": company_guid, "name": f"{distributor} (Distributor)"}, "sync_epoch": 0,
		"agent_version": "test", "vouchers": list(vouchers), "parties": list(parties), "tombstones": list(tombstones),
	})
	assert status == 202, result
	return result


def retailer(distributor, ledger_name):
	return frappe.get_doc("SSV Retailer", {"distributor": distributor, "ledger_name": ledger_name})


def by_name(rows):
	return {r.ledger_name: r for r in rows}


class TestRetailers(FrappeTestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.set_single_value("SSV Settings", {"principal_code": PRINCIPAL, "clock_skew_seconds": 300, "hold_until_consent": 0})

	def tearDown(self):
		frappe.set_user("Administrator")

	# ── master record ───────────────────────────────────────────────────────

	def test_retailer_from_tally_gets_id_and_defaults(self):
		d = make_distributor()
		send(d, uid("co-"), [bill("Alpha Tyres")], parties=[{"name": "Alpha Tyres", "guid": "g-alpha", "group": "Sundry Debtors", "state": "Maharashtra"}])
		r = retailer(d, "Alpha Tyres")
		self.assertTrue(r.retailer_id.startswith("RET-"))
		self.assertEqual((r.source, r.status, r.manufacturer, r.state), ("Tally", "Active", PRINCIPAL, "Maharashtra"))
		self.assertEqual(r.distributor_name, f"Distributor {d}")
		self.assertTrue(r.tally_company)

	def test_hand_added_retailer_is_adopted_by_its_first_bill(self):
		d = make_distributor()  # its agent has not sent anything yet: no Tally company known
		doc = frappe.get_doc({"doctype": "SSV Retailer", "distributor": d, "ledger_name": " Beta Wheels ",
			"contact_person": "Ravi", "mobile": "+91-9800000000", "city": "Nagpur", "zone": "Central"}).insert()
		self.assertEqual((doc.ledger_name, doc.source, doc.tally_company), ("Beta Wheels", "Manual", None))

		send(d, uid("co-"), [bill("Beta Wheels")], parties=[{"name": "Beta Wheels", "guid": "g-beta", "phone": "999", "state": "Maharashtra"}])
		self.assertEqual(frappe.db.count("SSV Retailer", {"distributor": d, "ledger_name": "Beta Wheels"}), 1)
		doc.reload()
		self.assertTrue(doc.tally_company)
		self.assertEqual((doc.tally_guid, doc.phone, doc.state), ("g-beta", "999", "Maharashtra"))
		# What people typed in is never touched by the sync.
		self.assertEqual((doc.contact_person, doc.mobile, doc.city, doc.zone), ("Ravi", "+91-9800000000", "Nagpur", "Central"))
		voucher_retailer = frappe.db.get_value("SSV Secondary Voucher", {"distributor": d, "party_ledger": "Beta Wheels"}, "retailer")
		self.assertEqual(voucher_retailer, doc.name)

		company = doc.tally_company
		send(d, frappe.db.get_value("SSV Tally Company", company, "tally_company_guid"),
			parties=[{"name": "Beta Wheels", "guid": "g-beta", "phone": "888"}])
		doc.reload()
		self.assertEqual((doc.phone, doc.contact_person, doc.city), ("888", "Ravi", "Nagpur"))

	def test_hand_added_retailer_takes_the_only_tally_company(self):
		d = make_distributor()
		co = uid("co-")
		send(d, co, [bill("Existing Party")])
		doc = frappe.get_doc({"doctype": "SSV Retailer", "distributor": d, "ledger_name": "Gamma Auto"}).insert()
		self.assertEqual(frappe.db.get_value("SSV Tally Company", doc.tally_company, "distributor"), d)
		send(d, co, [bill("Gamma Auto")])
		self.assertEqual(frappe.db.count("SSV Retailer", {"distributor": d, "ledger_name": "Gamma Auto"}), 1)

	def test_duplicate_retailer_is_refused(self):
		d = make_distributor()
		frappe.get_doc({"doctype": "SSV Retailer", "distributor": d, "ledger_name": "Delta Tyres"}).insert()
		with self.assertRaises(frappe.DuplicateEntryError):
			frappe.get_doc({"doctype": "SSV Retailer", "distributor": d, "ledger_name": "Delta Tyres"}).insert()
		# The same ledger name under another distributor is a different retailer.
		frappe.get_doc({"doctype": "SSV Retailer", "distributor": make_distributor(), "ledger_name": "Delta Tyres"}).insert()

	def test_retailer_stays_under_one_distributor(self):
		a, b = make_distributor(), make_distributor()
		send(a, uid("co-"), [bill("Epsilon Tyres")])
		r = retailer(a, "Epsilon Tyres")
		with self.assertRaises(frappe.ValidationError):  # another distributor's Tally company
			frappe.get_doc({"doctype": "SSV Retailer", "distributor": b, "ledger_name": "Zeta", "tally_company": r.tally_company}).insert()
		r.distributor = b
		with self.assertRaises(frappe.ValidationError):  # set once; its Tally company is also a's
			r.save()
		self.assertEqual(frappe.db.get_value("SSV Retailer", r.name, "distributor"), a)

	def test_deactivate_and_delete(self):
		d = make_distributor()
		send(d, uid("co-"), [bill("Eta Tyres")])
		r = retailer(d, "Eta Tyres")
		r.status = "Inactive"
		r.save()
		self.assertEqual(frappe.db.get_value("SSV Retailer", r.name, "status"), "Inactive")
		with self.assertRaises(frappe.LinkExistsError):  # it has bills
			frappe.delete_doc("SSV Retailer", r.name)
		spare = frappe.get_doc({"doctype": "SSV Retailer", "distributor": d, "ledger_name": "Theta (never billed)"}).insert()
		frappe.delete_doc("SSV Retailer", spare.name)
		self.assertFalse(frappe.db.exists("SSV Retailer", spare.name))

	def test_patch_gives_older_retailers_an_id(self):
		d = make_distributor()
		send(d, uid("co-"), [bill("Iota Tyres")])
		name = retailer(d, "Iota Tyres").name
		frappe.db.set_value("SSV Retailer", name, {"retailer_id": None, "source": None, "manufacturer": None})
		retailer_ids.execute()
		row = frappe.db.get_value("SSV Retailer", name, ["retailer_id", "source", "status", "manufacturer"], as_dict=True)
		self.assertTrue(row.retailer_id.startswith("RET-"))
		self.assertEqual((row.source, row.status, row.manufacturer), ("Tally", "Active", PRINCIPAL))
		retailer_ids.execute()  # rerun: nothing changes
		self.assertEqual(frappe.db.get_value("SSV Retailer", name, "retailer_id"), row.retailer_id)

	# ── activity ────────────────────────────────────────────────────────────

	def test_activity_figures(self):
		d = make_distributor()
		co = uid("co-")
		gone = bill("Kappa Tyres", days_ago=1, qty=50)
		send(d, co, [
			bill("Kappa Tyres", days_ago=30, qty=10),
			bill("Kappa Tyres", days_ago=20, qty=5, cancelled=True),
			bill("Kappa Tyres", days_ago=10, vtype="Credit Note", qty=2),
			gone,
			bill("CEAT Ltd", days_ago=15, vtype="Purchase", qty=100),
		])
		send(d, co, tombstones=[{"guid": gone["guid"], "alterId": 11}])

		rows = by_name(retailers.build_rows({"distributor": d}))
		self.assertEqual(set(rows), {"Kappa Tyres"})  # the supplier on the purchase bill is not a retailer
		k = rows["Kappa Tyres"]
		self.assertEqual((k.transactions, k.bills, k.returns, k.cancelled, k.active, k.item_count), (3, 2, 1, 1, 2, 1))
		self.assertEqual((k.net_qty, k.net_value), (8, 800))
		self.assertEqual(str(k.last_activity), add_days(today(), -10))
		self.assertEqual(k.sync_status, "OK")

		recent = by_name(retailers.build_rows({"distributor": d, "from_date": add_days(today(), -25)}))["Kappa Tyres"]
		self.assertEqual((recent.transactions, recent.net_qty), (2, -2))

		a = retailers.retailer_activity(retailer(d, "Kappa Tyres").name)
		self.assertEqual((a["transactions"], a["net_value"], len(a["recent"])), (3, 800, 3))

	def test_distributor_section_shows_only_its_retailers(self):
		a, b = make_distributor(), make_distributor()
		send(a, uid("co-"), [bill("Lambda Tyres"), bill("Shared Name Tyres"), bill("Shared Name Tyres")])
		send(b, uid("co-"), [bill("Shared Name Tyres"), bill("Mu Wheels")])
		out = retailers.distributor_retailers(a)
		self.assertEqual({r.ledger_name for r in out["retailers"]}, {"Lambda Tyres", "Shared Name Tyres"})
		self.assertTrue(all(r.distributor == a for r in out["retailers"]))
		s = out["summary"]
		self.assertEqual((s["total"], s["active"], s["inactive"], s["transactions"]), (2, 2, 0, 3))
		self.assertEqual(by_name(out["retailers"])["Shared Name Tyres"].transactions, 2)

	def test_filters(self):
		d = make_distributor()
		send(d, uid("co-"), [bill("Nu Tyres", days_ago=3), bill("Xi Auto", days_ago=100), bill("Omicron Tyres", days_ago=2)])
		nu, xi, om = (retailer(d, n) for n in ("Nu Tyres", "Xi Auto", "Omicron Tyres"))
		nu.city, nu.zone = "Nagpur", "Central"
		nu.save()
		om.status = "Inactive"
		om.save()

		names = lambda **f: {r.ledger_name for r in retailers.build_rows({"distributor": d, **f})}
		self.assertEqual(names(), {"Nu Tyres", "Xi Auto", "Omicron Tyres"})
		self.assertEqual(names(status="Inactive"), {"Omicron Tyres"})
		self.assertEqual(names(city="nagp"), {"Nu Tyres"})
		self.assertEqual(names(zone="Central"), {"Nu Tyres"})
		self.assertEqual(names(retailer=xi.retailer_id), {"Xi Auto"})
		self.assertEqual(names(retailer="tyres"), {"Nu Tyres", "Omicron Tyres"})
		self.assertEqual(names(manufacturer=PRINCIPAL), {"Nu Tyres", "Xi Auto", "Omicron Tyres"})
		self.assertEqual(names(no_activity_days=30), {"Xi Auto"})  # active, no bill for 30 days

	def test_dashboard_counts(self):
		d = make_distributor()
		send(d, uid("co-"), [bill("Pi Tyres", days_ago=3), bill("Pi Tyres", days_ago=4), bill("Rho Auto", days_ago=90)])
		frappe.get_doc({"doctype": "SSV Retailer", "distributor": d, "ledger_name": "Sigma (added by hand)", "city": "Pune"}).insert()
		out = retailers.dashboard_data({"distributor": d, "no_activity_days": 60})
		t = out["totals"]
		self.assertEqual((t["total"], t["active"], t["inactive"], t["billed"], t["transactions"]), (3, 3, 0, 2, 3))
		self.assertEqual(t["quiet"], 2)  # Rho (90 days) and Sigma (never billed)
		self.assertEqual({q["ledger_name"] for q in out["quiet"]}, {"Rho Auto", "Sigma (added by hand)"})
		self.assertEqual(sum(out["by_distributor"]["values"]), 3)
		self.assertEqual(sum(out["monthly"]["bills"]), 3)
		self.assertEqual([s["distributor"] for s in out["sync"]], [d])
		self.assertEqual(out["busiest"]["labels"][0], "Pi Tyres")

	# ── permissions ─────────────────────────────────────────────────────────

	def test_permissions(self):
		a, b = make_distributor(), make_distributor()
		send(a, uid("co-"), [bill("Tau Tyres")])
		send(b, uid("co-"), [bill("Upsilon Tyres")])
		other = retailer(b, "Upsilon Tyres").name

		if not frappe.db.exists("User", USER):
			frappe.get_doc({"doctype": "User", "email": USER, "first_name": "SSV Retailer Test", "send_welcome_email": 0}).insert(ignore_permissions=True)
		user = frappe.get_doc("User", USER)

		user.remove_roles("Sales User")
		frappe.set_user(USER)
		with self.assertRaises(frappe.PermissionError):  # no SSV role at all
			retailers.get_retailers({})
		frappe.set_user("Administrator")

		user.add_roles("Sales User")
		frappe.get_doc({"doctype": "User Permission", "user": USER, "allow": "SSV Distributor", "for_value": a,
			"apply_to_all_doctypes": 1}).insert(ignore_permissions=True)
		frappe.set_user(USER)
		seen = {r.distributor for r in retailers.get_retailers({})}
		self.assertEqual(seen, {a})
		self.assertEqual({r.ledger_name for r in retailers.distributor_retailers(a)["retailers"]}, {"Tau Tyres"})
		with self.assertRaises(frappe.PermissionError):
			retailers.distributor_retailers(b)
		with self.assertRaises(frappe.PermissionError):
			retailers.retailer_activity(other)
		self.assertEqual({s["distributor"] for s in retailers.dashboard_data({})["sync"]}, {a})
		with self.assertRaises(frappe.PermissionError):  # Sales User may read, not create
			frappe.get_doc({"doctype": "SSV Retailer", "distributor": a, "ledger_name": "Phi"}).insert()
