# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
A distributor's retailer: a party ledger in the distributor's Tally.

Most arrive with their first bill (ingest.upsert_retailer, Added From = Tally). One can
also be added by hand before that, under its exact Tally ledger name; the first bill
then links to the same record instead of creating a second one.

The Tally fields (name, GSTIN, address, state, PIN code, phone, price level) are
rewritten on every sync once Tally has sent the retailer. The fields people fill in
here (Retailer ID, status, contact person, mobile, email, city, zone, consent) are
never written by the sync.
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.naming import make_autoname
from frappe.utils import today

RETAILER_ID_SERIES = "RET-.#####"


def next_retailer_id() -> str:
	return make_autoname(RETAILER_ID_SERIES)


class SSVRetailer(Document):
	def before_insert(self):
		if not self.retailer_id:
			self.retailer_id = next_retailer_id()

	def validate(self):
		self.ledger_name = (self.ledger_name or "").strip()
		if not self.ledger_name:
			frappe.throw(_("Retailer Name is required."))
		self.status = self.status or "Active"
		if not self.manufacturer:
			self.manufacturer = frappe.db.get_single_value("SSV Settings", "principal_code")
		self.set_tally_company()
		self.check_duplicate()
		if self.data_sharing_consent and not self.consent_date:
			self.consent_date = today()

	def set_tally_company(self):
		"""The retailer must sit under one distributor: its Tally company has to be that distributor's."""
		if self.tally_company:
			owner = frappe.db.get_value("SSV Tally Company", self.tally_company, "distributor")
			if owner != self.distributor:
				frappe.throw(_("Tally Company {0} belongs to distributor {1}, not {2}.").format(
					self.tally_company, owner, self.distributor))
			return
		companies = frappe.get_all("SSV Tally Company", filters={"distributor": self.distributor}, pluck="name")
		if len(companies) == 1:
			self.tally_company = companies[0]

	def check_duplicate(self):
		"""One record per ledger: same distributor and name, in the same (or a not yet known) Tally company."""
		rows = frappe.get_all(
			"SSV Retailer",
			filters={"distributor": self.distributor, "ledger_name": self.ledger_name, "name": ["!=", self.name or ""]},
			fields=["name", "retailer_id", "tally_company"],
		)
		for r in rows:
			if not r.tally_company or not self.tally_company or r.tally_company == self.tally_company:
				frappe.throw(_("{0} is already recorded for this distributor as {1}.").format(
					frappe.bold(self.ledger_name), r.retailer_id or r.name), frappe.DuplicateEntryError)
