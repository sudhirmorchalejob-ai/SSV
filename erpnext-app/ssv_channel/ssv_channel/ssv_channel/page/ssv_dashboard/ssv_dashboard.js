// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt
// Sales & stock dashboard (deck slides 14–15). All figures are net sale quantity.

frappe.pages["ssv-dashboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("SSV Dashboard"), single_column: true });

	const distributor = page.add_field({ fieldname: "distributor", label: __("Distributor"), fieldtype: "Link", options: "SSV Distributor", change: () => load() });
	const territory = page.add_field({ fieldname: "territory", label: __("Territory"), fieldtype: "Link", options: "Territory", change: () => load() });
	const level = page.add_field({ fieldname: "level", label: __("Level"), fieldtype: "Select", options: "Distributor\nDealer", default: "Distributor", change: () => load() });
	page.set_secondary_action(__("Refresh"), () => load());

	const $body = $(`
		<div class="ssv-dash">
			<div class="ssv-coverage" style="margin: 4px 0 6px"></div>
			<div class="ssv-summary text-muted" style="margin: 4px 0 16px"></div>
			<div class="row"></div>
		</div>`).appendTo(page.body);
	const $row = $body.find(".row");

	const CHARTS = [
		["quarter", __("A. Quarter-wise comparison (current FY)"), "bar"],
		["zone", __("B. Zone-wise sales"), "percentage"],
		["monthly", __("C. Monthly comparison: this FY vs last FY"), "bar"],
		["categories", __("D. Top 10 categories"), "bar"],
		["this_month", __("E. This month's sales"), "line"],
		["brands", __("F. Top 10 brands"), "bar"],
		["last_15", __("Last 15 days"), "line"],
		["state", __("State-wise sales"), "pie"],
		["last_quarter", __("Last quarter"), "bar"],
		["last_month", __("Last month's sales"), "bar"],
	];
	const slots = {};
	for (const [key, title] of CHARTS) {
		const $col = $(`<div class="col-md-6" style="margin-bottom: 20px">
			<div class="frappe-card" style="padding: 12px 14px">
				<div class="text-muted small" style="font-weight: 600; margin-bottom: 6px">${title}</div>
				<div class="ssv-chart"></div>
			</div></div>`).appendTo($row);
		slots[key] = $col.find(".ssv-chart")[0];
	}

	function draw(key, type, data) {
		const el = slots[key];
		el.innerHTML = "";
		const empty = !data.labels.length || (data.datasets || []).every((d) => d.values.every((v) => !v));
		if (empty) {
			el.innerHTML = `<div class="text-muted small" style="padding: 40px 0; text-align: center">${__("No sales in this period")}</div>`;
			return;
		}
		new frappe.Chart(el, { data, type, height: 240, colors: ["#2490ef", "#f39c12", "#5e64ff", "#29cd42"], axisOptions: { xIsSeries: type === "line" } });
	}

	async function load() {
		const r = await frappe.call({
			method: "ssv_channel.dashboard.get_data",
			args: { distributor: distributor.get_value() || null, territory: territory.get_value() || null, level: level.get_value() || "Distributor" },
		});
		const d = r.message;
		$body.find(".ssv-summary").text(
			__("Financial year {0} · net sale qty {1} · {2} distributors · {3} outlets billed", [
				d.fy, format_number(d.total_net_qty), d.distributors, d.outlets,
			])
		);
		// How complete the figures are: distributors whose data is up to date.
		const c = d.coverage;
		const behind = c.behind.map((b) => `${frappe.utils.escape_html(b.distributor)} (${__(b.status)})`).join(", ");
		$body.find(".ssv-coverage").html(c.total
			? `<span class="indicator-pill ${c.behind.length ? "orange" : "green"}">${__("Data up to date from {0} of {1} distributors", [c.up_to_date, c.total])}</span>` +
			  (behind ? ` <span class="text-muted small">${__("Behind")}: ${behind} · <a href="/app/query-report/SSV Sync Health">${__("Sync Health")}</a></span>` : "")
			: "");
		const single = (x, name) => ({ labels: x.labels, datasets: [{ name, values: x.values }] });
		for (const [key, , type] of CHARTS) {
			if (key === "monthly") {
				draw(key, type, {
					labels: d.monthly.labels,
					datasets: [
						{ name: __("Last year"), values: d.monthly.previous },
						{ name: __("Current year"), values: d.monthly.current },
					],
				});
			} else {
				draw(key, type, single(d[key], __("Net sale qty")));
			}
		}
	}

	load();
};
