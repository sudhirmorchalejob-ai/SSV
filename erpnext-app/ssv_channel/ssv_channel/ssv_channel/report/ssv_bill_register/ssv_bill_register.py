# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Bill-level register (deck slide 32): every line of every synced voucher in
the period — distributor, date, document number, retailer, item, quantity,
value. Deleted and cancelled vouchers are excluded.
"""

import frappe
from frappe import _

from ssv_channel import data as D


def execute(filters=None):
	f = D.resolve_period(filters)
	types = [f.base_type] if f.get("base_type") and f.base_type != "All" else None
	lines, _dist = D.voucher_lines(f, f.from_date, f.to_date, base_types=types)
	lines = [ln for ln in lines if D.item_filter_ok(ln, f)]
	if f.get("retailer"):
		lines = [ln for ln in lines if ln.retailer == f.retailer]
	lines.sort(key=lambda r: (str(r.voucher_date), r.distributor_name or "", r.voucher_number or "", r.item or ""))

	columns = [
		{"fieldname": "distributor_name", "label": _("Distributor"), "fieldtype": "Data", "width": 190},
		{"fieldname": "voucher_date", "label": _("Date"), "fieldtype": "Date", "width": 100},
		{"fieldname": "base_type", "label": _("Type"), "fieldtype": "Data", "width": 100},
		{"fieldname": "voucher", "label": _("Document"), "fieldtype": "Link", "options": "SSV Secondary Voucher", "width": 110},
		{"fieldname": "voucher_number", "label": _("Document Number"), "fieldtype": "Data", "width": 150},
		{"fieldname": "retailer_name", "label": _("Retailer"), "fieldtype": "Data", "width": 180},
		{"fieldname": "item_code", "label": _("Item"), "fieldtype": "Link", "options": "Item", "width": 130},
		{"fieldname": "tally_item_name", "label": _("Item in Tally"), "fieldtype": "Data", "width": 200},
		{"fieldname": "direction", "label": _("In/Out"), "fieldtype": "Data", "width": 60},
		{"fieldname": "qty", "label": _("Item Quantity"), "fieldtype": "Float", "width": 110},
		{"fieldname": "amount", "label": _("Item Value"), "fieldtype": "Currency", "width": 120},
		{"fieldname": "godown", "label": _("Godown"), "fieldtype": "Data", "width": 110},
	]
	if lines:
		# The deck's Total row. With every voucher type shown it mixes sales and purchases;
		# pick a Voucher Type for a meaningful total.
		lines.insert(0, {"distributor_name": _("Total"), "is_total": 1,
			"qty": sum(float(ln.qty or 0) for ln in lines), "amount": sum(float(ln.amount or 0) for ln in lines)})
	return columns, lines
