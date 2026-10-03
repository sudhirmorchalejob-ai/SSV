# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Data for the SSV Dashboard page (deck slides 14–15), all in net sale quantity:

  quarter-wise (current FY) · zone-wise · state-wise · monthly this FY vs last FY ·
  top 10 categories · top 10 brands · this month by day · last 15 days ·
  last quarter by month · last month by day
"""

import datetime as dt
from collections import defaultdict

import frappe
from frappe.utils import getdate

from ssv_channel import analytics as A
from ssv_channel import data as D


def _sum(lines, key_fn):
	out = defaultdict(float)
	for ln in lines:
		out[key_fn(ln)] += ln.net_qty
	return out


def _days(start, end):
	d = start
	while d <= end:
		yield d
		d += dt.timedelta(days=1)


def _series(start, end, by_day):
	days = list(_days(start, end))
	return {"labels": [d.strftime("%d/%m") for d in days], "values": [round(by_day.get(d, 0), 2) for d in days]}


def _top(counter, n=10):
	pairs = sorted(counter.items(), key=lambda kv: kv[1], reverse=True)[:n]
	return {"labels": [k for k, _ in pairs], "values": [round(v, 2) for _, v in pairs]}


def coverage(dist):
	"""How complete the figures are: distributors whose data is up to date, by Sync Health's rules."""
	from frappe.utils import now_datetime

	from ssv_channel.ssv_channel.report.ssv_sync_health.ssv_sync_health import health_status

	rows = frappe.get_all("SSV Distributor", filters={"name": ["in", list(dist) or [""]]},
		fields=["name", "distributor_name", "sync_interval_minutes", "last_run_status", "last_ok_run_at", "last_seen_at"])
	now = now_datetime()
	behind = []
	for r in rows:
		status = health_status(r, now)
		if status != "OK":
			behind.append({"distributor": r.distributor_name, "status": status})
	return {"total": len(rows), "up_to_date": len(rows) - len(behind), "behind": behind}


@frappe.whitelist()
def get_data(distributor=None, territory=None, level=None):
	frappe.only_for(("System Manager", "Sales Manager", "Sales User"))
	today = getdate()
	fy_from, fy_to = A.period_range("Current Financial Year", today)
	last_fy_from = dt.date(fy_from.year - 1, fy_from.month, 1)
	# Distributor (secondary sales) or Dealer (tertiary sales): never both, which would count goods twice.
	filters = frappe._dict(distributor=distributor, territory=territory, level=level if level == "Dealer" else "Distributor")

	# Two financial years by month: whole months from SSV Monthly Summary.
	lines, dist = D.period_lines(filters, last_fy_from, fy_to)
	lines = [ln for ln in lines if ln.net_qty or ln.sale_qty or ln.return_qty]
	for ln in lines:
		ln.voucher_date = getdate(ln.voucher_date)
	this_fy = [ln for ln in lines if ln.voucher_date >= fy_from]
	prev_fy = [ln for ln in lines if ln.voucher_date < fy_from]

	months = [A._add_months(fy_from, i) for i in range(12)]
	mkey = lambda d: (d.year - fy_from.year) * 12 + d.month - fy_from.month  # noqa: E731
	pkey = lambda d: (d.year - last_fy_from.year) * 12 + d.month - last_fy_from.month  # noqa: E731
	by_month_now, by_month_prev = _sum(this_fy, lambda ln: mkey(ln.voucher_date)), _sum(prev_fy, lambda ln: pkey(ln.voucher_date))
	by_quarter = _sum(this_fy, lambda ln: mkey(ln.voucher_date) // 3)

	m_from, m_to = A.period_range("Current Month", today)
	lm_from, lm_to = A.period_range("Last Month", today)
	d15_from, d15_to = A.period_range("Last 15 Days", today)
	lq_from, lq_to = A.period_range("Last Quarter", today)
	lq_months = [A._add_months(lq_from, i) for i in range(3)]
	lq = _sum([ln for ln in lines if lq_from <= ln.voucher_date <= lq_to], lambda ln: (ln.voucher_date.year, ln.voucher_date.month))

	# Day-by-day charts need the vouchers themselves, but only for the last two or three months.
	day_from = min(lm_from, d15_from, m_from)
	recent, _d = D.voucher_lines(filters, day_from, today, base_types=["Sales", "Credit Note"])
	by_day_all = _sum(recent, lambda ln: getdate(ln.voucher_date))
	by_day = {d: v for d, v in by_day_all.items() if d >= fy_from}

	outlets = 0
	if dist:
		outlets = frappe.db.sql(
			"""SELECT COUNT(DISTINCT retailer) FROM `tabSSV Secondary Voucher`
			WHERE distributor IN %(dist)s AND base_type = 'Sales' AND is_deleted = 0 AND is_cancelled = 0
				AND retailer IS NOT NULL AND voucher_date BETWEEN %(f)s AND %(t)s""",
			{"dist": tuple(dist), "f": fy_from, "t": fy_to})[0][0]

	return {
		"coverage": coverage(dist),
		"fy": f"{fy_from:%d-%m-%Y} to {fy_to:%d-%m-%Y}",
		"total_net_qty": round(sum(ln.net_qty for ln in this_fy), 2),
		"distributors": len({ln.distributor for ln in this_fy}),
		"outlets": outlets,
		"quarter": {"labels": ["Q1", "Q2", "Q3", "Q4"], "values": [round(by_quarter.get(q, 0), 2) for q in range(4)]},
		"zone": _top(_sum(this_fy, lambda ln: ln.zone or "(not set)"), 20),
		"state": _top(_sum(this_fy, lambda ln: ln.state or "(not set)"), 20),
		"monthly": {
			"labels": [m.strftime("%b") for m in months],
			"current": [round(by_month_now.get(i, 0), 2) for i in range(12)],
			"previous": [round(by_month_prev.get(i, 0), 2) for i in range(12)],
		},
		"categories": _top(_sum(this_fy, lambda ln: ln.category)),
		"brands": _top(_sum(this_fy, lambda ln: ln.brand)),
		"this_month": _series(m_from, min(m_to, today), by_day),
		"last_15": _series(d15_from, d15_to, by_day_all),
		"last_quarter": {"labels": [m.strftime("%b") for m in lq_months],
			"values": [round(lq.get((m.year, m.month), 0), 2) for m in lq_months]},
		"last_month": _series(lm_from, lm_to, by_day_all),
	}
