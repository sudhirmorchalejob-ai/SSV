// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

(() => {
	const PERIODS = ["Current Month", "Current Week", "Last Week", "Last Month", "Current Quarter", "Last Quarter", "Current Financial Year", "Last 15 Days", "Custom"];
	const iso = (d) => frappe.datetime.obj_to_str(d);
	function range(preset) {
		const t = frappe.datetime.str_to_obj(frappe.datetime.get_today());
		const y = t.getFullYear(), m = t.getMonth();
		const fyStart = new Date(m >= 3 ? y : y - 1, 3, 1);
		const addM = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
		const day = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
		switch (preset) {
			case "Current Financial Year": return [fyStart, day(addM(fyStart, 12), -1)];
			case "Current Quarter":
			case "Last Quarter": {
				let q = Math.floor(((y - fyStart.getFullYear()) * 12 + m - 3) / 3);
				if (preset === "Last Quarter") q -= 1;
				const s = addM(fyStart, 3 * q);
				return [s, day(addM(s, 3), -1)];
			}
			case "Current Month": return [new Date(y, m, 1), new Date(y, m + 1, 0)];
			case "Last Month": return [new Date(y, m - 1, 1), new Date(y, m, 0)];
			case "Current Week":
			case "Last Week": {
				let s = day(t, -t.getDay()); // back to Sunday, as in the deck
				if (preset === "Last Week") s = day(s, -7);
				return [s, day(s, 6)];
			}
			case "Last 15 Days": return [day(t, -14), t];
		}
		return null;
	}
	function periodFilters(preset) {
		const [f, t] = range(preset);
		return [
			{
				fieldname: "period", label: __("Period"), fieldtype: "Select", options: PERIODS.join("\n"), default: preset,
				on_change: () => {
					const r = range(frappe.query_report.get_filter_value("period"));
					if (r) frappe.query_report.set_filter_value({ from_date: iso(r[0]), to_date: iso(r[1]) });
				},
			},
			{ fieldname: "from_date", label: __("From"), fieldtype: "Date", reqd: 1, default: iso(f) },
			{ fieldname: "to_date", label: __("To"), fieldtype: "Date", reqd: 1, default: iso(t) },
		];
	}
	const common = [
		{ fieldname: "distributor", label: __("Distributor"), fieldtype: "Link", options: "SSV Distributor" },
		{ fieldname: "level", label: __("Level"), fieldtype: "Select", options: "Distributor\nDealer", default: "Distributor", description: __("Distributor: distributors' own sales and stock. Dealer: their dealers' (tertiary sales).") },
		{ fieldname: "territory", label: __("Territory"), fieldtype: "Link", options: "Territory" },
		{ fieldname: "item_code", label: __("Item"), fieldtype: "Link", options: "Item" },
	];
	const TREE = { tree: true, name_field: "id", parent_field: "parent", initial_depth: 1 };
	function formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (!data) return value;
		if (column.fieldname === "label" && data.indent === 0) value = `<b>${value}</b>`;
		if (data.is_total && column.fieldname !== "label") value = `<b>${value}</b>`;
		if (/closing_qty|opening_qty/.test(column.fieldname) && data[column.fieldname] < 0) {
			value = `<span style="color: var(--red-500)">${value}</span>`;
		}
		return value;
	}

	frappe.query_reports["SSV Bill Register"] = {
		filters: [...periodFilters("Current Month"), ...common, { fieldname: "base_type", label: __("Voucher Type"), fieldtype: "Select", options: "All\nSales\nCredit Note\nPurchase\nDebit Note\nDelivery Note\nReceipt Note\nStock Journal", default: "All" }, { fieldname: "retailer", label: __("Retailer"), fieldtype: "Link", options: "SSV Retailer" }],
		formatter,
	};
})();
