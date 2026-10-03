# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
SSV Monthly Summary: sales, returns, purchases and net stock movement per
distributor, channel item and month, so reports over a year or more read a
few thousand rows instead of every voucher line.

It is never edited: after each voucher batch, ingest rebuilds exactly the
(distributor, month) pairs the batch touched, from the vouchers themselves, with
the same rules as analytics.measures() and analytics.stock_delta(). A rebuild of
one pair is a single GROUP BY over that month's lines, so it cannot drift.

  bench --site <site> execute ssv_channel.summary.rebuild_all      (also runs after migrate if empty)
"""

import frappe
from frappe.utils import get_first_day, get_last_day, getdate

DT = "SSV Monthly Summary"

# Mirrors analytics.measures() / stock_delta(); tests compare the two paths.
_SQL = """
INSERT INTO `tabSSV Monthly Summary`
	(`name`, `creation`, `modified`, `owner`, `modified_by`, `docstatus`, `idx`,
	 `distributor`, `channel_item`, `month`, `sale_qty`, `sale_value`, `return_qty`, `return_value`,
	 `purchase_qty`, `purchase_value`, `stock_delta`, `line_count`)
SELECT
	MD5(CONCAT(v.distributor, '|', i.channel_item, '|', %(month)s)), NOW(), NOW(), 'Administrator', 'Administrator', 0, 0,
	v.distributor, i.channel_item, %(month)s,
	SUM(CASE WHEN v.base_type = 'Sales' AND i.direction = 'out' THEN i.qty ELSE 0 END),
	SUM(CASE WHEN v.base_type = 'Sales' AND i.direction = 'out' THEN i.amount ELSE 0 END),
	SUM(CASE WHEN v.base_type = 'Credit Note' AND i.direction = 'in' THEN i.qty ELSE 0 END),
	SUM(CASE WHEN v.base_type = 'Credit Note' AND i.direction = 'in' THEN i.amount ELSE 0 END),
	SUM(CASE WHEN (v.base_type = 'Purchase' AND i.direction = 'in' AND IFNULL(i.is_tracked, 0) = 0)
			OR (v.base_type = 'Receipt Note' AND i.direction = 'in') THEN i.qty
		WHEN v.base_type = 'Debit Note' AND i.direction = 'out' THEN -i.qty ELSE 0 END),
	SUM(CASE WHEN (v.base_type = 'Purchase' AND i.direction = 'in' AND IFNULL(i.is_tracked, 0) = 0)
			OR (v.base_type = 'Receipt Note' AND i.direction = 'in') THEN i.amount
		WHEN v.base_type = 'Debit Note' AND i.direction = 'out' THEN -i.amount ELSE 0 END),
	SUM(CASE WHEN v.base_type = 'Physical Stock'
			OR (IFNULL(i.is_tracked, 0) = 1 AND v.base_type NOT IN ('Delivery Note', 'Receipt Note')) THEN 0
		WHEN i.direction = 'in' THEN i.qty ELSE -i.qty END),
	COUNT(*)
FROM `tabSSV Secondary Voucher` v
JOIN `tabSSV Secondary Voucher Item` i ON i.parent = v.name AND i.parenttype = 'SSV Secondary Voucher'
WHERE v.distributor = %(distributor)s AND v.voucher_date BETWEEN %(month)s AND %(month_end)s
	AND v.is_deleted = 0 AND v.is_cancelled = 0 AND i.channel_item IS NOT NULL
GROUP BY v.distributor, i.channel_item
"""


def month_of(day):
	return get_first_day(getdate(day))


def rebuild(pairs):
	"""Recompute the summary for each (distributor, month-start) pair."""
	for distributor, month in sorted({(d, month_of(m)) for d, m in pairs if d and m}):
		frappe.db.sql(f"DELETE FROM `tab{DT}` WHERE distributor = %s AND month = %s", (distributor, month))
		frappe.db.sql(_SQL, {"distributor": distributor, "month": month, "month_end": get_last_day(month)})


MONTH = "%Y-%m-01"  # passed as a parameter: a literal '%' in SQL without parameters is not unescaped


def rebuild_all():
	"""Recompute everything, e.g. after an upgrade. One month of one distributor at a time."""
	pairs = frappe.db.sql(
		"""SELECT DISTINCT distributor, DATE_FORMAT(voucher_date, %s) FROM `tabSSV Secondary Voucher`
		WHERE voucher_date IS NOT NULL""", (MONTH,))
	frappe.db.sql(f"DELETE FROM `tab{DT}`")
	rebuild(pairs)
	frappe.db.commit()
	print(f"SSV Monthly Summary rebuilt: {len(pairs)} distributor-months, {frappe.db.count(DT)} rows")


def missing_pairs():
	"""(distributor, month) with live vouchers but no summary rows, e.g. data loaded before the summary existed."""
	return frappe.db.sql(
		"""SELECT DISTINCT v.distributor, DATE_FORMAT(v.voucher_date, %(fmt)s) AS m
		FROM `tabSSV Secondary Voucher` v
		JOIN `tabSSV Secondary Voucher Item` i ON i.parent = v.name AND i.parenttype = 'SSV Secondary Voucher'
		WHERE v.is_deleted = 0 AND v.is_cancelled = 0 AND v.voucher_date IS NOT NULL AND i.channel_item IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM `tabSSV Monthly Summary` s
				WHERE s.distributor = v.distributor AND s.month = DATE_FORMAT(v.voucher_date, %(fmt)s))""",
		{"fmt": MONTH})


def ensure_built():
	"""After migrate: build whatever distributor-months the summary lacks."""
	if not frappe.db.table_exists(DT):
		return
	pairs = missing_pairs()
	if pairs:
		rebuild(pairs)
		frappe.db.commit()
		print(f"SSV Monthly Summary: built {len(pairs)} missing distributor-months")
