# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Report arithmetic, kept free of Frappe so it can be unit-tested anywhere
(python -m unittest discover -s ssv_channel/tests -p "test_analytics*.py").

Stock position
--------------
The agent sends Tally's own closing stock per item (snapshots) and every stock
voucher since the company started. Stock on any date is the nearest snapshot
moved forwards or backwards by the vouchers in between, so one snapshot plus
the synced vouchers gives the whole history. Tally's snapshot is authoritative;
vouchers only explain the path to it.

What moves stock
----------------
Every stock voucher line moves stock in its direction (in = +qty, out = −qty)
except: deleted or cancelled vouchers, Physical Stock (it sets a count rather
than moving goods), and invoice lines against a delivery / receipt note
("tracked"), where the note already moved the goods.

Sales, returns, purchases
-------------------------
  sale      Sales, goods out (tracked or not: the invoice is the sale)
  return    Credit Note, goods in
  purchase  Purchase goods in (untracked) + Receipt Note goods in,
            less Debit Note goods out (purchase returns)
"""

from __future__ import annotations

import bisect
import datetime as _dt
from collections import OrderedDict, defaultdict

SALE, RETURN = "Sales", "Credit Note"
NO_STOCK_EFFECT = {"Physical Stock"}


def _d(v) -> str:
	"""Normalise a date/datetime/string to 'YYYY-MM-DD'."""
	if isinstance(v, (_dt.date, _dt.datetime)):
		return v.strftime("%Y-%m-%d")
	return str(v)[:10]


# ── line classification ─────────────────────────────────────────────────────


NOTES = {"Delivery Note", "Receipt Note"}


def stock_delta(line) -> float:
	"""Signed quantity this line moves (0 if it does not move stock).

	A tracking number on an invoice line means the goods moved on the note it
	points to. The note itself also carries its own tracking number in Tally,
	and it always moves stock.
	"""
	bt = line.get("base_type")
	if bt in NO_STOCK_EFFECT or (line.get("is_tracked") and bt not in NOTES):
		return 0.0
	qty = float(line.get("qty") or 0)
	return qty if line.get("direction") == "in" else -qty


def measures(line) -> dict:
	"""Sale / return / purchase quantities and values for one line."""
	bt, dirn = line.get("base_type"), line.get("direction")
	qty, amt = float(line.get("qty") or 0), float(line.get("amount") or 0)
	out = {"sale_qty": 0.0, "sale_value": 0.0, "return_qty": 0.0, "return_value": 0.0, "purchase_qty": 0.0, "purchase_value": 0.0}
	if bt == SALE and dirn == "out":
		out["sale_qty"], out["sale_value"] = qty, amt
	elif bt == RETURN and dirn == "in":
		out["return_qty"], out["return_value"] = qty, amt
	elif bt == "Purchase" and dirn == "in" and not line.get("is_tracked"):
		out["purchase_qty"], out["purchase_value"] = qty, amt
	elif bt == "Receipt Note" and dirn == "in":
		out["purchase_qty"], out["purchase_value"] = qty, amt
	elif bt == "Debit Note" and dirn == "out":
		out["purchase_qty"], out["purchase_value"] = -qty, -amt
	out["net_qty"] = out["sale_qty"] - out["return_qty"]
	out["net_value"] = out["sale_value"] - out["return_value"]
	return out


# ── stock position ──────────────────────────────────────────────────────────


class StockBook:
	"""
	snapshots: iterable of {key, date, qty, value}
	movements: iterable of {key, date, delta}
	key is any hashable, e.g. (distributor, channel_item).
	"""

	def __init__(self, snapshots, movements):
		self.snaps = defaultdict(list)
		for s in snapshots:
			self.snaps[s["key"]].append((_d(s["date"]), float(s["qty"] or 0), float(s.get("value") or 0)))
		for k in self.snaps:
			self.snaps[k].sort()
		per_day = defaultdict(lambda: defaultdict(float))
		for m in movements:
			if m["delta"]:
				per_day[m["key"]][_d(m["date"])] += float(m["delta"])
		self.moves = {}
		for k, days in per_day.items():
			dates = sorted(days)
			running, cum = 0.0, []
			for day in dates:
				running += days[day]
				cum.append(running)
			self.moves[k] = (dates, cum)

	def keys(self):
		return set(self.snaps) | set(self.moves)

	def _cum(self, key, day) -> float:
		"""Sum of movements dated on or before `day`."""
		dates, cum = self.moves.get(key, ([], []))
		i = bisect.bisect_right(dates, day)
		return cum[i - 1] if i else 0.0

	def qty_at(self, key, day):
		"""Closing quantity at the end of `day`, and how it was derived."""
		day = _d(day)
		snaps = self.snaps.get(key, [])
		before = [s for s in snaps if s[0] <= day]
		if before:
			sd, sq, _ = before[-1]
			return sq + self._cum(key, day) - self._cum(key, sd), "snapshot"
		if snaps:
			sd, sq, _ = snaps[0]
			return sq - (self._cum(key, sd) - self._cum(key, day)), "snapshot"
		return self._cum(key, day), "movements only"

	def rate_at(self, key, day) -> float:
		"""Valuation rate from the nearest snapshot with stock (earlier preferred)."""
		day = _d(day)
		snaps = [s for s in self.snaps.get(key, []) if s[1]]
		if not snaps:
			return 0.0
		before = [s for s in snaps if s[0] <= day]
		sd, sq, sv = before[-1] if before else snaps[0]
		return sv / sq if sq else 0.0

	def value_at(self, key, day) -> float:
		qty, _ = self.qty_at(key, day)
		return qty * self.rate_at(key, day)


def stock_turn(opening, closing, net_sale):
	"""Net sale over average stock; None when there is no stock to turn."""
	avg = (float(opening or 0) + float(closing or 0)) / 2
	return round(net_sale / avg, 2) if avg > 0 else None


# ── periods (deck presets) ──────────────────────────────────────────────────


def fy_start(day: _dt.date, start_month=4) -> _dt.date:
	return _dt.date(day.year if day.month >= start_month else day.year - 1, start_month, 1)


def period_range(preset: str, today: _dt.date, start_month=4):
	"""(from, to) dates for the deck's period presets. Weeks run Sunday–Saturday."""
	if preset == "Current Financial Year":
		s = fy_start(today, start_month)
		return s, _dt.date(s.year + 1, s.month, 1) - _dt.timedelta(days=1)
	if preset in ("Current Quarter", "Last Quarter"):
		s = fy_start(today, start_month)
		q = ((today.year - s.year) * 12 + today.month - s.month) // 3
		if preset == "Last Quarter":
			q -= 1
		start = _add_months(s, 3 * q)
		return start, _add_months(start, 3) - _dt.timedelta(days=1)
	if preset == "Current Month":
		s = today.replace(day=1)
		return s, _add_months(s, 1) - _dt.timedelta(days=1)
	if preset == "Last Month":
		s = _add_months(today.replace(day=1), -1)
		return s, today.replace(day=1) - _dt.timedelta(days=1)
	if preset in ("Current Week", "Last Week"):
		start = today - _dt.timedelta(days=(today.weekday() + 1) % 7)  # back to Sunday
		if preset == "Last Week":
			start -= _dt.timedelta(days=7)
		return start, start + _dt.timedelta(days=6)
	if preset == "Last 15 Days":
		return today - _dt.timedelta(days=14), today
	raise ValueError(f"unknown period {preset!r}")


def _add_months(d: _dt.date, n: int) -> _dt.date:
	m = d.month - 1 + n
	return _dt.date(d.year + m // 12, m % 12 + 1, 1)


def month_label(day) -> str:
	return _dt.date.fromisoformat(_d(day)).strftime("%b %Y")


# ── grouping ────────────────────────────────────────────────────────────────


def tree(rows, dims, sum_keys, label_key="label", leaf_extra=None):
	"""
	Nested sub-totals for Frappe's tree report view.

	rows: flat dicts carrying every dim in `dims` and every key in `sum_keys`
	      (sum_keys may include dynamic pivot keys). Returns rows with
	      id / parent / indent / label, one level per dim, totals at every level.
	leaf_extra(first_row) → dict of extra fields for the deepest level.
	"""
	root = OrderedDict()
	for r in rows:
		node = root
		for depth, dim in enumerate(dims):
			key = r.get(dim) if r.get(dim) not in (None, "") else "(not set)"
			if key not in node:
				node[key] = {"sums": defaultdict(float), "children": OrderedDict(), "first": r}
			for k in sum_keys:
				node[key]["sums"][k] += float(r.get(k) or 0)
			node = node[key]["children"]

	out = []

	def walk(node, parent, depth):
		for key in sorted(node, key=lambda x: str(x).lower()):
			entry = node[key]
			rid = f"{parent}/{key}" if parent else str(key)
			row = {"id": rid, "parent": parent, "indent": depth, label_key: key, dims[depth]: key}
			row.update(entry["sums"])
			if depth == len(dims) - 1 and leaf_extra:
				row.update(leaf_extra(entry["first"]))
			out.append(row)
			walk(entry["children"], rid, depth + 1)

	walk(root, None, 0)
	return out


GRAND_TOTAL_ID = "__grand_total__"


def grand_total(data, sum_keys, label="Grand Total", label_key="label"):
	"""
	The deck's first row: sums of the top-level rows of a tree(). It has no
	children, so the tree view shows it as a single line above everything else.
	"""
	row = {"id": GRAND_TOTAL_ID, "parent": None, "indent": 0, label_key: label, "is_total": 1}
	for k in sum_keys:
		row[k] = sum(float(r.get(k) or 0) for r in data if (r.get("indent") or 0) == 0)
	return row


def pivot_keys(rows, col_dim, order=None):
	"""Distinct column values, in `order` if given, else sorted."""
	vals = {r.get(col_dim) or "(not set)" for r in rows}
	if order:
		return [v for v in order if v in vals] + sorted(v for v in vals if v not in order)
	return sorted(vals, key=lambda x: str(x).lower())


def spread(rows, col_dim, value_keys):
	"""
	Copy each row's measures into '<column>::<measure>' keys (plus 'total::<measure>')
	so that tree() can sum them per column.
	"""
	out = []
	for r in rows:
		r = dict(r)
		col = r.get(col_dim) or "(not set)"
		for k in value_keys:
			r[f"{col}::{k}"] = r.get(k, 0)
			r[f"total::{k}"] = r.get(k, 0)
		out.append(r)
	return out
