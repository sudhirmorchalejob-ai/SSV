// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.query_reports["SSV Retailers"] = {
	filters: [
		{ fieldname: "retailer", label: __("Retailer ID or Name"), fieldtype: "Data" },
		{ fieldname: "distributor", label: __("Distributor"), fieldtype: "Link", options: "SSV Distributor" },
		{ fieldname: "manufacturer", label: __("Manufacturer"), fieldtype: "Data" },
		{ fieldname: "state", label: __("State"), fieldtype: "Data" },
		{ fieldname: "city", label: __("City"), fieldtype: "Data" },
		{ fieldname: "zone", label: __("Zone"), fieldtype: "Data" },
		{ fieldname: "status", label: __("Status"), fieldtype: "Select", options: "\nActive\nInactive" },
		{ fieldname: "from_date", label: __("Bills From"), fieldtype: "Date" },
		{ fieldname: "to_date", label: __("Bills To"), fieldtype: "Date" },
		{ fieldname: "no_activity_days", label: __("No Bills For (Days)"), fieldtype: "Int" },
	],
	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (!data) return value;
		if (column.fieldname === "retailer_id" && data.name) {
			value = `<a href="/app/ssv-retailer/${encodeURIComponent(data.name)}">${frappe.utils.escape_html(data.retailer_id || data.name)}</a>`;
		}
		if (column.fieldname === "status") {
			value = `<span class="indicator-pill ${data.status === "Active" ? "green" : "gray"}">${__(data.status || "")}</span>`;
		}
		if (column.fieldname === "sync_status" && data.sync_status) {
			const colour = data.sync_status === "OK" ? "green" : data.sync_status === "Stale" ? "orange" : "red";
			value = `<span class="indicator-pill ${colour}">${__(data.sync_status)}</span>`;
		}
		return value;
	},
};
