// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.ui.form.on("SSV Distributor", {
	setup(frm) {
		frm.set_query("parent_distributor", () => ({ filters: { partner_level: "Distributor", name: ["!=", frm.doc.name || ""] } }));
	},
	refresh(frm) {
		if (frm.is_new()) return;
		show_agent_state(frm);
		show_retailers(frm);

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

// Retailers section: who this distributor bills, and what its bills show (ssv_channel.retailers).
const RETAILER_ROWS_SHOWN = 50;

async function show_retailers(frm) {
	const field = frm.fields_dict.retailers_html;
	if (!field) return;
	const name = frm.doc.name;
	field.$wrapper.html(`<div class="text-muted small">${__("Loading retailers…")}</div>`);
	let r;
	try {
		r = await frappe.call({ method: "ssv_channel.retailers.distributor_retailers", args: { distributor: name } });
	} catch (e) {
		field.$wrapper.html(`<div class="text-muted small">${__("Retailers could not be loaded.")}</div>`);
		return;
	}
	if (frm.doc.name !== name) return; // the user moved to another distributor meanwhile
	const { summary: s, retailers } = r.message;
	const esc = frappe.utils.escape_html;
	const date = (d) => (d ? frappe.datetime.str_to_user(d) : "—");
	const ago = (d) => (d ? frappe.datetime.comment_when(d) : __("never"));
	const pill = (text, colour) => `<span class="indicator-pill ${colour}">${esc(__(text))}</span>`;
	const syncColour = (st) => (st === "OK" ? "green" : st === "Stale" ? "orange" : st ? "red" : "gray");

	const stat = (label, value) => `<div style="min-width: 110px">
		<div class="text-muted small">${label}</div><div style="font-size: 16px; font-weight: 600">${value}</div></div>`;
	const header = `<div class="flex flex-wrap" style="gap: 18px 28px; margin-bottom: 12px">
		${stat(__("Total Retailers"), format_number(s.total, null, 0))}
		${stat(__("Active"), format_number(s.active, null, 0))}
		${stat(__("Inactive"), format_number(s.inactive, null, 0))}
		${stat(__("Transactions"), format_number(s.transactions, null, 0))}
		${stat(__("Last Activity"), date(s.last_activity))}
		${stat(__("Last Sync"), `${ago(s.last_sync)} ${s.sync_status ? pill(s.sync_status, syncColour(s.sync_status)) : ""}`)}
	</div>`;

	const body = retailers.slice(0, RETAILER_ROWS_SHOWN).map((x) => `<tr>
		<td><a href="/app/ssv-retailer/${encodeURIComponent(x.name)}">${esc(x.retailer_id || x.name)}</a></td>
		<td>${esc(x.ledger_name)}</td>
		<td>${esc(x.city || x.state || "")}</td>
		<td>${esc([x.contact_person, x.mobile || x.phone].filter(Boolean).join(" · "))}</td>
		<td>${pill(x.status, x.status === "Active" ? "green" : "gray")}</td>
		<td>${date(x.last_activity)}</td>
		<td>${x.transactions ? pill("Receiving", "green") : pill("No bills yet", "gray")}</td>
		<td>${ago(x.last_sync)}</td>
		<td class="text-right">${format_number(x.transactions, null, 0)}</td>
	</tr>`).join("");
	const table = retailers.length
		? `<div class="table-responsive"><table class="table table-bordered table-sm" style="margin-bottom: 8px">
			<thead><tr>
				<th>${__("Retailer ID")}</th><th>${__("Retailer Name")}</th><th>${__("City")}</th><th>${__("Contact")}</th>
				<th>${__("Status")}</th><th>${__("Last Activity")}</th><th>${__("Data Received")}</th>
				<th>${__("Last Sync")}</th><th class="text-right">${__("Transactions")}</th>
			</tr></thead><tbody>${body}</tbody></table></div>`
		: `<p class="text-muted">${__("No retailers yet. They appear with this distributor's first bills, or add one by hand.")}</p>`;
	const more = retailers.length > RETAILER_ROWS_SHOWN
		? `<p class="text-muted small">${__("Showing {0} of {1}.", [RETAILER_ROWS_SHOWN, retailers.length])}</p>` : "";
	const $actions = $(`<div class="flex" style="gap: 8px">
		<button class="btn btn-xs btn-default ssv-open-report">${__("Open in SSV Retailers")}</button>
		${frappe.model.can_create("SSV Retailer") ? `<button class="btn btn-xs btn-default ssv-add-retailer">${__("Add Retailer")}</button>` : ""}
	</div>`);
	$actions.find(".ssv-open-report").on("click", () => frappe.set_route("query-report", "SSV Retailers", { distributor: name }));
	$actions.find(".ssv-add-retailer").on("click", () => frappe.new_doc("SSV Retailer", { distributor: name }));
	field.$wrapper.empty().append(header, table, more, $actions);
}
