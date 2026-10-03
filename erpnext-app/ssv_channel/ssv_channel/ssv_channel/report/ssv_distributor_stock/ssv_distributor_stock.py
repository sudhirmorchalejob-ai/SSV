# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Distributor closing stock of the principal's items: the latest snapshot on or
before the chosen date, per distributor and item. Negative stock (which Tally
allows) is shown in red rather than hidden. "Days Old" shows how stale the
figure is, e.g. when a distributor's Tally has not synced.

Godown-wise: one row per godown, from the split Tally reported with the
snapshot. Tally's item total stays authoritative: if the godowns do not add up
to it, the difference is shown as "Unallocated"; a snapshot sent without a
split (agent before 0.3.0) shows as "(not reported)".
"""

import frappe
from frappe import _
from frappe.utils import date_diff, flt, getdate

from ssv_channel import charts as C

UNALLOCATED = "Unallocated"
NOT_REPORTED = "(not reported)"


def godown_rows(row: dict, godown_split: bool, godowns: list[dict]) -> list[dict]:
	"""Split one item's snapshot row into one row per godown."""
	if not godown_split:
		return [{**row, "godown": NOT_REPORTED}]
	out = [{**row, "godown": g["godown"], "closing_qty": flt(g["closing_qty"]), "closing_value": flt(g["closing_value"])} for g in godowns]
	qty_gap = flt(row["closing_qty"]) - sum(r["closing_qty"] for r in out)
	value_gap = flt(row["closing_value"]) - sum(r["closing_value"] for r in out)
	if abs(qty_gap) > 0.001 or abs(value_gap) > 0.01:
		out.append({**row, "godown": UNALLOCATED, "closing_qty": qty_gap, "closing_value": value_gap})
	return out


def execute(filters=None):
	filters = frappe._dict(filters or {})
	filters.as_of_date = getdate(filters.as_of_date)

	columns = [
		{"fieldname": "distributor", "label": _("Distributor"), "fieldtype": "Link", "options": "SSV Distributor", "width": 180},
		{"fieldname": "territory", "label": _("Territory"), "fieldtype": "Link", "options": "Territory", "width": 120},
		{"fieldname": "item_code", "label": _("Item"), "fieldtype": "Link", "options": "Item", "width": 160},
		{"fieldname": "tally_item_name", "label": _("Item in Tally"), "fieldtype": "Data", "width": 200},
		*([{"fieldname": "godown", "label": _("Godown"), "fieldtype": "Data", "width": 140}] if filters.godown_wise else []),
		{"fieldname": "closing_qty", "label": _("Closing Qty"), "fieldtype": "Float", "width": 110},
		{"fieldname": "unit", "label": _("Unit"), "fieldtype": "Data", "width": 70},
		{"fieldname": "closing_value", "label": _("Closing Value"), "fieldtype": "Currency", "width": 130},
		{"fieldname": "snapshot_date", "label": _("Snapshot Date"), "fieldtype": "Date", "width": 110},
		{"fieldname": "days_old", "label": _("Days Old"), "fieldtype": "Int", "width": 80},
	]

	conditions = ["ci.mapping_status != 'Ignored'"]
	if filters.distributor:
		conditions.append("s.distributor = %(distributor)s")
	if filters.item_code:
		conditions.append("ci.item_code = %(item_code)s")
	if filters.territory:
		lft, rgt = frappe.db.get_value("Territory", filters.territory, ["lft", "rgt"])
		conditions.append("d.territory IN (SELECT name FROM `tabTerritory` WHERE lft >= %(t_lft)s AND rgt <= %(t_rgt)s)")
		filters.update(t_lft=lft, t_rgt=rgt)

	data = frappe.db.sql(
		f"""
		SELECT s.name AS snapshot, s.godown_split, s.distributor, d.territory, ci.item_code, ci.tally_item_name, ci.unit,
			ci.conversion_factor, s.closing_qty, s.closing_value, s.as_of_date AS snapshot_date
		FROM `tabSSV Stock Snapshot` s
		JOIN (
			SELECT channel_item, MAX(as_of_date) AS as_of_date
			FROM `tabSSV Stock Snapshot`
			WHERE as_of_date <= %(as_of_date)s
			GROUP BY channel_item
		) latest ON latest.channel_item = s.channel_item AND latest.as_of_date = s.as_of_date
		JOIN `tabSSV Channel Item` ci ON ci.name = s.channel_item
		JOIN `tabSSV Distributor` d ON d.name = s.distributor
		WHERE {" AND ".join(conditions)}
		ORDER BY s.distributor, ci.tally_item_name
		""",
		filters,
		as_dict=True,
	)
	units = {}
	for row in data:
		row.days_old = date_diff(filters.as_of_date, row.snapshot_date)
		# Quantities in your Item's own unit when the channel item has a conversion factor.
		units[row.snapshot] = flt(row.conversion_factor) or 1
		row.closing_qty = flt(row.closing_qty) * units[row.snapshot]

	if filters.godown_wise:
		split = {}
		for g in frappe.get_all(
			"SSV Stock Snapshot Godown",
			filters={"parenttype": "SSV Stock Snapshot", "parent": ["in", [r.snapshot for r in data] or [""]]},
			fields=["parent", "godown", "closing_qty", "closing_value"],
			order_by="parent, idx",
		):
			g.closing_qty = flt(g.closing_qty) * units.get(g.parent, 1)
			split.setdefault(g.parent, []).append(g)
		data = [
			frappe._dict(r)
			for row in data
			for r in godown_rows(row, row.godown_split, split.get(row.snapshot, []))
			if not filters.godown or r["godown"] == filters.godown
		]
	return columns, data, None, chart(data, by_godown=bool(filters.godown_wise))


def chart(data, by_godown):
	"""Closing quantity per item across distributors, or per godown when godown-wise."""
	totals = {}
	for r in data:
		key = r.get("godown") if by_godown else (r.get("item_code") or r.get("tally_item_name"))
		totals[key] = totals.get(key, 0) + flt(r.get("closing_qty"))
	rows = [{"label": k, "closing_qty": v} for k, v in totals.items()]
	return C.bars(rows, [("closing_qty", _("Closing Qty"))], limit=15)
