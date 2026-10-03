# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Daily alerts (blueprint MVP: failing or stale sync, negative stock), e-mailed to
SSV Settings → Send Alerts To. Runs from the daily scheduler; nothing is sent
when the address list is empty or there is nothing to report.
"""

import re

import frappe
from frappe import _
from frappe.utils import add_to_date, format_datetime, now_datetime

from ssv_channel.ssv_channel.report.ssv_sync_health.ssv_sync_health import last_good


def recipients():
	raw = frappe.db.get_single_value("SSV Settings", "alert_emails") or ""
	return [e for e in re.split(r"[\s,;]+", raw) if "@" in e]


AGENT_FIELDS = ["name", "distributor_name", "last_seen_at", "last_ok_run_at", "sync_interval_minutes",
	"last_run_status", "last_run_problem", "last_run_at"]


def stale_distributors(hours):
	"""No successful run and no data for `hours`, or twice the distributor's sync interval if longer."""
	now = now_datetime()
	rows = frappe.get_all("SSV Distributor", filters={"enabled": 1}, fields=AGENT_FIELDS)
	out = []
	for r in rows:
		good = last_good(r)
		limit = max(hours, 2 * (r.sync_interval_minutes or 0) / 60)
		if not good or good < add_to_date(now, hours=-limit):
			out.append(r)
	return out


def failing_distributors():
	"""The agent runs but its last run failed, e.g. TallyPrime closed or the company not open."""
	return frappe.get_all("SSV Distributor", filters={"enabled": 1, "last_run_status": "Failed"}, fields=AGENT_FIELDS)


def mismatched_companies():
	"""Tally companies whose agent totals last differed from what this site holds."""
	return frappe.db.sql(
		"""SELECT d.name, d.distributor_name, tc.tally_company_name, tc.reconciled_at, tc.reconcile_problem
		FROM `tabSSV Tally Company` tc JOIN `tabSSV Distributor` d ON d.name = tc.distributor
		WHERE d.enabled = 1 AND tc.reconcile_status = 'Mismatch' ORDER BY d.name""",
		as_dict=True,
	)


def negative_stock():
	"""Items whose latest closing snapshot is below zero."""
	return frappe.db.sql(
		"""SELECT s.distributor, ci.tally_item_name, ci.item_code, s.closing_qty, s.as_of_date
		FROM `tabSSV Stock Snapshot` s
		JOIN (SELECT channel_item, MAX(as_of_date) AS d FROM `tabSSV Stock Snapshot` GROUP BY channel_item) latest
			ON latest.channel_item = s.channel_item AND latest.d = s.as_of_date
		JOIN `tabSSV Channel Item` ci ON ci.name = s.channel_item
		WHERE s.closing_qty < 0 AND ci.mapping_status != 'Ignored'
		ORDER BY s.distributor, ci.tally_item_name""",
		as_dict=True,
	)


def build_message(stale, negative, hours, failing=(), mismatched=()):
	parts = []
	if mismatched:
		rows = "".join(
			f"<tr><td>{frappe.utils.escape_html(m.distributor_name)}</td><td>{m.name}</td>"
			f"<td>{frappe.utils.escape_html(m.tally_company_name or '')}</td>"
			f"<td>{format_datetime(m.reconciled_at) if m.reconciled_at else ''}</td>"
			f"<td>{frappe.utils.escape_html(m.reconcile_problem or '').replace(chr(10), '<br>')}</td></tr>"
			for m in mismatched)
		parts.append("<h3>Totals differ between the agent and this site</h3>"
			f"<table border='1' cellpadding='4'><tr><th>{_('Distributor')}</th><th>Code</th><th>Tally company</th><th>Checked</th><th>Differences</th></tr>{rows}</table>")
	if failing:
		rows = "".join(
			f"<tr><td>{frappe.utils.escape_html(d.distributor_name)}</td><td>{d.name}</td>"
			f"<td>{format_datetime(d.last_run_at) if d.last_run_at else ''}</td>"
			f"<td>{frappe.utils.escape_html(d.last_run_problem or '')}</td></tr>"
			for d in failing)
		parts.append("<h3>Agent reports a problem</h3>"
			f"<table border='1' cellpadding='4'><tr><th>{_('Distributor')}</th><th>Code</th><th>Last run</th><th>Problem</th></tr>{rows}</table>")
	if stale:
		rows = "".join(
			f"<tr><td>{frappe.utils.escape_html(d.distributor_name)}</td><td>{d.name}</td>"
			f"<td>{format_datetime(d.last_seen_at) if d.last_seen_at else 'never'}</td></tr>"
			for d in stale)
		parts.append(f"<h3>No data for more than {hours} hours</h3>"
			f"<table border='1' cellpadding='4'><tr><th>{_('Distributor')}</th><th>Code</th><th>Last data</th></tr>{rows}</table>")
	if negative:
		rows = "".join(
			f"<tr><td>{n.distributor}</td><td>{frappe.utils.escape_html(n.tally_item_name)}</td>"
			f"<td>{n.item_code or '(unmapped)'}</td><td style='color:#b00'>{n.closing_qty:g}</td><td>{n.as_of_date}</td></tr>"
			for n in negative)
		parts.append("<h3>Negative closing stock</h3>"
			f"<table border='1' cellpadding='4'><tr><th>{_('Distributor')}</th><th>Item in Tally</th><th>Item</th><th>Closing</th><th>As of</th></tr>{rows}</table>")
	return "".join(parts)


@frappe.whitelist()
def send_test_alert():
	"""SSV Settings → Send Test Alert: today's alert, sent at once, to prove the e-mail path."""
	frappe.only_for("System Manager")
	to = recipients()
	if not to:
		frappe.throw("Fill in Send Alerts To first.")
	hours = frappe.db.get_single_value("SSV Settings", "stale_after_hours") or 24
	failing = failing_distributors()
	stale = [d for d in stale_distributors(hours) if d.name not in {f.name for f in failing}]
	negative = negative_stock() if frappe.db.get_single_value("SSV Settings", "alert_negative_stock") else []
	body = build_message(stale, negative, hours, failing, mismatched_companies()) or "<p>Nothing to report today: all distributors are fine.</p>"
	try:
		frappe.sendmail(recipients=to, subject="SSV channel alerts: test", now=True,
			message="<p>This is a test of the daily SSV alert. Today's alert would read:</p>" + body)
	except Exception as e:
		frappe.throw(f"The e-mail could not be sent: {e}. Check the site's default outgoing Email Account.")
	return to


def send_daily_alerts():
	to = recipients()
	if not to:
		return
	hours = frappe.db.get_single_value("SSV Settings", "stale_after_hours") or 24
	failing = failing_distributors()
	failing_names = {d.name for d in failing}
	stale = [d for d in stale_distributors(hours) if d.name not in failing_names]
	negative = negative_stock() if frappe.db.get_single_value("SSV Settings", "alert_negative_stock") else []
	mismatched = mismatched_companies()
	if not stale and not negative and not failing and not mismatched:
		return
	frappe.sendmail(
		recipients=to,
		subject=f"SSV channel alerts: {len(failing)} failing, {len(stale)} silent distributor(s), "
		f"{len(mismatched)} with differing totals, {len(negative)} negative stock line(s)",
		message=build_message(stale, negative, hours, failing, mismatched),
	)
