# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class SSVMonthlySummary(Document):
	pass


def on_doctype_update():
	frappe.db.add_index("SSV Monthly Summary", ["distributor", "month"])
