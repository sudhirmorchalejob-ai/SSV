# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Retailer performance per distributor (deck slide 27): rate, quantity and value
billed to each retailer, item by item, net of returns.

Cost and margin are shown only when SSV Settings → Show Cost And Margin is on
AND the distributor has Shares Cost Price ticked. Cost is estimated inside
ERPNext as quantity × the distributor's valuation rate from the nearest stock
snapshot; no extra data is taken from the distributor's Tally for it.
"""

import frappe
from frappe import _

from ssv_channel import analytics as A
from ssv_channel import charts as C
from ssv_channel import data as D

DIMS = ["distributor_name", "retailer_name", "item"]


def execute(filters=None):
	f = D.resolve_period(filters)
	lines, dist = D.voucher_lines(f, f.from_date, f.to_date, base_types=["Sales", "Credit Note"])
	lines = [ln for ln in lines if D.item_filter_ok(ln, f) and (ln.net_qty or ln.net_value)]
	if f.get("retailer"):
		lines = [ln for ln in lines if ln.retailer == f.retailer]

	allowed = {name for name, d in dist.items() if D.margin_allowed(d)}
	show_margin = bool(allowed)
	if show_margin:
		book, _ci = D.stock_book(list(allowed), at_dates=[])  # rates come from snapshots alone
		for ln in lines:
			if ln.distributor in allowed:
				ln["cost_value"] = ln.net_qty * book.rate_at((ln.distributor, ln.channel_item), ln.voucher_date)

	sums = ["net_qty", "net_value"] + (["cost_value"] if show_margin else [])
	data = A.tree(lines, DIMS, sums)
	if data:
		data.insert(0, A.grand_total(data, sums))
	with_cost = {dist[d].distributor_name for d in allowed}
	for r in data:
		qty = r.get("net_qty") or 0
		r["rate"] = (r.get("net_value") or 0) / qty if qty else None
		if show_margin:
			if r.get("is_total"):
				# Margin in the total only when every distributor in it shares cost.
				has_cost = all(t["label"] in with_cost for t in data if t.get("indent") == 0 and not t.get("is_total"))
			else:
				has_cost = r["id"].split("/")[0] in with_cost
			if has_cost:
				r["cost_rate"] = (r.get("cost_value") or 0) / qty if qty else None
				r["margin"] = (r.get("net_value") or 0) - (r.get("cost_value") or 0)
				r["margin_pct"] = round(100 * r["margin"] / r["net_value"], 2) if r.get("net_value") else None
			else:
				r["cost_value"] = None

	columns = [
		{"fieldname": "label", "label": _("Distributor > Retailer > Item"), "fieldtype": "Data", "width": 340},
		{"fieldname": "rate", "label": _("Rate"), "fieldtype": "Currency", "width": 110},
		{"fieldname": "net_qty", "label": _("Item Qty"), "fieldtype": "Float", "width": 110},
		{"fieldname": "net_value", "label": _("Item Value"), "fieldtype": "Currency", "width": 130},
	]
	if show_margin:
		columns += [
			{"fieldname": "cost_rate", "label": _("Cost Price"), "fieldtype": "Currency", "width": 110},
			{"fieldname": "cost_value", "label": _("Cost Value"), "fieldtype": "Currency", "width": 130},
			{"fieldname": "margin", "label": _("Margin"), "fieldtype": "Currency", "width": 120},
			{"fieldname": "margin_pct", "label": _("Margin %"), "fieldtype": "Percent", "width": 90},
		]
	# Top retailers by value (the retailer level of the tree).
	chart = C.bars(C.level(data, 1), [("net_value", _("Item Value"))], limit=10, fieldtype="Currency")
	return columns, data, None, chart
