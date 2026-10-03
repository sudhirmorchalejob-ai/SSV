// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.listview_settings["SSV Channel Item"] = {
	add_fields: ["mapping_status", "suggested_item", "suggestion_score"],
	get_indicator(doc) {
		if (doc.mapping_status === "Mapped") return [__("Mapped"), "green", "mapping_status,=,Mapped"];
		if (doc.mapping_status === "Ignored") return [__("Ignored"), "gray", "mapping_status,=,Ignored"];
		return doc.suggested_item
			? [__("Suggested"), "blue", "mapping_status,=,Unmapped"]
			: [__("Unmapped"), "orange", "mapping_status,=,Unmapped"];
	},
	onload(listview) {
		listview.page.add_actions_menu_item(__("Accept Suggested Items"), async () => {
			const names = listview.get_checked_items(true);
			if (!names.length) return frappe.msgprint(__("Select the items whose suggestions you have checked."));
			const r = await frappe.call("ssv_channel.mapping.accept_suggestions", { names });
			frappe.show_alert(__("{0} item(s) mapped; past sales now report under them", [r.message.mapped]));
			listview.refresh();
		});
		listview.page.add_actions_menu_item(__("Create Items from Selected"), () => {
			const names = listview.get_checked_items(true);
			if (!names.length) return frappe.msgprint(__("Select the unmapped items to create as Items."));
			frappe.confirm(
				__("Create {0} Item(s) named as in Tally, in Tally's stock groups, and map them? Items with the same Tally name from other senders are mapped too.", [names.length]),
				async () => {
					const r = await frappe.call({ method: "ssv_channel.mapping.create_items", args: { names }, freeze: true });
					frappe.show_alert(__("{0} Item(s) created, {1} mapped; suggestions refreshed for the rest", [r.message.created, r.message.mapped]), 10);
					if ((r.message.skipped || []).length) {
						frappe.msgprint({
							title: __("Not created"),
							message: __("These need attention (for example an HSN code in Tally), or can be created by hand:") +
								"<ul>" + r.message.skipped.map((s) => "<li>" + frappe.utils.escape_html(s) + "</li>").join("") + "</ul>",
						});
					}
					listview.refresh();
				},
			);
		});
		listview.page.add_inner_button(__("Refresh Suggestions"), async () => {
			const r = await frappe.call("ssv_channel.mapping.suggest_all");
			frappe.show_alert(__("{0} of {1} unmapped items have a suggestion", [r.message.suggested, r.message.unmapped]));
			listview.refresh();
		});
	},
};
