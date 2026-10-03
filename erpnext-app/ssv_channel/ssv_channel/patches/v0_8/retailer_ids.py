# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""Retailers received before 0.8.0: a Retailer ID in the order they arrived, Active, from Tally,
this site's principal as manufacturer, and the distributor's name. Only empty fields are filled,
so it is safe to rerun."""

import frappe

from ssv_channel.ssv_channel.doctype.ssv_retailer.ssv_retailer import next_retailer_id


def execute():
	principal = frappe.db.get_single_value("SSV Settings", "principal_code")
	names = dict(frappe.get_all("SSV Distributor", fields=["name", "distributor_name"], as_list=True))
	rows = frappe.get_all(
		"SSV Retailer",
		filters={"retailer_id": ["is", "not set"]},
		fields=["name", "distributor", "status", "source", "manufacturer"],
		order_by="creation asc, name asc",
	)
	for r in rows:
		frappe.db.set_value(
			"SSV Retailer",
			r.name,
			{
				"retailer_id": next_retailer_id(),
				"status": r.status or "Active",
				# Before 0.8.0 retailers could only come from Tally.
				"source": "Tally",
				"manufacturer": r.manufacturer or principal,
				"distributor_name": names.get(r.distributor),
			},
			update_modified=False,
		)
