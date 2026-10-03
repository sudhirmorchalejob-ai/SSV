# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt

import secrets

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class SSVDistributor(Document):
	def before_validate(self):
		# Generate a strong agent secret when none was typed in.
		if not self.agent_secret:
			self.agent_secret = secrets.token_urlsafe(32)

	def validate(self):
		seen = set()
		for rule in self.rules:
			key = (rule.rule_type, (rule.tally_value or "").strip())
			if key in seen:
				frappe.throw(_("Row {0}: duplicate rule {1} = {2}").format(rule.idx, *key))
			seen.add(key)
			rule.tally_value = key[1]
		if self.sync_interval_minutes and not 5 <= self.sync_interval_minutes <= 1440:
			frappe.throw(_("Sync Every must be between 5 minutes and 1440 (once a day)."))
		self.partner_level = self.partner_level or "Distributor"
		if self.partner_level == "Distributor":
			self.parent_distributor = None
		else:
			if not self.parent_distributor:
				frappe.throw(_("Set the distributor this dealer buys from."))
			if self.parent_distributor == self.name or (
				frappe.db.get_value("SSV Distributor", self.parent_distributor, "partner_level") or "Distributor") != "Distributor":
				frappe.throw(_("Buys From Distributor must be a distributor, not a dealer."))
			if self.partner_level == "Dealer" and frappe.db.exists("SSV Distributor", {"parent_distributor": self.name}):
				frappe.throw(_("Dealers are linked to this record as their distributor; it cannot become a dealer itself."))

	@frappe.whitelist()
	def request_sync(self):
		"""Sync Now: the agent sees the new timestamp on its next poll (about 2 minutes) and runs."""
		self.check_permission("write")
		now = now_datetime()
		self.db_set("sync_requested_at", now, update_modified=False)
		return now

	@frappe.whitelist()
	def reveal_agent_secret(self):
		"""For setting up the agent's .env. System Managers only."""
		frappe.only_for("System Manager")
		return self.get_password("agent_secret")

	@frappe.whitelist()
	def delete_channel_data(self, confirm_id=None):
		"""When a distributor's consent ends: delete everything received from it, keep this
		record (with its consent date) and a comment saying what was deleted, and give it a new
		secret so the old agent can no longer send. Only for a disabled distributor."""
		frappe.only_for("System Manager")
		if self.enabled:
			frappe.throw(_("Untick Enabled and save first, so no new data arrives while deleting."))
		if confirm_id != self.name:
			frappe.throw(_("Type the Distributor ID {0} to confirm.").format(self.name))

		counts = {}
		# Child rows first, found through their parents.
		for child, parent in (("SSV Secondary Voucher Item", "SSV Secondary Voucher"),
				("SSV Stock Snapshot Godown", "SSV Stock Snapshot")):
			frappe.db.sql(
				f"DELETE c FROM `tab{child}` c JOIN `tab{parent}` p ON p.name = c.parent AND c.parenttype = %s WHERE p.distributor = %s",
				(parent, self.name),
			)
		for doctype in ("SSV Secondary Voucher", "SSV Stock Snapshot", "SSV Monthly Summary", "SSV Channel Item",
				"SSV Retailer", "SSV Tally Company", "SSV Ingest Log"):
			counts[doctype] = frappe.db.count(doctype, {"distributor": self.name})
			frappe.db.delete(doctype, {"distributor": self.name})

		self.db_set({"last_seen_at": None, "retailer_contacts_withheld": 0}, update_modified=False)
		self.agent_secret = secrets.token_urlsafe(32)  # the old agent's secret no longer works
		self.save(ignore_permissions=True)
		summary = ", ".join(f"{n} {dt.replace('SSV ', '')}" for dt, n in counts.items() if n) or _("nothing")
		self.add_comment("Info", _("Channel data deleted by {0}: {1}.").format(frappe.session.user, summary))
		return counts
