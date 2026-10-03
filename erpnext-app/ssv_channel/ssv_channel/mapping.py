# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Suggesting which of your Items an unmapped Tally item is.

Distributors name items their own way: "CEAT Zoom 205/55R16", "Zoom 205-55-16 CEAT
tyre", "ZOOM 205 55 R16". Exact matching (ingest.auto_map) catches only identical
names; everything else lands as Unmapped. For those, score every Item on:

  words     shared words, ignoring order, case and punctuation
  numbers   shared numbers (sizes, pack weights: 205, 55, 16, 100g) — weighted
            highest, because two items of one brand differ mostly in their numbers
  spelling  overall similarity of the two names
  part no   the Tally part number equal to an Item code: a sure match

The best Item at or above THRESHOLD is stored as a suggestion; a person accepts it
(one at a time on the form, or many at once from the list). Nothing is mapped
without a person.
"""

import difflib
import re

THRESHOLD = 0.55
_NUM = re.compile(r"\d+(?:\.\d+)?")


def tokens(name):
	"""Lower-case words and numbers, letters and digits always apart: '205/55R16' → 205, 55, r, 16."""
	return re.findall(r"[a-z]+|\d+(?:\.\d+)?", str(name or "").lower())


def score(tally_name, item_name, part_no=None, item_code=None):
	if part_no and item_code and str(part_no).strip().lower() == str(item_code).strip().lower():
		return 1.0
	a, b = tokens(tally_name), tokens(item_name)
	if not a or not b:
		return 0.0
	words_a, words_b = {t for t in a if not _NUM.fullmatch(t)}, {t for t in b if not _NUM.fullmatch(t)}
	nums_a, nums_b = {t for t in a if _NUM.fullmatch(t)}, {t for t in b if _NUM.fullmatch(t)}
	words = len(words_a & words_b) / len(words_a | words_b) if words_a | words_b else 0.0
	if nums_a or nums_b:
		numbers = len(nums_a & nums_b) / len(nums_a | nums_b)
	else:
		numbers = 1.0  # no numbers on either side: nothing to disagree about
	spelling = difflib.SequenceMatcher(None, " ".join(sorted(a)), " ".join(sorted(b))).ratio()
	s = 0.35 * words + 0.40 * numbers + 0.25 * spelling
	if nums_a and nums_b and nums_a != nums_b:
		s = min(s, 0.5)  # different sizes are different items, however similar the words
	return round(s, 3)


def best_match(tally_name, items, part_no=None):
	"""items: [{name, item_name}] → (item code, score) of the best candidate, or (None, 0)."""
	best, best_score = None, 0.0
	for it in items:
		s = max(score(tally_name, it["item_name"] or it["name"], part_no, it["name"]),
			score(tally_name, it["name"], part_no, it["name"]))
		if s > best_score:
			best, best_score = it["name"], s
	return (best, best_score) if best_score >= THRESHOLD else (None, best_score)


# ── Frappe side (the functions above run without Frappe, for tests) ────────

try:
	import frappe
except ImportError:  # pragma: no cover - pure tests
	frappe = None


def _whitelist(fn):
	return frappe.whitelist()(fn) if frappe else fn


def _candidates():
	if getattr(frappe.local, "ssv_items", None) is None:
		frappe.local.ssv_items = frappe.get_all("Item", filters={"disabled": 0}, fields=["name", "item_name"])
	return frappe.local.ssv_items


def suggest(channel_item):
	"""Store the best suggestion on one Unmapped channel item; returns the suggested Item or None."""
	c = frappe.db.get_value("SSV Channel Item", channel_item, ["tally_item_name", "part_no", "mapping_status"], as_dict=True)
	if not c or c.mapping_status != "Unmapped":
		return None
	code, s = best_match(c.tally_item_name, _candidates(), c.part_no)
	frappe.db.set_value("SSV Channel Item", channel_item,
		{"suggested_item": code, "suggestion_score": round(s * 100, 1) if code else 0}, update_modified=False)
	return code


@_whitelist
def suggest_all():
	"""Refresh suggestions for every Unmapped channel item (after adding Items, for example)."""
	frappe.only_for(("System Manager", "Sales Manager"))
	frappe.local.ssv_items = None
	names = frappe.get_all("SSV Channel Item", filters={"mapping_status": "Unmapped"}, pluck="name")
	found = sum(1 for n in names if suggest(n))
	return {"unmapped": len(names), "suggested": found}


def _item_group(group_path):
	"""Tally's stock group chain (top first, "A > B > C") as nested Item Groups; returns the lowest."""
	parent = "All Item Groups"
	for name in [p.strip() for p in (group_path or "").split(">") if p.strip()][:6]:
		if not frappe.db.exists("Item Group", name):
			frappe.get_doc({"doctype": "Item Group", "item_group_name": name, "parent_item_group": parent,
				"is_group": 1}).insert(ignore_permissions=True)
		parent = name
	return parent


def _uom(unit):
	unit = (unit or "Nos").strip()[:40] or "Nos"
	if not frappe.db.exists("UOM", unit):
		frappe.get_doc({"doctype": "UOM", "uom_name": unit}).insert(ignore_permissions=True)
	return unit


@_whitelist
def create_items(names):
	"""For the selected unmapped channel items, create an Item named as in Tally (in Tally's stock
	group tree), then map every unmapped channel item with that Tally name, from any dealer or
	distributor, and refresh suggestions for the rest. For a site whose catalogue comes from Tally."""
	frappe.only_for(("System Manager", "Sales Manager"))
	if not frappe.has_permission("Item", "create"):
		frappe.throw("You need permission to create Items.")
	if isinstance(names, str):
		names = frappe.parse_json(names)
	gst = frappe.get_meta("Item").has_field("gst_hsn_code")  # India Compliance: Items need an HSN code
	created, mapped, skipped = 0, 0, []
	for n in names:
		c = frappe.db.get_value("SSV Channel Item", n, ["tally_item_name", "group_path", "unit", "hsn_code", "mapping_status"], as_dict=True)
		if not c or c.mapping_status != "Unmapped" or not (c.tally_item_name or "").strip():
			continue
		code = c.tally_item_name.strip()[:140]
		if not frappe.db.exists("Item", code):
			item = {"doctype": "Item", "item_code": code, "item_name": code, "item_group": _item_group(c.group_path),
				"stock_uom": _uom(c.unit), "is_stock_item": 1, "description": code}
			hsn = (c.hsn_code or "").strip()
			if gst and hsn:
				if not frappe.db.exists("GST HSN Code", hsn):
					frappe.get_doc({"doctype": "GST HSN Code", "hsn_code": hsn, "description": code}).insert(ignore_permissions=True)
				item["gst_hsn_code"] = hsn
			try:
				frappe.get_doc(item).insert(ignore_permissions=True)
			except frappe.ValidationError as e:
				frappe.clear_messages()
				skipped.append(f"{code}: {frappe.utils.strip_html(str(e)) or type(e).__name__}")
				continue
			created += 1
		for same in frappe.get_all("SSV Channel Item", filters={"tally_item_name": c.tally_item_name, "mapping_status": "Unmapped"}, pluck="name"):
			doc = frappe.get_doc("SSV Channel Item", same)
			doc.item_code = code
			doc.save(ignore_permissions=True)
			mapped += 1
	frappe.local.ssv_items = None
	for n in frappe.get_all("SSV Channel Item", filters={"mapping_status": "Unmapped"}, pluck="name"):
		suggest(n)
	return {"created": created, "mapped": mapped, "skipped": skipped}


@_whitelist
def accept_suggestions(names):
	"""Map the given channel items to their suggested Items. Past vouchers follow at once."""
	frappe.only_for(("System Manager", "Sales Manager"))
	if isinstance(names, str):
		names = frappe.parse_json(names)
	done = 0
	for n in names:
		doc = frappe.get_doc("SSV Channel Item", n)
		doc.check_permission("write")
		if doc.mapping_status == "Unmapped" and doc.suggested_item:
			doc.item_code = doc.suggested_item
			doc.mapping_status = "Mapped"
			doc.save()
			done += 1
	return {"mapped": done}