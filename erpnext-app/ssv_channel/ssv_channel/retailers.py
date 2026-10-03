# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Retailers under each distributor (Manufacturer → Distributor → Retailer → Bill), read-only.

Retailers are the SSV Retailer records the agent's bills create, plus any added by hand.
Only parties billed at least once (Sales or Credit Note) or added by hand are shown, so
suppliers on purchase bills and cash ledgers never appear as retailers.

Every lookup of retailers, distributors and bills goes through frappe.get_list, so role
permissions and any User Permissions on SSV Distributor apply. The figures are then read
for the retailers the user may see.

Quantities are in the distributor's Tally units. Net = sales out − returns in, without
cancelled or deleted bills and without items marked Ignored, as in SSV Retailer Performance.

  ssv_channel.retailers.get_retailers           list with activity (SSV Retailers report)
  ssv_channel.retailers.distributor_retailers   section on the SSV Distributor form
  ssv_channel.retailers.retailer_activity       activity panel on the SSV Retailer form
  ssv_channel.retailers.dashboard_data          SSV Retailer Dashboard page
"""

from collections import Counter

import frappe
from frappe import _
from frappe.utils import add_days, add_months, cint, flt, get_datetime, getdate, now_datetime, today

from ssv_channel.ssv_channel.report.ssv_sync_health.ssv_sync_health import health_status

ROLES = ("System Manager", "Sales Manager", "Sales User")
SALE_TYPES = ("Sales", "Credit Note")
CHUNK = 1000
DEFAULT_INACTIVE_DAYS = 60

RETAILER_FIELDS = [
	"name", "retailer_id", "ledger_name", "status", "source", "distributor", "distributor_name", "manufacturer",
	"tally_company", "contact_person", "mobile", "email", "phone", "address", "city", "state", "zone", "pincode",
	"gstin", "data_sharing_consent", "consent_date", "creation", "modified",
]

# Net quantity and value of one bill line, as SSV Retailer Performance counts them.
NET = """CASE WHEN v.base_type = 'Sales' AND i.direction = 'out' THEN i.{f}
	WHEN v.base_type = 'Credit Note' AND i.direction = 'in' THEN -i.{f} ELSE 0 END"""
NET_QTY, NET_VALUE = NET.format(f="qty"), NET.format(f="amount")
NOT_IGNORED = """NOT EXISTS (SELECT 1 FROM `tabSSV Channel Item` c
	WHERE c.name = i.channel_item AND c.mapping_status = 'Ignored')"""


def _chunks(seq):
	seq = list(seq)
	for i in range(0, len(seq), CHUNK):
		yield tuple(seq[i:i + CHUNK])


def _filters(filters) -> frappe._dict:
	return frappe._dict(frappe.parse_json(filters) if isinstance(filters, str) else (filters or {}))


def _date_sql(f, params) -> str:
	sql = ""
	if f.get("from_date"):
		sql += " AND v.voucher_date >= %(from_date)s"
		params["from_date"] = getdate(f.from_date)
	if f.get("to_date"):
		sql += " AND v.voucher_date <= %(to_date)s"
		params["to_date"] = getdate(f.to_date)
	return sql


# ── lookups ─────────────────────────────────────────────────────────────────


def find_retailers(f) -> list:
	"""SSV Retailer rows the user may read, matching the list filters."""
	cond = {}
	for key in ("distributor", "status", "manufacturer"):
		if f.get(key):
			cond[key] = f[key]
	for key in ("state", "city", "zone"):
		if f.get(key):
			cond[key] = ["like", f"%{f[key].strip()}%"]
	or_filters = None
	if f.get("retailer"):
		text = f.retailer.strip()
		or_filters = {"name": text, "retailer_id": ["like", f"%{text}%"], "ledger_name": ["like", f"%{text}%"]}
	return frappe.get_list("SSV Retailer", filters=cond, or_filters=or_filters, fields=RETAILER_FIELDS,
		order_by="retailer_id asc", limit_page_length=0)


def bill_history(names) -> dict:
	"""{retailer: (last bill date of any kind, ever billed a sale or return)}, all time."""
	out = {}
	for part in _chunks(names):
		for r in frappe.db.sql(
			"""SELECT retailer, MAX(voucher_date) AS last_date, MAX(base_type IN %(types)s) AS billed
			FROM `tabSSV Secondary Voucher` WHERE is_deleted = 0 AND retailer IN %(names)s GROUP BY retailer""",
			{"names": part, "types": SALE_TYPES},
			as_dict=True,
		):
			out[r.retailer] = (r.last_date, bool(cint(r.billed)))
	return out


def activity(names, f=None) -> dict:
	"""{retailer: figures} from its bills, within the filter's date range if any."""
	f = f or frappe._dict()
	stats = {n: frappe._dict(transactions=0, bills=0, returns=0, cancelled=0, active=0, item_count=0,
		net_qty=0.0, net_value=0.0, first_date=None, last_date=None) for n in names}
	params = {"types": SALE_TYPES}
	date_sql = _date_sql(f, params)
	for part in _chunks(names):
		params["names"] = part
		for r in frappe.db.sql(
			f"""SELECT v.retailer, COUNT(*) AS transactions,
				SUM(v.base_type = 'Sales') AS bills, SUM(v.base_type = 'Credit Note') AS returns,
				SUM(v.is_cancelled) AS cancelled, SUM(v.is_cancelled = 0) AS active,
				MIN(v.voucher_date) AS first_date, MAX(v.voucher_date) AS last_date
			FROM `tabSSV Secondary Voucher` v
			WHERE v.is_deleted = 0 AND v.retailer IN %(names)s {date_sql}
			GROUP BY v.retailer""",
			params,
			as_dict=True,
		):
			s = stats[r.retailer]
			for k in ("transactions", "bills", "returns", "cancelled", "active"):
				s[k] = cint(r[k])
			s.first_date, s.last_date = r.first_date, r.last_date
		for r in frappe.db.sql(
			f"""SELECT v.retailer, COUNT(DISTINCT i.channel_item) AS item_count,
				SUM({NET_QTY}) AS net_qty, SUM({NET_VALUE}) AS net_value
			FROM `tabSSV Secondary Voucher` v
			JOIN `tabSSV Secondary Voucher Item` i ON i.parent = v.name AND i.parenttype = 'SSV Secondary Voucher'
			WHERE v.is_deleted = 0 AND v.is_cancelled = 0 AND v.base_type IN %(types)s
				AND v.retailer IN %(names)s AND {NOT_IGNORED} {date_sql}
			GROUP BY v.retailer""",
			params,
			as_dict=True,
		):
			s = stats[r.retailer]
			s.item_count, s.net_qty, s.net_value = cint(r.item_count), flt(r.net_qty), flt(r.net_value)
	return stats


def distributor_sync(names) -> dict:
	"""{distributor: last sync and data status}, for the distributors the user may read."""
	if not names:
		return {}
	allowed = frappe.get_list("SSV Distributor", filters={"name": ["in", list(names)]}, pluck="name", limit_page_length=0)
	if not allowed:
		return {}
	# Read directly: Frappe's list query drops every field whose name contains "_seen" (it is
	# clearing its optional _seen column), so get_list never returns last_seen_at.
	rows = frappe.db.sql(
		"""SELECT name, distributor_name, enabled, last_seen_at, last_ok_run_at, last_run_status, sync_interval_minutes
		FROM `tabSSV Distributor` WHERE name IN %(names)s""",
		{"names": tuple(allowed)},
		as_dict=True,
	)
	now = now_datetime()
	out = {}
	for d in rows:
		times = [get_datetime(t) for t in (d.last_seen_at, d.last_ok_run_at) if t]
		d.last_sync = max(times) if times else None
		d.sync_status = health_status(d, now) if d.enabled else "Disabled"
		out[d.name] = d
	return out


def build_rows(filters=None) -> list:
	"""Retailers matching the filters, each with its activity, last activity and its distributor's last sync."""
	f = _filters(filters)
	retailers = find_retailers(f)
	history = bill_history([r.name for r in retailers])
	# Billed parties, or added by hand: suppliers and cash ledgers are not retailers.
	retailers = [r for r in retailers if r.source == "Manual" or history.get(r.name, (None, False))[1]]
	stats = activity([r.name for r in retailers], f)
	sync = distributor_sync({r.distributor for r in retailers})
	no_activity_days = cint(f.get("no_activity_days"))
	cutoff = getdate(add_days(today(), -no_activity_days)) if no_activity_days else None
	rows = []
	for r in retailers:
		d = sync.get(r.distributor) or {}
		r.update(stats[r.name])
		r.last_activity = history.get(r.name, (None, False))[0]
		r.last_sync, r.sync_status = d.get("last_sync"), d.get("sync_status")
		if cutoff and (r.status != "Active" or (r.last_activity and getdate(r.last_activity) >= cutoff)):
			continue
		rows.append(r)
	return rows


# ── whitelisted ─────────────────────────────────────────────────────────────


@frappe.whitelist()
def get_retailers(filters=None):
	frappe.only_for(ROLES)
	return build_rows(filters)


@frappe.whitelist()
def distributor_retailers(distributor):
	"""Retailer summary and list for one distributor (SSV Distributor form)."""
	frappe.only_for(ROLES)
	frappe.has_permission("SSV Distributor", "read", doc=distributor, throw=True)
	rows = build_rows({"distributor": distributor})
	sync = distributor_sync([distributor]).get(distributor) or {}
	return {
		"distributor": distributor,
		"summary": {
			"total": len(rows),
			"active": sum(r.status == "Active" for r in rows),
			"inactive": sum(r.status != "Active" for r in rows),
			"transactions": sum(r.transactions for r in rows),
			"last_activity": max((r.last_activity for r in rows if r.last_activity), default=None),
			"last_sync": sync.get("last_sync"),
			"sync_status": sync.get("sync_status"),
		},
		"retailers": rows,
	}


@frappe.whitelist()
def retailer_activity(retailer):
	"""Figures, recent bills and monthly sales for one retailer (SSV Retailer form)."""
	frappe.only_for(ROLES)
	doc = frappe.get_doc("SSV Retailer", retailer)
	doc.check_permission("read")
	stats = activity([doc.name])[doc.name]
	sync = distributor_sync([doc.distributor]).get(doc.distributor) or {}
	recent = frappe.get_list("SSV Secondary Voucher", filters={"retailer": doc.name, "is_deleted": 0},
		fields=["name", "voucher_date", "voucher_type", "voucher_number", "total_qty", "total_amount", "is_cancelled"],
		order_by="voucher_date desc, modified desc", limit_page_length=10)
	start = getdate(add_months(today(), -11)).replace(day=1)
	monthly = frappe.db.sql(
		f"""SELECT DATE_FORMAT(v.voucher_date, '%%Y-%%m') AS month, SUM({NET_VALUE}) AS net_value
		FROM `tabSSV Secondary Voucher` v
		JOIN `tabSSV Secondary Voucher Item` i ON i.parent = v.name AND i.parenttype = 'SSV Secondary Voucher'
		WHERE v.retailer = %(r)s AND v.is_deleted = 0 AND v.is_cancelled = 0 AND v.base_type IN %(types)s
			AND v.voucher_date >= %(start)s AND {NOT_IGNORED}
		GROUP BY month ORDER BY month""",
		{"r": doc.name, "types": SALE_TYPES, "start": start},
		as_dict=True,
	)
	return {
		**stats,
		"last_activity": bill_history([doc.name]).get(doc.name, (None, False))[0],
		"last_sync": sync.get("last_sync"),
		"sync_status": sync.get("sync_status"),
		"recent": recent,
		"monthly": {"labels": [m.month for m in monthly], "values": [flt(m.net_value, 2) for m in monthly]},
	}


@frappe.whitelist()
def dashboard_data(filters=None):
	"""Counts, groupings and inactive retailers for the SSV Retailer Dashboard."""
	frappe.only_for(ROLES)
	f = _filters(filters)
	f.from_date = f.get("from_date") or add_months(today(), -12)
	f.to_date = f.get("to_date") or today()
	inactive_days = cint(f.pop("no_activity_days", None)) or DEFAULT_INACTIVE_DAYS
	rows = build_rows(f)
	cutoff = getdate(add_days(today(), -inactive_days))
	quiet = [r for r in rows if r.status == "Active" and (not r.last_activity or getdate(r.last_activity) < cutoff)]
	quiet.sort(key=lambda r: (r.last_activity is not None, r.last_activity or ""))

	def counts(key, limit=None):
		c = Counter((r.get(key) or _("Not set")) for r in rows)
		top = c.most_common(limit)
		return {"labels": [k for k, _n in top], "values": [n for _k, n in top]}

	busiest = sorted((r for r in rows if r.transactions), key=lambda r: -r.transactions)[:10]
	months = Counter()
	billed_in = {}
	params = {"types": SALE_TYPES, "from_date": getdate(f.from_date), "to_date": getdate(f.to_date)}
	for part in _chunks(r.name for r in rows):
		params["names"] = part
		for m in frappe.db.sql(
			"""SELECT DATE_FORMAT(voucher_date, '%%Y-%%m') AS month, COUNT(*) AS bills, COUNT(DISTINCT retailer) AS retailers
			FROM `tabSSV Secondary Voucher`
			WHERE is_deleted = 0 AND is_cancelled = 0 AND base_type IN %(types)s AND retailer IN %(names)s
				AND voucher_date BETWEEN %(from_date)s AND %(to_date)s
			GROUP BY month""",
			params,
			as_dict=True,
		):
			months[m.month] += cint(m.bills)
			billed_in[m.month] = billed_in.get(m.month, 0) + cint(m.retailers)
	month_keys = sorted(months)
	sync = distributor_sync({r.distributor for r in rows})
	return {
		"manufacturer": frappe.db.get_single_value("SSV Settings", "principal_code"),
		"from_date": f.from_date,
		"to_date": f.to_date,
		"inactive_days": inactive_days,
		"totals": {
			"total": len(rows),
			"active": sum(r.status == "Active" for r in rows),
			"inactive": sum(r.status != "Active" for r in rows),
			"billed": sum(1 for r in rows if r.bills or r.returns),
			"quiet": len(quiet),
			"transactions": sum(r.transactions for r in rows),
			"net_value": flt(sum(r.net_value for r in rows), 2),
		},
		"by_distributor": counts("distributor_name"),
		"by_state": counts("state"),
		"by_city": counts("city", 15),
		"busiest": {"labels": [r.ledger_name for r in busiest], "values": [r.transactions for r in busiest]},
		"monthly": {"labels": month_keys, "bills": [months[k] for k in month_keys],
			"retailers": [billed_in[k] for k in month_keys]},
		"sync": [{"distributor": d.name, "distributor_name": d.distributor_name, "last_sync": d.last_sync,
			"sync_status": d.sync_status, "retailers": sum(1 for r in rows if r.distributor == d.name)}
			for d in sorted(sync.values(), key=lambda d: d.name)],
		"quiet": [{k: r.get(k) for k in ("name", "retailer_id", "ledger_name", "distributor_name", "city",
			"last_activity", "transactions")} for r in quiet[:50]],
	}
