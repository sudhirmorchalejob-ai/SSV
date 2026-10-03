# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class SSVSecondaryVoucher(Document):
	pass


def on_doctype_update():
	# Reports select by distributor and date; ingest finds a voucher by company and Tally GUID.
	frappe.db.add_index("SSV Secondary Voucher", ["distributor", "voucher_date"])
	frappe.db.add_index("SSV Secondary Voucher", ["tally_company", "tally_guid"])
