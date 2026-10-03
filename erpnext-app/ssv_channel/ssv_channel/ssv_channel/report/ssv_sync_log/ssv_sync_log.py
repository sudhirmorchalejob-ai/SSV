# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Day-wise sync log (deck slide 33): for one month, the records received from
each distributor on each day, with state, city, distributor code, the date its
data first arrived ("open date") and the last batch.
"""

import calendar

import frappe
from frappe import _
from frappe.utils import getdate

from ssv_channel import data as D


def execute(filters=None):
	f = frappe._dict(filters or {})
	month = getdate(f.month or frappe.utils.today())
	days = calendar.monthrange(month.year, month.month)[1]
	first, last = month.replace(day=1), month.replace(day=days)

	dist = D.distributors(frappe._dict(territory=f.territory, level="All"))
	per_day = frappe.db.sql(
		"""SELECT distributor, DAY(received_at) AS d, SUM(records) AS n
		FROM `tabSSV Ingest Log`
		WHERE status = 'Applied' AND DATE(received_at) BETWEEN %(first)s AND %(last)s
		GROUP BY distributor, DAY(received_at)""",
		{"first": first, "last": last}, as_dict=True)
	firsts = {r.distributor: r for r in frappe.db.sql(
		"""SELECT distributor, MIN(received_at) AS open_date, MAX(received_at) AS last_batch
		FROM `tabSSV Ingest Log` WHERE status = 'Applied' GROUP BY distributor""", as_dict=True)}

	data = []
	for name, d in sorted(dist.items(), key=lambda x: (x[1].state or "", x[1].city or "", x[0])):
		row = {"state": d.state, "city": d.city, "distributor": name, "distributor_name": d.distributor_name,
			"open_date": (firsts.get(name) or {}).get("open_date"), "last_batch": (firsts.get(name) or {}).get("last_batch")}
		for day in range(1, days + 1):
			row[f"d{day:02d}"] = 0
		data.append(row)
	index = {r["distributor"]: r for r in data}
	for r in per_day:
		if r.distributor in index:
			index[r.distributor][f"d{int(r.d):02d}"] = int(r.n or 0)

	columns = [
		{"fieldname": "state", "label": _("State"), "fieldtype": "Data", "width": 110},
		{"fieldname": "city", "label": _("City"), "fieldtype": "Data", "width": 110},
		{"fieldname": "distributor", "label": _("Code"), "fieldtype": "Link", "options": "SSV Distributor", "width": 100},
		{"fieldname": "distributor_name", "label": _("Distributor"), "fieldtype": "Data", "width": 190},
	]
	columns += [{"fieldname": f"d{day:02d}", "label": f"{day:02d}", "fieldtype": "Int", "width": 50} for day in range(1, days + 1)]
	columns += [
		{"fieldname": "open_date", "label": _("Open Date"), "fieldtype": "Datetime", "width": 150},
		{"fieldname": "last_batch", "label": _("Last Batch"), "fieldtype": "Datetime", "width": 150},
	]
	return columns, data
