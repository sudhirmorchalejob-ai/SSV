// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.listview_settings["SSV Retailer"] = {
	add_fields: ["status"],
	get_indicator(doc) {
		return doc.status === "Inactive" ? [__("Inactive"), "gray", "status,=,Inactive"] : [__("Active"), "green", "status,=,Active"];
	},
};
