// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.ui.form.on("SSV Channel Item", {
	refresh(frm) {
		if (frm.doc.mapping_status !== "Unmapped") return;
		if (frm.doc.suggested_item) {
			frm.add_custom_button(__("Use Suggestion: {0}", [frm.doc.suggested_item]), () => {
				frm.set_value("item_code", frm.doc.suggested_item);
				frm.save();
			}).addClass("btn-primary");
		}
		frm.add_custom_button(__("Refresh Suggestions"), async () => {
			const r = await frappe.call("ssv_channel.mapping.suggest_all");
			frappe.show_alert(__("{0} of {1} unmapped items have a suggestion", [r.message.suggested, r.message.unmapped]));
			frm.reload_doc();
		}, __("Actions"));
	},
});
