# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Sync health per distributor (the deck's slide 33 "Data Sync Log"): whether the
agent is running and succeeding, when data last arrived, and how many batches
and records arrived in the period.

  Errors   refused batches in the period
  Failing  the agent's last run report says it failed (e.g. TallyPrime closed)
  Silent   no successful run or data for 3 × the stale limit, or never
  Stale    no successful run or data within the stale limit
  Mismatch the agent's daily totals of what it delivered differ from what this
           site holds (agent 0.5.3+; see SSV Tally Company → Differences)
  OK       otherwise

The stale limit is 24 hours, or twice the distributor's sync interval if that
is longer, so a once-a-day agent is not flagged between its runs. Agents before
0.4.0 send no run reports; for them only the last data received counts.
"""

import frappe
from frappe import _
from frappe.utils import cint, get_datetime, now_datetime, time_diff_in_hours

from ssv_channel import charts as C


def stale_limit_hours(interval_minutes) -> float:
	return max(24, 2 * cint(interval_minutes) / 60)


def last_good(row):
	"""Latest sign of a working agent: a successful run or data received."""
	times = [get_datetime(t) for t in (row.get("last_ok_run_at"), row.get("last_seen_at")) if t]
	return max(times) if times else None


def health_status(row, now) -> str:
	if row.get("rejected"):
		return "Errors"
	if row.get("last_run_status") == "Failed":
		return "Failing"
	good = last_good(row)
	limit = stale_limit_hours(row.get("sync_interval_minutes"))
	hours = time_diff_in_hours(now, good) if good else None
	if hours is None or hours > 3 * limit:
		return "Silent"
	if hours > limit:
		return "Stale"
	if row.get("reconcile_status") == "Mismatch":
		return "Mismatch"
	return "OK"


def execute(filters=None):
	filters = frappe._dict(filters or {})
	columns = [
		{"fieldname": "status", "label": _("Status"), "fieldtype": "Data", "width": 90},
		{"fieldname": "distributor", "label": _("Distributor"), "fieldtype": "Link", "options": "SSV Distributor", "width": 140},
		{"fieldname": "distributor_name", "label": _("Name"), "fieldtype": "Data", "width": 200},
		{"fieldname": "partner_level", "label": _("Level"), "fieldtype": "Data", "width": 90},
		{"fieldname": "parent_distributor", "label": _("Buys From"), "fieldtype": "Link", "options": "SSV Distributor", "width": 120},
		{"fieldname": "territory", "label": _("Territory"), "fieldtype": "Link", "options": "Territory", "width": 110},
		{"fieldname": "sync_interval_minutes", "label": _("Every (min)"), "fieldtype": "Int", "width": 90},
		{"fieldname": "last_contact_at", "label": _("Last Contact"), "fieldtype": "Datetime", "width": 150},
		{"fieldname": "last_run_at", "label": _("Last Run"), "fieldtype": "Datetime", "width": 150},
		{"fieldname": "last_run_problem", "label": _("Problem"), "fieldtype": "Data", "width": 260},
		{"fieldname": "last_seen_at", "label": _("Last Data"), "fieldtype": "Datetime", "width": 150},
		{"fieldname": "batches", "label": _("Batches"), "fieldtype": "Int", "width": 80},
		{"fieldname": "records", "label": _("Records"), "fieldtype": "Int", "width": 80},
		{"fieldname": "rejected", "label": _("Refused"), "fieldtype": "Int", "width": 80},
		{"fieldname": "reconcile_status", "label": _("Reconciled"), "fieldtype": "Data", "width": 95},
		{"fieldname": "reconciled_at", "label": _("Reconciled At"), "fieldtype": "Datetime", "width": 150},
		{"fieldname": "agent_version", "label": _("Agent"), "fieldtype": "Data", "width": 70},
	]
	data = frappe.db.sql(
		"""
		SELECT d.name AS distributor, d.distributor_name, COALESCE(d.partner_level, 'Distributor') AS partner_level,
			d.parent_distributor, d.territory, d.sync_interval_minutes,
			d.last_contact_at, d.last_run_at, d.last_run_status, d.last_run_problem, d.last_ok_run_at,
			d.last_seen_at, d.agent_version,
			(SELECT CASE WHEN SUM(tc.reconcile_status = 'Mismatch') > 0 THEN 'Mismatch'
					WHEN SUM(tc.reconcile_status = 'OK') > 0 THEN 'OK' END
				FROM `tabSSV Tally Company` tc WHERE tc.distributor = d.name) AS reconcile_status,
			(SELECT MAX(tc.reconciled_at) FROM `tabSSV Tally Company` tc WHERE tc.distributor = d.name) AS reconciled_at,
			(SELECT GROUP_CONCAT(tc.reconcile_problem SEPARATOR ' | ') FROM `tabSSV Tally Company` tc
				WHERE tc.distributor = d.name AND tc.reconcile_status = 'Mismatch') AS reconcile_problem,
			COUNT(l.name) AS batches,
			COALESCE(SUM(l.records), 0) AS records,
			COALESCE(SUM(l.status = 'Rejected'), 0) AS rejected
		FROM `tabSSV Distributor` d
		LEFT JOIN `tabSSV Ingest Log` l
			ON l.distributor = d.name AND DATE(l.received_at) BETWEEN %(from_date)s AND %(to_date)s
		WHERE d.enabled = 1
		GROUP BY d.name
		ORDER BY d.last_seen_at IS NULL DESC, d.last_seen_at ASC
		""",
		filters,
		as_dict=True,
	)
	now = now_datetime()
	for row in data:
		row.status = health_status(row, now)
		if row.status == "Mismatch" and not row.last_run_problem:
			row.last_run_problem = row.reconcile_problem
	by_status = {s: sum(1 for r in data if r.status == s) for s in ("OK", "Mismatch", "Stale", "Silent", "Failing", "Errors")}
	return columns, data, None, C.counts(by_status)
