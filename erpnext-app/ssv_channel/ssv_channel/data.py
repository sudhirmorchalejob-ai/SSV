# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Data access for the reports: plain SELECTs, then enrichment in Python with the
principal's item classification (Item custom fields), distributor geography
(Territory tree: city › state › zone) and retailer names. Grouping and
arithmetic live in analytics.py.
"""

from collections import defaultdict

import frappe
from frappe.utils import add_days, get_first_day, get_last_day, getdate

from ssv_channel import analytics as A

ITEM_ATTRS = ["item_name", "brand", "item_group", "stock_uom", "ssv_product_line", "ssv_category", "ssv_sub_category",
	"ssv_size", "ssv_size_group", "ssv_size_sort", "ssv_product_class"]


def factor(c):
	"""Conversion Factor of a channel item: the Item's units per Tally unit (1 when unset)."""
	return float((c or {}).get("conversion_factor") or 1)
UNMAPPED = "(unmapped)"


def resolve_period(filters):
	"""from_date / to_date from the filters, defaulting to the current month."""
	f = frappe._dict(filters or {})
	if not f.from_date or not f.to_date:
		f.from_date, f.to_date = A.period_range(f.period or "Current Month", getdate())
	f.from_date, f.to_date = getdate(f.from_date), getdate(f.to_date)
	return f


# ── lookups ─────────────────────────────────────────────────────────────────


def territory_descendants(territory):
	if not territory:
		return None
	lft, rgt = frappe.db.get_value("Territory", territory, ["lft", "rgt"])
	return set(frappe.get_all("Territory", filters={"lft": [">=", lft], "rgt": ["<=", rgt]}, pluck="name"))


def geography():
	"""territory → (city, state, zone), walking up the tree below the root."""
	parents = {t.name: t.parent_territory for t in frappe.get_all("Territory", fields=["name", "parent_territory"])}
	roots = {n for n, p in parents.items() if not p}

	def chain(name):
		out = []
		while name and name not in roots and name not in out:
			out.append(name)
			name = parents.get(name)
		return out

	def geo(name):
		c = chain(name)
		return (c[0] if c else None, c[1] if len(c) > 1 else None, c[2] if len(c) > 2 else None)

	return geo


LEVELS = ("Distributor", "Dealer", "All")


def distributors(filters):
	"""
	{name: row} for enabled senders matching the level, distributor and territory filters.

	Level (default Distributor): Distributor = distributors' own figures (secondary sales);
	Dealer = their dealers' figures (tertiary sales); All = both, for channel stock only,
	as adding the two levels' sales would count the same goods twice. With Level Dealer,
	choosing a distributor selects the dealers that buy from it.
	"""
	level = filters.get("level") or "Distributor"
	if level not in LEVELS:
		frappe.throw(f"Level must be one of {', '.join(LEVELS)}")
	chosen = filters.get("distributor")
	rows = frappe.get_all("SSV Distributor", filters={"enabled": 1},
		fields=["name", "distributor_name", "territory", "share_cost_price", "creation", "partner_level", "parent_distributor"])
	names = {d.name: d.distributor_name for d in rows}
	allowed = territory_descendants(filters.get("territory"))
	geo = geography()
	out = {}
	for d in rows:
		d.partner_level = d.partner_level or "Distributor"
		if level != "All" and d.partner_level != level:
			continue
		if chosen and chosen not in (d.name, d.parent_distributor):
			continue
		if allowed is not None and d.territory not in allowed:
			continue
		d.city, d.state, d.zone = geo(d.territory)
		# The distributor a row rolls up to: itself, or the one a dealer buys from.
		d.parent_name = (names.get(d.parent_distributor) or d.distributor_name) if d.partner_level == "Dealer" else d.distributor_name
		out[d.name] = d
	return out


def item_attributes(item_codes):
	codes = [c for c in set(item_codes) if c]
	if not codes:
		return {}
	meta = frappe.get_meta("Item")
	fields = ["name"] + [f for f in ITEM_ATTRS if f in ("item_name", "brand", "item_group") or meta.has_field(f)]
	return {r.name: r for r in frappe.get_all("Item", filters={"name": ["in", codes]}, fields=fields)}


def channel_items(names=None):
	cond = {"name": ["in", list(names)]} if names is not None else {}
	return {r.name: r for r in frappe.get_all("SSV Channel Item", filters=cond,
		fields=["name", "tally_item_name", "item_code", "mapping_status", "unit", "conversion_factor"])}


def retailers(names):
	names = [n for n in set(names) if n]
	if not names:
		return {}
	return {r.name: r for r in frappe.get_all("SSV Retailer", filters={"name": ["in", names]},
		fields=["name", "ledger_name", "state", "gstin"])}


# ── enrichment ──────────────────────────────────────────────────────────────


def classify(row, ci, items):
	"""Add item classification to a row that has channel_item (and tally_item_name)."""
	c = ci.get(row.get("channel_item")) or {}
	code = c.get("item_code")
	it = items.get(code) or {}
	row["item_code"] = code
	row["item"] = code or (row.get("tally_item_name") or c.get("tally_item_name"))
	row["item_name"] = it.get("item_name") or row.get("tally_item_name") or c.get("tally_item_name")
	# With a conversion factor, quantities are in the Item's own unit.
	row["uom_factor"] = factor(c)
	row["unit"] = (it.get("stock_uom") or c.get("unit")) if row["uom_factor"] != 1 else c.get("unit")
	for key, field in (("brand", "brand"), ("product_line", "ssv_product_line"), ("category", "ssv_category"),
			("sub_category", "ssv_sub_category"), ("size", "ssv_size"), ("size_group", "ssv_size_group"),
			("product_class", "ssv_product_class"), ("item_group", "item_group")):
		row[key] = it.get(field) or (UNMAPPED if not code else "(not set)")
	row["size_sort"] = it.get("ssv_size_sort") or 0
	return row


def place(row, dist):
	d = dist.get(row.get("distributor")) or {}
	row["distributor_name"] = d.get("distributor_name") or row.get("distributor")
	row["parent_name"] = d.get("parent_name") or row["distributor_name"]
	row["partner_level"] = d.get("partner_level") or "Distributor"
	row["city"], row["state"], row["zone"] = d.get("city"), d.get("state"), d.get("zone")
	row["territory"] = d.get("territory")
	return row


# ── voucher lines ───────────────────────────────────────────────────────────


def voucher_lines(filters, from_date, to_date, base_types=None):
	"""Enriched voucher lines in the period for the filtered distributors."""
	dist = distributors(filters)
	if not dist:
		return [], dist
	params = {"from_date": from_date, "to_date": to_date, "dist": tuple(dist)}
	extra = ""
	if base_types:
		extra += " AND v.base_type IN %(base_types)s"
		params["base_types"] = tuple(base_types)
	rows = frappe.db.sql(
		f"""
		SELECT v.name AS voucher, v.distributor, v.voucher_date, v.base_type, v.voucher_type, v.voucher_number,
			v.retailer, v.party_ledger, i.channel_item, i.tally_item_name, i.direction, i.qty, i.amount,
			i.rate, i.is_tracked, i.godown
		FROM `tabSSV Secondary Voucher` v
		JOIN `tabSSV Secondary Voucher Item` i ON i.parent = v.name AND i.parenttype = 'SSV Secondary Voucher'
		WHERE v.is_deleted = 0 AND v.is_cancelled = 0
			AND v.voucher_date BETWEEN %(from_date)s AND %(to_date)s
			AND v.distributor IN %(dist)s {extra}
		""",
		params,
		as_dict=True,
	)
	ci = channel_items({r.channel_item for r in rows if r.channel_item})
	items = item_attributes([c.item_code for c in ci.values()])
	ret = retailers([r.retailer for r in rows])
	out = []
	for r in rows:
		c = ci.get(r.channel_item)
		if c and c.mapping_status == "Ignored":
			continue
		classify(r, ci, items)
		place(r, dist)
		rr = ret.get(r.retailer) or {}
		r["retailer_name"] = rr.get("ledger_name") or r.get("party_ledger") or "(cash / no party)"
		r["retailer_state"] = rr.get("state")
		r["month_key"] = str(r.voucher_date)[:7]
		r["month"] = A.month_label(r.voucher_date)
		r["qty"] = float(r.qty or 0) * r.uom_factor
		r.update(A.measures(r))
		out.append(r)
	return out, dist


MEASURE_TYPES = ["Sales", "Credit Note", "Purchase", "Receipt Note", "Debit Note"]


def use_summary():
	"""False forces every report onto the voucher lines (used by tests and load_test to compare the two paths)."""
	return not frappe.flags.ssv_no_summary and frappe.db.table_exists("SSV Monthly Summary")


def period_lines(filters, from_date, to_date):
	"""
	Rows carrying sale / return / purchase measures for the period, with the same
	enrichment as voucher_lines: SSV Monthly Summary rows for every whole month
	inside the period, voucher lines for the part-months at either end. No
	retailer detail: reports by retailer use voucher_lines.
	"""
	from_date, to_date = getdate(from_date), getdate(to_date)
	first = from_date if from_date.day == 1 else add_days(get_last_day(from_date), 1)
	last = to_date if to_date == get_last_day(to_date) else add_days(get_first_day(to_date), -1)
	if not use_summary() or first > last:
		return voucher_lines(filters, from_date, to_date, base_types=MEASURE_TYPES)

	dist = distributors(filters)
	if not dist:
		return [], dist
	rows = frappe.db.sql(
		"""SELECT distributor, channel_item, month AS voucher_date, sale_qty, sale_value, return_qty, return_value,
			purchase_qty, purchase_value
		FROM `tabSSV Monthly Summary`
		WHERE distributor IN %(dist)s AND month BETWEEN %(first)s AND %(last)s""",
		{"dist": tuple(dist), "first": first, "last": last}, as_dict=True)
	ci = channel_items({r.channel_item for r in rows if r.channel_item})
	items = item_attributes([c.item_code for c in ci.values()])
	out = []
	for r in rows:
		c = ci.get(r.channel_item)
		if c and c.mapping_status == "Ignored":
			continue
		classify(r, ci, items)
		place(r, dist)
		r["retailer"] = None
		r["retailer_name"] = None
		r["month_key"] = str(r.voucher_date)[:7]
		r["month"] = A.month_label(r.voucher_date)
		for k in ("sale_qty", "sale_value", "return_qty", "return_value", "purchase_qty", "purchase_value"):
			r[k] = float(r[k] or 0) * (r.uom_factor if k.endswith("_qty") else 1)
		r["net_qty"] = r.sale_qty - r.return_qty
		r["net_value"] = r.sale_value - r.return_value
		out.append(r)
	# The part-months at either end, from the vouchers.
	if from_date < first:
		out += voucher_lines(filters, from_date, add_days(first, -1), base_types=MEASURE_TYPES)[0]
	if last < to_date:
		out += voucher_lines(filters, add_days(last, 1), to_date, base_types=MEASURE_TYPES)[0]
	return out, dist


def item_filter_ok(row, filters):
	for key in ("item_code", "brand", "product_line", "category"):
		want = filters.get(key)
		if want and row.get(key) != want:
			return False
	return True


# ── stock ───────────────────────────────────────────────────────────────────


def movement_windows(snap_dates, at_dates):
	"""
	Date ranges whose movements decide stock on each of `at_dates`. Stock on a day
	is the latest snapshot on or before it moved forward by the vouchers in
	between (or the first later snapshot moved back), so only movements between
	each day and its nearest snapshot matter. snap_dates: {key: sorted ISO dates}.
	Keys without any snapshot need all their movements; they are returned apart.
	"""
	import bisect

	windows = []
	for q in at_dates:
		q = A._d(q)
		lo = hi = q
		for dates in snap_dates.values():
			i = bisect.bisect_right(dates, q)
			if i:
				lo = min(lo, dates[i - 1])
			elif dates:
				hi = max(hi, dates[0])
		windows.append((lo, hi))
	return windows


def merge_ranges(ranges):
	"""[(lo, hi)] ISO date ranges → the same days as disjoint ranges."""
	out = []
	for lo, hi in sorted(ranges):
		if out and lo <= out[-1][1]:
			out[-1] = (out[-1][0], max(out[-1][1], hi))
		else:
			out.append((lo, hi))
	return out


def stock_book(dist_names, at_dates=None):
	"""
	StockBook keyed by (distributor, channel_item). With at_dates, only the
	movements needed for stock on those days are loaded (see movement_windows);
	without, every movement. at_dates=[] loads snapshots only (enough for rates).
	"""
	if not dist_names:
		return A.StockBook([], []), {}
	params = {"dist": tuple(dist_names)}
	snaps = frappe.db.sql(
		"""SELECT distributor, channel_item, as_of_date, closing_qty, closing_value
		FROM `tabSSV Stock Snapshot` WHERE distributor IN %(dist)s""",
		params, as_dict=True)
	moves_sql = """SELECT v.distributor, i.channel_item, v.voucher_date, v.base_type, i.direction, i.qty, i.is_tracked
		FROM `tabSSV Secondary Voucher` v
		JOIN `tabSSV Secondary Voucher Item` i ON i.parent = v.name AND i.parenttype = 'SSV Secondary Voucher'
		WHERE v.is_deleted = 0 AND v.is_cancelled = 0 AND v.distributor IN %(dist)s"""
	if at_dates is None or not use_summary():
		moves = frappe.db.sql(moves_sql, params, as_dict=True)
	else:
		snap_dates = defaultdict(list)
		for s in snaps:
			snap_dates[(s.distributor, s.channel_item)].append(A._d(s.as_of_date))
		for dates in snap_dates.values():
			dates.sort()
		has_snapshot = """EXISTS (SELECT 1 FROM `tabSSV Stock Snapshot` s
			WHERE s.distributor = v.distributor AND s.channel_item = i.channel_item)"""
		moves = []
		# Windows per distributor (one distributor's late first snapshot must not widen
		# everyone's), merged so no voucher line is loaded twice.
		per_dist = defaultdict(dict)
		for key, dates in snap_dates.items():
			per_dist[key[0]][key] = dates
		for distributor, keys in per_dist.items():
			for lo, hi in merge_ranges(movement_windows(keys, at_dates)):
				moves += frappe.db.sql(moves_sql + f" AND v.distributor = %(one)s AND v.voucher_date BETWEEN %(lo)s AND %(hi)s AND {has_snapshot}",
					{**params, "one": distributor, "lo": lo, "hi": hi}, as_dict=True)
		# Items with movements but no snapshot at all: every movement counts. Found from
		# the channel items first (a few rows), not by testing every voucher line.
		unsnapped = frappe.db.sql_list(
			"""SELECT ci.name FROM `tabSSV Channel Item` ci WHERE ci.distributor IN %(dist)s
			AND NOT EXISTS (SELECT 1 FROM `tabSSV Stock Snapshot` s WHERE s.channel_item = ci.name)""", params)
		if unsnapped:
			moves += frappe.db.sql(moves_sql + " AND i.channel_item IN %(ci)s", {**params, "ci": tuple(unsnapped)}, as_dict=True)
	ci = channel_items({s.channel_item for s in snaps} | {m.channel_item for m in moves})
	f = {name: factor(c) for name, c in ci.items()}  # quantities in the Item's own unit
	book = A.StockBook(
		[{"key": (s.distributor, s.channel_item), "date": s.as_of_date, "qty": float(s.closing_qty or 0) * f.get(s.channel_item, 1),
			"value": s.closing_value} for s in snaps],
		[{"key": (m.distributor, m.channel_item), "date": m.voucher_date, "delta": A.stock_delta(m) * f.get(m.channel_item, 1)} for m in moves],
	)
	return book, ci


def day_before(d):
	return add_days(getdate(d), -1)


def margin_allowed(dist_row):
	return bool(frappe.db.get_single_value("SSV Settings", "show_margin")) and bool(dist_row and dist_row.get("share_cost_price"))
