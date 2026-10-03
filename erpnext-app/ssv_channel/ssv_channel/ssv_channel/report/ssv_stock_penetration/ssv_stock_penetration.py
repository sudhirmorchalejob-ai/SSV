# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Stock penetration (deck slides 30–31): per distributor, product class, brand
and item, how many distinct outlets were billed, and the billed quantity and
value. Outlets are counted, not summed, at every level. Sales only.
"""

from collections import defaultdict

import frappe
from frappe import _

from ssv_channel import analytics as A
from ssv_channel import charts as C
from ssv_channel import data as D

DIMS = ["distributor_name", "product_class", "brand", "item"]


def execute(filters=None):
	f = D.resolve_period(filters or {"period": "Current Week"})
	lines, _dist = D.voucher_lines(f, f.from_date, f.to_date, base_types=["Sales"])
	lines = [ln for ln in lines if ln.direction == "out" and D.item_filter_ok(ln, f)]

	# Deck slide 30: billed value and quantity in total, then month by month.
	months = [m for _k, m in sorted({(ln.month_key, ln.month) for ln in lines})]
	spread = A.spread(lines, "month", ["sale_value", "sale_qty"])
	month_keys = [f"{m}::{k}" for m in months for k in ("sale_value", "sale_qty")]
	data = A.tree(spread, DIMS, ["sale_qty", "sale_value"] + month_keys)

	outlets = defaultdict(set)
	for ln in lines:
		path = None
		for dim in DIMS:
			key = ln.get(dim) if ln.get(dim) not in (None, "") else "(not set)"
			path = f"{path}/{key}" if path else str(key)
			if ln.retailer:
				outlets[path].add(ln.retailer)
	for r in data:
		r["outlets"] = len(outlets.get(r["id"], ()))
	if data:
		total = A.grand_total(data, ["sale_qty", "sale_value"] + month_keys)
		total["outlets"] = len({ln.retailer for ln in lines if ln.retailer})  # distinct, never summed
		data.insert(0, total)

	columns = [
		{"fieldname": "label", "label": _("Distributor > Product Class > Brand > Item"), "fieldtype": "Data", "width": 340},
		{"fieldname": "outlets", "label": _("Outlets Billed"), "fieldtype": "Int", "width": 120},
		{"fieldname": "sale_value", "label": _("Billed Value"), "fieldtype": "Currency", "width": 140},
		{"fieldname": "sale_qty", "label": _("Billed Qty"), "fieldtype": "Float", "width": 120},
	]
	if len(months) > 1 or (months and f.get("show_months")):
		for m in months:
			columns.append({"fieldname": f"{m}::sale_value", "label": f"{m} · {_('Billed Value')}", "fieldtype": "Currency", "width": 140})
			columns.append({"fieldname": f"{m}::sale_qty", "label": f"{m} · {_('Billed Qty')}", "fieldtype": "Float", "width": 110})
	return columns, data, None, C.bars(C.level(data), [("outlets", _("Outlets Billed"))])
