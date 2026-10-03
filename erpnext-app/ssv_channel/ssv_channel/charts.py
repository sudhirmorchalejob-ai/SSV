# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Charts for the script reports, in Frappe's chart format (the 4th value a report's
execute() returns). Built from the report's own rows, so a chart always shows
the same figures as the table under it. Pure functions: no database access.
"""

MAX_BARS = 12
MAX_SERIES = 8


def _short(label, n=24):
	label = str(label if label is not None else "")
	return label if len(label) <= n else label[: n - 1] + "…"


def level(data, indent=0):
	"""Rows at one level of a tree report (0 = top), without the Grand Total row."""
	return [r for r in data if (r.get("indent") or 0) == indent and not r.get("is_total")]


def _top(rows, key, limit):
	return sorted(rows, key=lambda r: abs(r.get(key) or 0), reverse=True)[:limit]


def bars(rows, series, sort_key=None, limit=MAX_BARS, chart_type="bar", fieldtype=None):
	"""One bar group per row (largest first), one dataset per (fieldname, name) in series."""
	if not rows:
		return None
	rows = _top(rows, sort_key or series[0][0], limit)
	if not any(r.get(f) for r in rows for f, _n in series):
		return None
	chart = {
		"data": {
			"labels": [_short(r.get("label")) for r in rows],
			"datasets": [{"name": name, "values": [round(r.get(f) or 0, 2) for r in rows]} for f, name in series],
		},
		"type": chart_type,
	}
	if fieldtype:
		chart["fieldtype"] = fieldtype
	return chart


def over_columns(rows, columns, measure, total_key, as_line=False, limit=MAX_SERIES, fieldtype=None):
	"""
	A pivot's columns along the x-axis (e.g. months), one dataset per row, for the
	`limit` largest rows by `total_key`. Line chart for time, bar chart otherwise.
	"""
	if not rows or not columns:
		return None
	rows = _top(rows, total_key, limit)
	datasets = [{"name": _short(r.get("label"), 30), "values": [round(r.get(f"{c}::{measure}") or 0, 2) for c in columns]}
		for r in rows]
	if not any(v for d in datasets for v in d["values"]):
		return None
	chart = {"data": {"labels": [_short(c, 14) for c in columns], "datasets": datasets},
		"type": "line" if as_line else "bar"}
	if not as_line and len(datasets) > 1:
		chart["barOptions"] = {"stacked": 1}
	if fieldtype:
		chart["fieldtype"] = fieldtype
	return chart


def counts(labels_values, chart_type="donut"):
	"""{label: count} → a pie / donut chart; None when every count is zero."""
	items = [(k, v) for k, v in labels_values.items() if v]
	if not items:
		return None
	return {"data": {"labels": [k for k, _v in items], "datasets": [{"name": "Count", "values": [v for _k, v in items]}]},
		"type": chart_type}
