// Copyright (c) 2026, SSV Platform contributors
// For license information, please see license.txt

frappe.ui.form.on("SSV Settings", {
	refresh(frm) {
		if (!frappe.user.has_role("System Manager")) return;
		frm.add_custom_button(__("Send Test Alert"), async () => {
			if (frm.is_dirty()) {
				frappe.msgprint(__("Save first, then send the test."));
				return;
			}
			const r = await frappe.call({ method: "ssv_channel.alerts.send_test_alert", freeze: true, freeze_message: __("Sending…") });
			frappe.msgprint(__("Test alert sent to {0}.", [(r.message || []).map(frappe.utils.escape_html).join(", ")]));
		});
		frm.add_custom_button(__("Apply Wording"), async () => {
			if (frm.is_dirty()) {
				frappe.msgprint(__("Save first, then apply the wording."));
				return;
			}
			const reset = frm.doc.partner_label === "Distributor" && frm.doc.buyer_label === "Retailer";
			const r = await frappe.call({
				method: reset ? "ssv_channel.partner_labels.reset" : "ssv_channel.partner_labels.apply",
				args: reset ? {} : { partner: frm.doc.partner_label, buyer: frm.doc.buyer_label },
				freeze: true,
			});
			frappe.msgprint(__("{0} labels updated. Reload the page to see them everywhere.", [r.message]));
		});
	},
});
