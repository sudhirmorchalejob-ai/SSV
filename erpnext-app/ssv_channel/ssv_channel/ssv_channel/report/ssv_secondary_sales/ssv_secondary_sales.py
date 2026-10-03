# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Secondary sales: what distributors sold, net of returns.

  sales   = goods out on Sales vouchers
  returns = goods in on Credit Notes
  net     = sales − returns
  outlets = distinct retailers billed (stock penetration, deck slide 30)

Items join through SSV Channel Item, so mapping a Tally item to an ERPNext
Item later also applies to past vouchers. Deleted and cancelled vouchers are
excluded.
"""

import frappe
from frappe import _

from ssv_channel import data as D

GROUPINGS = {
	"Distributor and Item": ["distributor", "item"],
	"Item": ["item"],
	"Distributor": ["distributor"],
	"Retailer": ["distributor", "retailer"],
	"Retailer and Item": ["distributor", "retailer", "item"],
}

DIMENSIONS = {
	"distributor": ("v.distributor", [{"fieldname": "distributor", "label": _("Distributor"), "fieldtype": "Link", "options": "SSV Distributor", "width": 180}]),
	"item": (
		"COALESCE(ci.item_code, i.tally_item_name), ci.item_code, i.tally_item_name",
		[
			{"fieldname": "item_code", "label": _("Item"), "fieldtype": "Link", "options": "Item", "width": 160},
			{"fieldname": "tally_item_name", "label": _("Item in Tally"), "fieldtype": "Data", "width": 200},
		],
	),
	"retailer": (
		"v.retailer",
		[
			{"fieldname": "retailer", "label": _("Retailer"), "fieldtype": "Link", "options": "SSV Retailer", "width": 200},
			{"fieldname": "retailer_state", "label": _("State"), "fieldtype": "Data", "width": 120},
		],
	),
}

SELECT_DIMS = {
	"distributor": "v.distributor AS distributor",
	"item": "ci.item_code AS item_code, i.tally_item_name AS tally_item_name",
	"retailer": "v.retailer AS retailer, MAX(r.state) AS retailer_state",
}


MONTH_ON_MONTH = "Month on Month (Retailer × Item)"
ATTRS = [  # the item classification the deck's month-on-month listing shows beside each row
	("category", "Category", 110), ("brand", "Brand", 100), ("size_group", "Size Group", 100),
	("size_sort", "Size Sort", 80), ("size", "Pack Size", 100), ("product_line", "Product Line", 120),
]


def month_on_month(filters):
	"""Deck slide 28: one row per retailer, item and distributor, then quantity and value per month."""
	f = D.resolve_period(filters)
	lines, _dist = D.voucher_lines(f, f.from_date, f.to_date, base_types=["Sales", "Credit Note"])
	lines = [ln for ln in lines if D.item_filter_ok(ln, f) and (ln.net_qty or ln.net_value)]
	months = [m for _k, m in sorted({(ln.month_key, ln.month) for ln in lines})]
	rows = {}
	for ln in lines:
		key = (ln.retailer_name, ln.item, ln.distributor_name)
		r = rows.get(key)
		if r is None:
			r = rows[key] = frappe._dict(retailer=ln.retailer_name, item=ln.item, item_code=ln.item_code,
				tally_item_name=ln.tally_item_name, distributor=ln.distributor_name, net_qty=0.0, net_value=0.0,
				**{k: ln.get(k) for k, _l, _w in ATTRS})
		r[f"{ln.month}::qty"] = (r.get(f"{ln.month}::qty") or 0) + ln.net_qty
		r[f"{ln.month}::value"] = (r.get(f"{ln.month}::value") or 0) + ln.net_value
		r.net_qty += ln.net_qty
		r.net_value += ln.net_value
	data = sorted(rows.values(), key=lambda r: (str(r.retailer).lower(), str(r.item).lower(), str(r.distributor).lower()))
	if data:
		total = frappe._dict(retailer=_("Total"), is_total=1)
		for k in ["net_qty", "net_value"] + [f"{m}::{x}" for m in months for x in ("qty", "value")]:
			total[k] = sum(float(r.get(k) or 0) for r in data)
		data.insert(0, total)

	columns = [
		{"fieldname": "retailer", "label": _("Retailer"), "fieldtype": "Data", "width": 180},
		{"fieldname": "item", "label": _("Item"), "fieldtype": "Data", "width": 180},
		{"fieldname": "distributor", "label": _("Distributor"), "fieldtype": "Data", "width": 180},
	] + [{"fieldname": k, "label": _(label), "fieldtype": "Int" if k == "size_sort" else "Data", "width": w} for k, label, w in ATTRS]
	for m in months:
		columns.append({"fieldname": f"{m}::qty", "label": f"{m} · {_('Item Quantity')}", "fieldtype": "Float", "width": 110})
		columns.append({"fieldname": f"{m}::value", "label": f"{m} · {_('Item Value')}", "fieldtype": "Currency", "width": 130})
	columns += [
		{"fieldname": "net_qty", "label": _("Total · Item Quantity"), "fieldtype": "Float", "width": 120},
		{"fieldname": "net_value", "label": _("Total · Item Value"), "fieldtype": "Currency", "width": 140},
	]
	return columns, data


def execute(filters=None):
	filters = frappe._dict(filters or {})
	if filters.group_by == MONTH_ON_MONTH:
		return month_on_month(filters)
	dims = GROUPINGS.get(filters.group_by) or GROUPINGS["Distributor and Item"]

	columns = []
	for d in dims:
		columns += DIMENSIONS[d][1]
	columns += [
		{"fieldname": "sales_qty", "label": _("Sales Qty"), "fieldtype": "Float", "width": 110},
		{"fieldname": "return_qty", "label": _("Return Qty"), "fieldtype": "Float", "width": 110},
		{"fieldname": "net_qty", "label": _("Net Qty"), "fieldtype": "Float", "width": 110},
		{"fieldname": "net_value", "label": _("Net Value"), "fieldtype": "Currency", "width": 130},
		{"fieldname": "outlets", "label": _("Outlets Billed"), "fieldtype": "Int", "width": 110},
	]

	conditions = ["v.is_deleted = 0", "v.is_cancelled = 0", "v.voucher_date BETWEEN %(from_date)s AND %(to_date)s"]
	if filters.distributor:
		conditions.append("v.distributor = %(distributor)s")
	if filters.item_code:
		conditions.append("ci.item_code = %(item_code)s")
	if filters.territory:
		lft, rgt = frappe.db.get_value("Territory", filters.territory, ["lft", "rgt"])
		conditions.append(
			"d.territory IN (SELECT name FROM `tabTerritory` WHERE lft >= %(t_lft)s AND rgt <= %(t_rgt)s)"
		)
		filters.update(t_lft=lft, t_rgt=rgt)

	select_dims = ", ".join(SELECT_DIMS[d] for d in dims)
	group_by = ", ".join(DIMENSIONS[d][0] for d in dims)

	data = frappe.db.sql(
		f"""
		SELECT {select_dims},
			SUM(CASE WHEN v.base_type = 'Sales' AND i.direction = 'out' THEN i.qty * IFNULL(NULLIF(ci.conversion_factor, 0), 1) ELSE 0 END) AS sales_qty,
			SUM(CASE WHEN v.base_type = 'Credit Note' AND i.direction = 'in' THEN i.qty * IFNULL(NULLIF(ci.conversion_factor, 0), 1) ELSE 0 END) AS return_qty,
			SUM(CASE WHEN v.base_type = 'Sales' AND i.direction = 'out' THEN i.amount
			         WHEN v.base_type = 'Credit Note' AND i.direction = 'in' THEN -i.amount ELSE 0 END) AS net_value,
			COUNT(DISTINCT CASE WHEN v.base_type = 'Sales' THEN v.retailer END) AS outlets
		FROM `tabSSV Secondary Voucher` v
		JOIN `tabSSV Secondary Voucher Item` i ON i.parent = v.name AND i.parenttype = 'SSV Secondary Voucher'
		JOIN `tabSSV Distributor` d ON d.name = v.distributor
		LEFT JOIN `tabSSV Channel Item` ci ON ci.name = i.channel_item
		LEFT JOIN `tabSSV Retailer` r ON r.name = v.retailer
		WHERE {" AND ".join(conditions)}
		GROUP BY {group_by}
		ORDER BY net_value DESC
		""",
		filters,
		as_dict=True,
	)
	for row in data:
		row.net_qty = (row.sales_qty or 0) - (row.return_qty or 0)

	chart = None
	if data and "item" in dims and len(dims) == 1:
		top = data[:10]
		chart = {
			"data": {
				"labels": [r.item_code or r.tally_item_name for r in top],
				"datasets": [{"name": _("Net Qty"), "values": [r.net_qty for r in top]}],
			},
			"type": "bar",
		}
	return columns, data, None, chart
