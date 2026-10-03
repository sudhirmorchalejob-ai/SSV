# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Stock summary for a period (deck slides 16, 19, 20, 21):
opening, purchase, net sale, other movements and closing, in quantity and
value, with stock turn. Grouped by distributor, item, category or location.

Opening and closing come from Tally's own closing-stock snapshots moved by the
synced vouchers (see analytics.StockBook). "Other" balances the equation
opening + purchase − net sale + other = closing: stock journals, delivery notes
not yet invoiced, and any difference between Tally's count and the vouchers.
Values use the valuation rate of the nearest snapshot.
"""

import frappe
from frappe import _

from ssv_channel import analytics as A
from ssv_channel import charts as C
from ssv_channel import data as D

GROUPINGS = {
	"Distributor": ["distributor_name"],
	"Distributor > Item": ["distributor_name", "item"],
	# Dealers under the distributor they buy from (Level: Dealer)
	"Distributor > Dealer > Item": ["parent_name", "distributor_name", "item"],
	"Distributor > Dealer": ["parent_name", "distributor_name"],
	"Distributor > Category > Item": ["distributor_name", "category", "item"],
	"Category > Item": ["category", "item"],
	"Product Line > Item": ["product_line", "item"],
	"Zone > State > City": ["zone", "state", "city"],
	"Zone > State > City > Distributor": ["zone", "state", "city", "distributor_name"],
	"State > City": ["state", "city"],
	"State > City > Distributor": ["state", "city", "distributor_name"],
}
QTY = ["opening_qty", "purchase_qty", "net_sale_qty", "other_qty", "closing_qty"]
VAL = ["opening_value", "purchase_value", "net_sale_value", "closing_value"]


def execute(filters=None):
	f = D.resolve_period(filters)
	dims = GROUPINGS.get(f.group_by) or GROUPINGS["Distributor > Item"]
	show_values = f.show_values not in (0, "0", False)

	dist = D.distributors(f)
	opening_day = D.day_before(f.from_date)
	book, ci = D.stock_book(list(dist), at_dates=[opening_day, f.to_date])
	items = D.item_attributes([c.item_code for c in ci.values()])
	lines, _dist = D.period_lines(f, f.from_date, f.to_date)

	moved = {}
	for ln in lines:
		m = moved.setdefault((ln.distributor, ln.channel_item), {"purchase_qty": 0, "purchase_value": 0, "net_sale_qty": 0, "net_sale_value": 0})
		m["purchase_qty"] += ln.purchase_qty
		m["purchase_value"] += ln.purchase_value
		m["net_sale_qty"] += ln.net_qty
		m["net_sale_value"] += ln.net_value

	rows = []
	for key in book.keys():
		distributor, channel_item = key
		if distributor not in dist:
			continue
		c = ci.get(channel_item)
		if c and c.mapping_status == "Ignored":
			continue
		row = frappe._dict(distributor=distributor, channel_item=channel_item)
		D.classify(row, ci, items)
		D.place(row, dist)
		if not D.item_filter_ok(row, f):
			continue
		m = moved.get(key, {})
		row.opening_qty = book.qty_at(key, opening_day)[0]
		row.closing_qty = book.qty_at(key, f.to_date)[0]
		row.opening_value = book.value_at(key, opening_day)
		row.closing_value = book.value_at(key, f.to_date)
		row.purchase_qty = m.get("purchase_qty", 0)
		row.purchase_value = m.get("purchase_value", 0)
		row.net_sale_qty = m.get("net_sale_qty", 0)
		row.net_sale_value = m.get("net_sale_value", 0)
		row.other_qty = row.closing_qty - row.opening_qty - row.purchase_qty + row.net_sale_qty
		if not any(row[k] for k in QTY):
			continue
		rows.append(row)

	label_col = {"fieldname": "label", "label": _(f.group_by if f.group_by in GROUPINGS else " > ".join(d.replace("_name", "").replace("_", " ").title() for d in dims)), "fieldtype": "Data", "width": 320}
	leaf = lambda r: {"unit": r.get("unit"), "item_code": r.get("item_code")}  # noqa: E731
	if f.get("columns") == "Zone":
		return by_zone(rows, dims, label_col, leaf, show_values)

	data = A.tree(rows, dims, QTY + VAL, leaf_extra=leaf)
	if data:
		data.insert(0, A.grand_total(data, QTY + VAL))
	for r in data:
		r["stock_turn"] = A.stock_turn(r.get("opening_qty"), r.get("closing_qty"), r.get("net_sale_qty"))

	columns = [label_col]
	for k in QTY:
		columns.append({"fieldname": k, "label": _(k.replace("_", " ").title()), "fieldtype": "Float", "width": 115})
		vk = k.replace("_qty", "_value")
		if show_values and vk in VAL:
			columns.append({"fieldname": vk, "label": _(vk.replace("_", " ").title()), "fieldtype": "Currency", "width": 130})
	columns.append({"fieldname": "stock_turn", "label": _("Stock Turn"), "fieldtype": "Float", "width": 95})
	chart = C.bars(C.level(data), [("opening_qty", _("Opening")), ("purchase_qty", _("Purchase")),
		("net_sale_qty", _("Net Sale")), ("closing_qty", _("Closing"))], sort_key="closing_qty")
	return columns, data, None, chart


ZONE_KEYS = ["opening_qty", "opening_value", "net_sale_qty", "closing_qty", "closing_value"]


def by_zone(rows, dims, label_col, leaf, show_values):
	"""Deck slide 21: locations down the side, one block of columns per zone."""
	keys = ZONE_KEYS if show_values else [k for k in ZONE_KEYS if k.endswith("_qty")]
	zones = A.pivot_keys(rows, "zone")
	spread = A.spread(rows, "zone", keys)
	sum_keys = [f"{z}::{k}" for z in zones for k in keys] + [f"total::{k}" for k in keys]
	data = A.tree(spread, dims, sum_keys, leaf_extra=leaf)
	if data:
		data.insert(0, A.grand_total(data, sum_keys))
	columns = [label_col]
	for z in list(zones) + ["total"]:
		for k in keys:
			name = _("Total") if z == "total" else z
			columns.append({"fieldname": f"{z}::{k}", "label": f"{name} · {_(k.replace('_', ' ').title())}",
				"fieldtype": "Currency" if k.endswith("_value") else "Float", "width": 130})
	chart = C.over_columns(C.level(data), zones, "closing_qty", "total::closing_qty")
	return columns, data, None, chart
