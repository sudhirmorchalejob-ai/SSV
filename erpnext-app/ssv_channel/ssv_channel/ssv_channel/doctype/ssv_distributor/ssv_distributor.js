// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.ui.form.on("SSV Distributor", {
	setup(frm) {
		frm.set_query("parent_distributor", () => ({ filters: { partner_level: "Distributor", name: ["!=", frm.doc.name || ""] } }));
	},
	refresh(frm) {
		if (frm.is_new()) return;
		show_agent_state(frm);

		if (frm.perm[0] && frm.perm[0].write) {
			frm.add_custom_button(__("Sync Now"), async () => {
				await frm.call("request_sync");
				frappe.show_alert({
					message: __("Sync requested. A running agent starts within about 2 minutes; the result shows here as Last Run."),
					indicator: "blue",
				}, 10);
				frm.reload_doc();
			});
		}

		if (!frappe.user.has_role("System Manager")) return;
		frm.add_custom_button(__("Show Agent Secret"), async () => {
			const r = await frm.call("reveal_agent_secret");
			const site = window.location.origin;
			frappe.msgprint({
				title: __("Agent .env for {0}", [frm.doc.distributor_name]),
				message: `<pre style="user-select: all">MIDDLEWARE_URL=${site}
MIDDLEWARE_BATCHES_PATH=/api/method/ssv_channel.api.batches
MIDDLEWARE_CONFIG_PATH=/api/method/ssv_channel.api.config
DISTRIBUTOR_ID=${frm.doc.distributor_id}
AGENT_SECRET=${r.message}</pre>`,
			});
		}, __("Actions"));

		frm.add_custom_button(__("Delete Channel Data"), () => {
			if (frm.doc.enabled) {
				frappe.msgprint(__("Untick Enabled and save first, so no new data arrives while deleting."));
				return;
			}
			frappe.prompt(
				{ fieldname: "confirm_id", fieldtype: "Data", reqd: 1,
					label: __("Type {0} to delete every bill, stock figure, item and retailer received from this distributor", [frm.doc.name]) },
				async ({ confirm_id }) => {
					const r = await frm.call("delete_channel_data", { confirm_id });
					const n = Object.values(r.message || {}).reduce((a, b) => a + b, 0);
					frappe.show_alert({ message: __("Deleted {0} records. The agent's secret has been replaced.", [n]), indicator: "green" }, 10);
					frm.reload_doc();
				},
				__("Delete channel data"),
				__("Delete"),
			);
		}, __("Actions"));
	},
});

function show_agent_state(frm) {
	const d = frm.doc;
	const ago = (dt) => (dt ? frappe.datetime.comment_when(dt) : __("never"));
	if (!d.last_contact_at && !d.last_seen_at) {
		frm.dashboard.set_headline(__("The agent has not contacted this site yet."), "orange");
		return;
	}
	const pending = d.sync_requested_at && (!d.last_run_at || d.last_run_at < d.sync_requested_at);
	let text = __("Agent {0}, last contact {1}.", [frappe.utils.escape_html(d.agent_version || "?"), ago(d.last_contact_at || d.last_seen_at)]);
	if (d.last_run_status === "Failed") {
		text += " " + __("Last run failed {0}: {1}", [ago(d.last_run_at), frappe.utils.escape_html(d.last_run_problem || "")]);
	} else if (d.last_run_status === "OK") {
		text += " " + __("Last run OK {0}.", [ago(d.last_run_at)]);
	}
	if (pending) text += " " + __("Sync requested {0}, waiting for the agent.", [ago(d.sync_requested_at)]);
	frm.dashboard.set_headline(text, d.last_run_status === "Failed" ? "red" : pending ? "blue" : "green");
}
