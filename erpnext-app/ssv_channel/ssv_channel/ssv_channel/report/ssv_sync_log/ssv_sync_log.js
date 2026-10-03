// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.query_reports["SSV Sync Log"] = {
	filters: [
		{ fieldname: "month", label: __("Any Date In Month"), fieldtype: "Date", reqd: 1, default: frappe.datetime.get_today() },
		{ fieldname: "territory", label: __("Territory"), fieldtype: "Link", options: "Territory" },
	],
	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (data && /^d\d\d$/.test(column.fieldname)) {
			const n = data[column.fieldname];
			value = n ? `<span style="color: var(--green-600); font-weight: 600">${n}</span>` : `<span style="color: var(--gray-400)">0</span>`;
		}
		return value;
	},
};
