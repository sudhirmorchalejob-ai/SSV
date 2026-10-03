// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt
// Retailers under the distributors: how many, where, how active (ssv_channel.retailers.dashboard_data).

frappe.pages["ssv-retailer-dashboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("SSV Retailer Dashboard"), single_column: true });
	const today = frappe.datetime.get_today();
	const fields = {};
	const add = (df) => (fields[df.fieldname] = page.add_field({ ...df, change: () => load() }));
	add({ fieldname: "distributor", label: __("Distributor"), fieldtype: "Link", options: "SSV Distributor" });
	add({ fieldname: "retailer", label: __("Retailer ID or Name"), fieldtype: "Data" });
	add({ fieldname: "state", label: __("State"), fieldtype: "Data" });
	add({ fieldname: "city", label: __("City"), fieldtype: "Data" });
	add({ fieldname: "zone", label: __("Zone"), fieldtype: "Data" });
	add({ fieldname: "status", label: __("Status"), fieldtype: "Select", options: "\nActive\nInactive" });
	add({ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.add_months(today, -12) });
	add({ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: today });
	add({ fieldname: "no_activity_days", label: __("No Bills For (Days)"), fieldtype: "Int", default: 60 });
	page.set_secondary_action(__("Refresh"), () => load());
	page.set_primary_action(__("Retailer List"), () => frappe.set_route("query-report", "SSV Retailers", listFilters()));

	const $body = $(`
		<div class="ssv-retailer-dash">
			<div class="ssv-summary text-muted" style="margin: 4px 0 12px"></div>
			<div class="ssv-cards row" style="margin-bottom: 8px"></div>
			<div class="ssv-charts row"></div>
			<div class="row">
				<div class="col-md-6" style="margin-bottom: 20px"><div class="frappe-card ssv-sync" style="padding: 12px 14px"></div></div>
				<div class="col-md-6" style="margin-bottom: 20px"><div class="frappe-card ssv-quiet" style="padding: 12px 14px"></div></div>
			</div>
		</div>`).appendTo(page.body);

	const CHARTS = [
		["by_distributor", __("Retailers by distributor")],
		["by_state", __("Retailers by state")],
		["by_city", __("Retailers by city (top 15)")],
		["busiest", __("Most transactions (top 10)")],
		["monthly", __("Retailer activity by month")],
	];
	const slots = {};
	for (const [key, title] of CHARTS) {
		const $col = $(`<div class="col-md-6" style="margin-bottom: 20px">
			<div class="frappe-card" style="padding: 12px 14px">
				<div class="text-muted small" style="font-weight: 600; margin-bottom: 6px">${title}</div>
				<div class="ssv-chart"></div>
			</div></div>`).appendTo($body.find(".ssv-charts"));
		slots[key] = $col.find(".ssv-chart")[0];
	}

	function filterValues() {
		const out = {};
		for (const [k, f] of Object.entries(fields)) {
			const v = f.get_value();
			if (v !== null && v !== undefined && v !== "") out[k] = v;
		}
		return out;
	}

	// The list shows every retailer; the dashboard's "no bills for" figure is a separate card.
	function listFilters() {
		const { no_activity_days, ...rest } = filterValues();
		return rest;
	}

	function draw(key, type, data) {
		const el = slots[key];
		el.innerHTML = "";
		const empty = !data.labels.length || (data.datasets || []).every((d) => d.values.every((v) => !v));
		if (empty) {
			el.innerHTML = `<div class="text-muted small" style="padding: 40px 0; text-align: center">${__("No retailers match these filters")}</div>`;
			return;
		}
		new frappe.Chart(el, { data, type, height: 240, colors: ["#2490ef", "#f39c12", "#5e64ff", "#29cd42"], axisOptions: { xIsSeries: type === "line" } });
	}

	const esc = frappe.utils.escape_html;
	const date = (d) => (d ? frappe.datetime.str_to_user(d) : "—");
	const card = (label, value, pill) => `<div class="col-md-2 col-sm-4 col-6" style="margin-bottom: 12px">
		<div class="frappe-card" style="padding: 12px 14px">
			<div class="text-muted small">${label}</div>
			<div style="font-size: 20px; font-weight: 600">${pill ? `<span class="indicator-pill ${pill}">${value}</span>` : value}</div>
		</div></div>`;
	const syncColour = (s) => (s === "OK" ? "green" : s === "Stale" ? "orange" : "red");

	async function load() {
		const r = await frappe.call({ method: "ssv_channel.retailers.dashboard_data", args: { filters: filterValues() } });
		const d = r.message;
		const t = d.totals;
		$body.find(".ssv-summary").text(__("Manufacturer {0} · bills from {1} to {2} · net sales value {3}", [
			d.manufacturer || "—", date(d.from_date), date(d.to_date), format_currency(t.net_value),
		]));
		$body.find(".ssv-cards").html([
			card(__("Total Retailers"), format_number(t.total, null, 0)),
			card(__("Active"), format_number(t.active, null, 0)),
			card(__("Inactive"), format_number(t.inactive, null, 0)),
			card(__("Billed in Period"), format_number(t.billed, null, 0)),
			card(__("No Bills for {0} Days", [d.inactive_days]), format_number(t.quiet, null, 0), t.quiet ? "orange" : null),
			card(__("Transactions"), format_number(t.transactions, null, 0)),
		].join(""));

		const single = (x, name) => ({ labels: x.labels, datasets: [{ name, values: x.values }] });
		draw("by_distributor", "bar", single(d.by_distributor, __("Retailers")));
		draw("by_state", "percentage", single(d.by_state, __("Retailers")));
		draw("by_city", "bar", single(d.by_city, __("Retailers")));
		draw("busiest", "bar", single(d.busiest, __("Transactions")));
		draw("monthly", "line", {
			labels: d.monthly.labels,
			datasets: [{ name: __("Bills"), values: d.monthly.bills }, { name: __("Retailers billed"), values: d.monthly.retailers }],
		});

		const syncRows = d.sync.map((s) => `<tr>
			<td><a href="/app/ssv-distributor/${encodeURIComponent(s.distributor)}">${esc(s.distributor)}</a> ${esc(s.distributor_name || "")}</td>
			<td class="text-right">${format_number(s.retailers, null, 0)}</td>
			<td>${s.last_sync ? frappe.datetime.comment_when(s.last_sync) : __("never")}</td>
			<td><span class="indicator-pill ${syncColour(s.sync_status)}">${esc(__(s.sync_status || ""))}</span></td>
		</tr>`).join("");
		$body.find(".ssv-sync").html(`
			<div class="text-muted small" style="font-weight: 600; margin-bottom: 6px">${__("Last sync per distributor")}</div>
			${d.sync.length
				? `<table class="table table-sm" style="margin: 0"><thead><tr>
					<th>${__("Distributor")}</th><th class="text-right">${__("Retailers")}</th><th>${__("Last Sync")}</th><th>${__("Status")}</th>
				</tr></thead><tbody>${syncRows}</tbody></table>`
				: `<div class="text-muted small">${__("No distributors match these filters")}</div>`}`);

		const quietRows = d.quiet.map((q) => `<tr>
			<td><a href="/app/ssv-retailer/${encodeURIComponent(q.name)}">${esc(q.retailer_id || "")}</a> ${esc(q.ledger_name || "")}</td>
			<td>${esc(q.distributor_name || "")}</td><td>${esc(q.city || "")}</td><td>${date(q.last_activity)}</td>
		</tr>`).join("");
		const more = t.quiet > d.quiet.length
			? `<div class="text-muted small">${__("Showing {0} of {1}.", [d.quiet.length, t.quiet])}</div>` : "";
		$body.find(".ssv-quiet").html(`
			<div class="text-muted small" style="font-weight: 600; margin-bottom: 6px">${__("Active retailers with no bills for {0} days", [d.inactive_days])}</div>
			${d.quiet.length
				? `<table class="table table-sm" style="margin: 0"><thead><tr>
					<th>${__("Retailer")}</th><th>${__("Distributor")}</th><th>${__("City")}</th><th>${__("Last Activity")}</th>
				</tr></thead><tbody>${quietRows}</tbody></table>${more}`
				: `<div class="text-muted small">${__("Every active retailer has billed recently.")}</div>`}`);
	}

	load();
};
