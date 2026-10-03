// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

const MOM = "Month on Month (Retailer × Item)";

frappe.query_reports["SSV Secondary Sales"] = {
	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		return data && data.is_total ? `<b>${value}</b>` : value;
	},
	filters: [
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", reqd: 1, default: frappe.datetime.month_start() },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", reqd: 1, default: frappe.datetime.get_today() },
		{ fieldname: "group_by", label: __("Group By"), fieldtype: "Select", default: "Distributor and Item",
		  options: ["Distributor and Item", "Item", "Distributor", "Retailer", "Retailer and Item", MOM].join("\n"),
		  description: __("{0}: one row per retailer, item and distributor with the item's classification and each month's quantity and value (deck slide 28)", [MOM]) },
		{ fieldname: "distributor", label: __("Distributor"), fieldtype: "Link", options: "SSV Distributor" },
		{ fieldname: "level", label: __("Level"), fieldtype: "Select", options: "Distributor\nDealer", default: "Distributor", description: __("Distributor: distributors' own sales and stock. Dealer: their dealers' (tertiary sales).") },
		{ fieldname: "territory", label: __("Territory"), fieldtype: "Link", options: "Territory" },
		{ fieldname: "item_code", label: __("Item"), fieldtype: "Link", options: "Item" },
	],
};
