# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Wording for a site one level down the chain. On a distributor's own site the
"distributors" sending data are its dealers, and their buyers are customers, not
retailers. Every label of this app goes through Frappe's translation, so this
writes site translations (language "en") that swap the words everywhere: forms,
lists, reports, charts, the dashboard and the workspace. The data model is the same.

  bench --site <site> execute ssv_channel.partner_labels.apply --kwargs "{'partner': 'Dealer', 'buyer': 'Customer'}"
  bench --site <site> execute ssv_channel.partner_labels.reset
"""

import re

import frappe
from frappe.translate import get_messages_for_app

PARTNER, BUYER = "Distributor", "Retailer"


def relabel(text: str, partner: str = "Dealer", buyer: str = "Customer") -> str:
	"""Swap the two words, keeping singular/plural and capital/lower case."""

	def swap(t, word, new):
		for old, repl in ((word + "s", new + "s"), (word, new)):
			t = re.sub(rf"\b{old}\b", repl, t)
			t = re.sub(rf"\b{old.lower()}\b", repl.lower(), t)
			t = re.sub(rf"\b{old.upper()}\b", repl.upper(), t)
		return t

	return swap(swap(text, PARTNER, partner), BUYER, buyer)


def app_messages() -> set[tuple[str, str | None]]:
	"""(message, context) for every translatable string of this app that names either word."""
	out = set()
	for m in get_messages_for_app("ssv_channel"):
		msg = m[1] if isinstance(m, (list, tuple)) else m
		ctx = m[2] if isinstance(m, (list, tuple)) and len(m) > 2 and isinstance(m[2], str) else None
		if isinstance(msg, str) and re.search(rf"\b({PARTNER}|{BUYER})", msg, re.I):
			out.add((msg, ctx))
	return out


@frappe.whitelist()
def apply(partner: str = "Dealer", buyer: str = "Customer") -> int:
	"""Relabel this site. Re-running with other words replaces the earlier ones."""
	frappe.only_for("System Manager")
	partner, buyer = (partner or "").strip(), (buyer or "").strip()
	if not re.fullmatch(r"[A-Za-z][A-Za-z ]{1,30}", partner) or not re.fullmatch(r"[A-Za-z][A-Za-z ]{1,30}", buyer):
		frappe.throw("Use plain words for both labels, e.g. Dealer and Customer.")
	count = 0
	for msg, ctx in app_messages():
		new = relabel(msg, partner, buyer)
		if new == msg:
			continue
		name = frappe.db.get_value("Translation", {"language": "en", "source_text": msg, "context": ctx or ["is", "not set"]})
		if name:
			frappe.db.set_value("Translation", name, "translated_text", new)
		else:
			frappe.get_doc({"doctype": "Translation", "language": "en", "source_text": msg,
				"translated_text": new, "context": ctx}).insert(ignore_permissions=True)
		count += 1
	frappe.db.set_single_value("SSV Settings", {"partner_label": partner, "buyer_label": buyer})
	frappe.clear_cache()
	return count


@frappe.whitelist()
def reset() -> int:
	"""Back to Distributor / Retailer: remove the translations apply() wrote."""
	frappe.only_for("System Manager")
	count = 0
	for msg, _ctx in app_messages():
		for name in frappe.get_all("Translation", filters={"language": "en", "source_text": msg}, pluck="name"):
			frappe.delete_doc("Translation", name, ignore_permissions=True, force=True)
			count += 1
	frappe.db.set_single_value("SSV Settings", {"partner_label": PARTNER, "buyer_label": BUYER})
	frappe.clear_cache()
	return count
