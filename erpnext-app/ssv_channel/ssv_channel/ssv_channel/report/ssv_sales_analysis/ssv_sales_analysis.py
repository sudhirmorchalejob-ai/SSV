# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Sales analysis pivot: one report for the deck's sales screens.

  slide 17  Item-wise sales          rows Item,                        columns Distributor
  slide 18  Brand-wise with product  rows Product Line > Brand > Category > Item, columns Distributor
  slide 22  Sub-category             rows Sub-Category > Item,         columns Distributor, qty and value
  slide 23  Product line columnar    rows Distributor > Item,          columns Product Line
  slide 25  Brand > category         rows Brand > Category > Item,     columns Distributor
  slide 26  Pack-wise                rows Pack Size > Category > Item, columns Distributor
  slide 28  Month on month           rows Retailer > Item,             columns Month
  slide 29  Distributor monthly      rows Month,                       columns Distributor

Net sale = sales out − credit notes in. Deleted and cancelled vouchers excluded.
"""

import frappe
from frappe import _

from ssv_channel import analytics as A
from ssv_channel import charts as C
from ssv_channel import data as D

ROWS = {
	"Item": ["item"],
	"Distributor": ["distributor_name"],
	"Distributor > Item": ["distributor_name", "item"],
	# Dealers under the distributor they buy from (Level: Dealer)
	"Distributor > Dealer > Item": ["parent_name", "distributor_name", "item"],
	"Distributor > Dealer": ["parent_name", "distributor_name"],
	"Product Line > Item": ["product_line", "item"],
	"Product Line > Brand > Category > Item": ["product_line", "brand", "category", "item"],
	"Brand > Category > Item": ["brand", "category", "item"],
	"Category > Item": ["category", "item"],
	"Sub-Category > Item": ["sub_category", "item"],
	"Pack Size > Category > Item": ["size", "category", "item"],
	"Retailer > Item": ["retailer_name", "item"],
	"Distributor > Retailer > Item": ["distributor_name", "retailer_name", "item"],
	"Zone > State > City": ["zone", "state", "city"],
	"Month": ["month"],
}
COLUMNS = {
	"None": None, "Distributor": "distributor_name", "Month": "month", "Product Line": "product_line",
	"Brand": "brand", "Category": "category", "Pack Size": "size", "Zone": "zone", "State": "state",
}
MEASURES = {"Net Qty": ["net_qty"], "Net Value": ["net_value"], "Net Qty and Value": ["net_qty", "net_value"],
	"Sales, Returns and Net": ["sale_qty", "return_qty", "net_qty", "net_value"]}
LABELS = {"net_qty": "Net Sale Qty", "net_value": "Net Sale Value", "sale_qty": "Sales Qty", "return_qty": "Return Qty"}


def execute(filters=None):
	f = D.resolve_period(filters)
	dims = ROWS.get(f.rows) or ROWS["Distributor > Item"]
	col_dim = COLUMNS.get(f.columns or "Distributor")
	measures = MEASURES.get(f.measure) or MEASURES["Net Qty"]

	by_retailer = f.get("retailer") or any(d.startswith("retailer") for d in dims)
	if by_retailer:
		lines, _dist = D.voucher_lines(f, f.from_date, f.to_date, base_types=["Sales", "Credit Note"])
	else:
		# Whole months from SSV Monthly Summary, part-months from the vouchers.
		lines, _dist = D.period_lines(f, f.from_date, f.to_date)
	lines = [ln for ln in lines if D.item_filter_ok(ln, f) and (ln.net_qty or ln.sale_qty or ln.return_qty)]
	if f.get("retailer"):
		lines = [ln for ln in lines if ln.retailer == f.retailer]

	if "month" in dims or col_dim == "month":
		# chronological, not alphabetical
		order = sorted({(ln.month_key, ln.month) for ln in lines})
		month_order = [m for _k, m in order]
	else:
		month_order = None

	if col_dim:
		cols = A.pivot_keys(lines, col_dim, order=month_order if col_dim == "month" else None)
		rows = A.spread(lines, col_dim, measures)
		sum_keys = [f"{c}::{m}" for c in cols for m in measures] + [f"total::{m}" for m in measures]
	else:
		cols, rows, sum_keys = [], lines, list(measures)

	data = A.tree(rows, dims, sum_keys, leaf_extra=lambda r: {"item_code": r.get("item_code")})
	if month_order and dims == ["month"]:
		rank = {m: i for i, m in enumerate(month_order)}
		data.sort(key=lambda r: rank.get(r["label"], 999))
	if data:
		data.insert(0, A.grand_total(data, sum_keys))

	columns = [{"fieldname": "label", "label": _(" > ".join(f.rows.split(" > ")) if f.rows else "Distributor > Item"), "fieldtype": "Data", "width": 300}]
	for c in cols:
		for m in measures:
			columns.append({"fieldname": f"{c}::{m}", "label": f"{c} · {_(LABELS[m])}" if len(measures) > 1 else str(c),
				"fieldtype": "Currency" if m.endswith("value") else "Float", "width": 130})
	for m in measures:
		key = f"total::{m}" if col_dim else m
		columns.append({"fieldname": key, "label": _("Total · {0}").format(_(LABELS[m])) if col_dim else _(LABELS[m]),
			"fieldtype": "Currency" if m.endswith("value") else "Float", "width": 140})
	return columns, data, None, chart(data, dims, cols, col_dim, measures)


def chart(data, dims, cols, col_dim, measures):
	"""The first measure only, so quantity and rupees never share an axis."""
	m = measures[0]
	ft = "Currency" if m.endswith("value") else None
	top = C.level(data)
	if dims == ["month"]:
		# Rows are months already: a line through them, in order.
		key = f"total::{m}" if col_dim else m
		return {"data": {"labels": [r["label"] for r in top], "datasets": [{"name": _(LABELS[m]), "values": [round(r.get(key) or 0, 2) for r in top]}]},
			"type": "line", **({"fieldtype": ft} if ft else {})}
	if col_dim:
		return C.over_columns(top, cols, m, f"total::{m}", as_line=col_dim == "month", fieldtype=ft)
	return C.bars(top, [(m, _(LABELS[m]))], fieldtype=ft)
