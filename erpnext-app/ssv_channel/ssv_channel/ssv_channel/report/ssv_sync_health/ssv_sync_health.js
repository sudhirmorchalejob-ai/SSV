// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.query_reports["SSV Sync Health"] = {
	filters: [
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", reqd: 1, default: frappe.datetime.add_days(frappe.datetime.get_today(), -7) },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", reqd: 1, default: frappe.datetime.get_today() },
	],
	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (column.fieldname === "status" && data) {
			const colour = data.status === "OK" ? "green" : data.status === "Stale" ? "orange" : "red";
			value = `<span class="indicator-pill ${colour}">${data.status}</span>`;
		}
		if (column.fieldname === "reconcile_status" && data && data.reconcile_status) {
			const colour = data.reconcile_status === "OK" ? "green" : "red";
			value = `<span class="indicator-pill ${colour}">${__(data.reconcile_status)}</span>`;
		}
		return value;
	},
};
