// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.ui.form.on("SSV Retailer", {
	setup(frm) {
		frm.set_query("tally_company", () => ({ filters: { distributor: frm.doc.distributor || "" } }));
	},
	refresh(frm) {
		if (frm.is_new()) {
			frm.set_intro(__("Type the name exactly as the ledger is named in the distributor's Tally. Its first bill then links to this record instead of creating a second one."), "blue");
			return;
		}
		frm.add_custom_button(__("Bills"), () => frappe.set_route("List", "SSV Secondary Voucher", { retailer: frm.doc.name }));
		frm.add_custom_button(__("Sales by Item"), () => {
			const today = frappe.datetime.get_today();
			frappe.set_route("query-report", "SSV Retailer Performance", {
				period: "Custom", from_date: frappe.datetime.add_months(today, -12), to_date: today,
				distributor: frm.doc.distributor, retailer: frm.doc.name,
			});
		});
		show_activity(frm);
	},
	distributor(frm) {
		frm.set_value("tally_company", null);
	},
});

async function show_activity(frm) {
	const field = frm.fields_dict.activity_html;
	const name = frm.doc.name;
	field.$wrapper.html(`<div class="text-muted small">${__("Loading activity…")}</div>`);
	let r;
	try {
		r = await frappe.call({ method: "ssv_channel.retailers.retailer_activity", args: { retailer: name } });
	} catch (e) {
		field.$wrapper.html(`<div class="text-muted small">${__("Activity could not be loaded.")}</div>`);
		return;
	}
	if (frm.doc.name !== name) return;
	const a = r.message;
	const esc = frappe.utils.escape_html;
	const date = (d) => (d ? frappe.datetime.str_to_user(d) : "—");
	const n = (v) => format_number(v, null, 0);
	const stat = (label, value) => `<div style="min-width: 120px">
		<div class="text-muted small">${label}</div><div style="font-size: 16px; font-weight: 600">${value}</div></div>`;
	const syncColour = a.sync_status === "OK" ? "green" : a.sync_status === "Stale" ? "orange" : a.sync_status ? "red" : "gray";
	const received = a.transactions
		? `<span class="indicator-pill green">${__("Receiving")}</span>` : `<span class="indicator-pill gray">${__("No bills yet")}</span>`;
	const stats = `<div class="flex flex-wrap" style="gap: 18px 28px; margin-bottom: 14px">
		${stat(__("Transactions"), n(a.transactions))}
		${stat(__("Bills"), n(a.bills))}
		${stat(__("Returns"), n(a.returns))}
		${stat(__("Active"), n(a.active))}
		${stat(__("Cancelled"), n(a.cancelled))}
		${stat(__("Items"), n(a.item_count))}
		${stat(__("Net Qty"), format_number(a.net_qty, null, 2))}
		${stat(__("Net Sales Value"), format_currency(a.net_value))}
		${stat(__("Last Transaction"), date(a.last_activity))}
		${stat(__("Last Sync"), `${a.last_sync ? frappe.datetime.comment_when(a.last_sync) : __("never")}
			${a.sync_status ? `<span class="indicator-pill ${syncColour}">${esc(__(a.sync_status))}</span>` : ""}`)}
		${stat(__("Data Received"), received)}
	</div>`;
	const rows = a.recent.map((v) => `<tr>
		<td><a href="/app/ssv-secondary-voucher/${encodeURIComponent(v.name)}">${esc(v.voucher_number || v.name)}</a></td>
		<td>${date(v.voucher_date)}</td><td>${esc(v.voucher_type || "")}</td>
		<td class="text-right">${format_number(v.total_qty, null, 2)}</td>
		<td class="text-right">${format_currency(v.total_amount)}</td>
		<td>${v.is_cancelled ? `<span class="indicator-pill red">${__("Cancelled")}</span>` : ""}</td>
	</tr>`).join("");
	const recent = a.recent.length
		? `<div class="text-muted small" style="font-weight: 600; margin-bottom: 6px">${__("Latest bills")}</div>
			<div class="table-responsive"><table class="table table-bordered table-sm">
			<thead><tr><th>${__("Bill No.")}</th><th>${__("Date")}</th><th>${__("Type")}</th>
				<th class="text-right">${__("Qty")}</th><th class="text-right">${__("Amount")}</th><th></th></tr></thead>
			<tbody>${rows}</tbody></table></div>`
		: `<p class="text-muted">${__("No bills from this retailer yet.")}</p>`;
	const $chart = $(`<div style="margin-top: 8px"></div>`);
	field.$wrapper.empty().append(stats, recent, $chart);
	if (a.monthly.labels.length) {
		$chart.before(`<div class="text-muted small" style="font-weight: 600">${__("Net sales value, last 12 months")}</div>`);
		new frappe.Chart($chart[0], {
			type: "bar", height: 200, colors: ["#2490ef"],
			data: { labels: a.monthly.labels, datasets: [{ name: __("Net Sales Value"), values: a.monthly.values }] },
		});
	}
}
