# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Every retailer the user may see, with its distributor, its bills and its last activity:
the Retailers / Dealers list of the SSV Channel. Search by Retailer ID or name; filter by
distributor, manufacturer, place and status. From/To Date limit the bill figures only.
"No Bills For (Days)" keeps active retailers without a bill in that many days.
"""

from frappe import _

from ssv_channel import retailers as R


def execute(filters=None):
	rows = R.build_rows(filters)
	columns = [
		{"fieldname": "retailer_id", "label": _("Retailer ID"), "fieldtype": "Data", "width": 110},
		{"fieldname": "ledger_name", "label": _("Retailer Name"), "fieldtype": "Data", "width": 200},
		{"fieldname": "distributor", "label": _("Distributor"), "fieldtype": "Link", "options": "SSV Distributor", "width": 100},
		{"fieldname": "distributor_name", "label": _("Distributor Name"), "fieldtype": "Data", "width": 170},
		{"fieldname": "manufacturer", "label": _("Manufacturer"), "fieldtype": "Data", "width": 100},
		{"fieldname": "city", "label": _("City"), "fieldtype": "Data", "width": 100},
		{"fieldname": "state", "label": _("State"), "fieldtype": "Data", "width": 110},
		{"fieldname": "zone", "label": _("Zone"), "fieldtype": "Data", "width": 90},
		{"fieldname": "status", "label": _("Status"), "fieldtype": "Data", "width": 80},
		{"fieldname": "transactions", "label": _("Transactions"), "fieldtype": "Int", "width": 100},
		{"fieldname": "bills", "label": _("Bills"), "fieldtype": "Int", "width": 70},
		{"fieldname": "cancelled", "label": _("Cancelled"), "fieldtype": "Int", "width": 80},
		{"fieldname": "item_count", "label": _("Items"), "fieldtype": "Int", "width": 60},
		{"fieldname": "net_qty", "label": _("Net Qty"), "fieldtype": "Float", "width": 90},
		{"fieldname": "net_value", "label": _("Net Sales Value"), "fieldtype": "Currency", "width": 130},
		{"fieldname": "last_activity", "label": _("Last Activity"), "fieldtype": "Date", "width": 100},
		{"fieldname": "last_sync", "label": _("Last Sync"), "fieldtype": "Datetime", "width": 150},
		{"fieldname": "sync_status", "label": _("Data Status"), "fieldtype": "Data", "width": 90},
		{"fieldname": "contact_person", "label": _("Contact Person"), "fieldtype": "Data", "width": 130},
		{"fieldname": "mobile", "label": _("Mobile"), "fieldtype": "Data", "width": 110},
		{"fieldname": "gstin", "label": _("GST Number"), "fieldtype": "Data", "width": 140},
		{"fieldname": "source", "label": _("Added From"), "fieldtype": "Data", "width": 80},
		{"fieldname": "creation", "label": _("Created"), "fieldtype": "Datetime", "width": 150},
		{"fieldname": "modified", "label": _("Updated"), "fieldtype": "Datetime", "width": 150},
	]
	active = sum(r.status == "Active" for r in rows)
	summary = [
		{"label": _("Retailers"), "value": len(rows), "indicator": "Blue", "datatype": "Int"},
		{"label": _("Active"), "value": active, "indicator": "Green", "datatype": "Int"},
		{"label": _("Inactive"), "value": len(rows) - active, "indicator": "Grey", "datatype": "Int"},
		{"label": _("Transactions"), "value": sum(r.transactions for r in rows), "indicator": "Blue", "datatype": "Int"},
	]
	return columns, rows, None, None, summary
