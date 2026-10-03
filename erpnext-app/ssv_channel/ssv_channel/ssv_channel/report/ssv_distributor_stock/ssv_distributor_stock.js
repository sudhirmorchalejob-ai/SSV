// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.query_reports["SSV Distributor Stock"] = {
	filters: [
		{ fieldname: "as_of_date", label: __("As Of"), fieldtype: "Date", reqd: 1, default: frappe.datetime.get_today() },
		{ fieldname: "distributor", label: __("Distributor"), fieldtype: "Link", options: "SSV Distributor" },
		{ fieldname: "level", label: __("Level"), fieldtype: "Select", options: "Distributor\nDealer\nAll", default: "Distributor", description: __("Distributor: distributors' own sales and stock. Dealer: their dealers' (tertiary sales). All: both, for total channel stock.") },
		{ fieldname: "territory", label: __("Territory"), fieldtype: "Link", options: "Territory" },
		{ fieldname: "item_code", label: __("Item"), fieldtype: "Link", options: "Item" },
		{ fieldname: "godown_wise", label: __("Godown-wise"), fieldtype: "Check", default: 0 },
		{ fieldname: "godown", label: __("Godown"), fieldtype: "Data", depends_on: "eval:doc.godown_wise" },
	],
	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (column.fieldname === "closing_qty" && data && data.closing_qty < 0) {
			value = `<span style="color: var(--red-500)">${value}</span>`;
		}
		if (column.fieldname === "godown" && data && (data.godown === "Unallocated" || data.godown === "(not reported)")) {
			value = `<span style="color: var(--orange-500)">${value}</span>`;
		}
		return value;
	},
};
