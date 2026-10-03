# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Endpoints for the SSV connector agent. Guests are allowed because the agent
does not log in: every request is authenticated by its HMAC signature instead
(see ingest.verify_request).

  POST /api/method/ssv_channel.api.batches    one signed batch
  GET  /api/method/ssv_channel.api.config     this distributor's item rules and agent settings
                                              (sync interval, "Sync now" token)
  POST /api/method/ssv_channel.api.heartbeat  signed run report after every sync

Agent .env for this site (the heartbeat path follows from the batches path):
  MIDDLEWARE_URL=https://<site>
  MIDDLEWARE_BATCHES_PATH=/api/method/ssv_channel.api.batches
  MIDDLEWARE_CONFIG_PATH=/api/method/ssv_channel.api.config
"""

import frappe

from ssv_channel import ingest


def _headers():
	h = frappe.request.headers
	return h.get("X-SSV-Distributor"), h.get("X-SSV-Timestamp"), h.get("X-SSV-Signature")


def _not_set_up():
	"""503 (agent retries later) rather than 4xx (agent gives the rows up) while setup is incomplete."""
	if frappe.db.get_single_value("SSV Settings", "principal_code"):
		return None
	frappe.local.response.http_status_code = 503
	return {"ok": False, "error": "SSV Settings: principal code not set"}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def batches():
	if (pending := _not_set_up()) is not None:
		return pending
	body = frappe.request.get_data() or b""
	distributor = ingest.verify_request(*_headers(), body)
	batch = {}
	try:
		batch = ingest.parse_body(body)
		status, result = ingest.apply_batch(distributor, batch)
	except ingest.Refused as e:
		frappe.db.rollback()
		ingest.log_refused(distributor, batch, str(e))
		status, result = 422, {"ok": False, "error": str(e)}
	except ingest.Deferred as e:
		frappe.db.rollback()
		status, result = 503, {"ok": False, "error": str(e)}
	frappe.local.response.http_status_code = status
	return result


@frappe.whitelist(allow_guest=True, methods=["GET"])
def config():
	if (pending := _not_set_up()) is not None:
		return pending
	distributor = ingest.verify_request(*_headers(), b"")
	ingest.record_contact(distributor)
	frappe.db.commit()  # Frappe does not commit GET requests by itself
	return {**ingest.distributor_rules(distributor), "agent": ingest.agent_settings(distributor)}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def heartbeat():
	body = frappe.request.get_data() or b""
	distributor = ingest.verify_request(*_headers(), body)
	try:
		ingest.apply_heartbeat(distributor, ingest.parse_body(body))
	except ingest.Refused as e:
		frappe.db.rollback()
		frappe.local.response.http_status_code = 422
		return {"ok": False, "error": str(e)}
	return {"ok": True}
