# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class SSVChannelItem(Document):
	def validate(self):
		# Setting the Item maps it; clearing it un-maps it. "Ignored" stays as the user set it.
		if self.item_code and self.mapping_status == "Unmapped":
			self.mapping_status = "Mapped"
		elif not self.item_code and self.mapping_status == "Mapped":
			self.mapping_status = "Unmapped"
		if self.mapping_status != "Unmapped":
			self.suggested_item, self.suggestion_score = None, 0
		if self.conversion_factor is not None and self.conversion_factor <= 0:
			frappe.throw(_("Conversion Factor must be above 0 (1 when both count the same unit)."))
