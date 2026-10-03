# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class SSVStockSnapshot(Document):
	pass


def on_doctype_update():
	frappe.db.add_index("SSV Stock Snapshot", ["distributor", "channel_item", "as_of_date"])
