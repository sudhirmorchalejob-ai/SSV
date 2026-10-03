# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""
Channel classification on the principal's Item master. The deck's reports group
by product line, brand, category, sub-category, size and product class (slides
18, 22–28, 30); these belong to the principal's own item master, not to each
distributor's Tally. Brand uses ERPNext's standard Brand field.

Created on install and re-applied on every migrate, so a field deleted by hand
comes back and a changed label is updated.
"""

from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

ITEM_FIELDS = [
	{"fieldname": "ssv_classification_section", "fieldtype": "Section Break", "label": "Channel Classification",
	 "insert_after": "brand", "collapsible": 1},
	{"fieldname": "ssv_product_line", "fieldtype": "Data", "label": "Product Line", "insert_after": "ssv_classification_section",
	 "in_standard_filter": 1, "description": "e.g. Turmeric, Tooth Paste, Tooth Powder"},
	{"fieldname": "ssv_category", "fieldtype": "Data", "label": "Channel Category", "insert_after": "ssv_product_line",
	 "in_standard_filter": 1, "description": "e.g. Cream, Paste, Powder"},
	{"fieldname": "ssv_sub_category", "fieldtype": "Data", "label": "Sub-Category", "insert_after": "ssv_category"},
	{"fieldname": "ssv_classification_cb", "fieldtype": "Column Break", "insert_after": "ssv_sub_category"},
	{"fieldname": "ssv_size", "fieldtype": "Data", "label": "Pack Size", "insert_after": "ssv_classification_cb",
	 "description": "e.g. 15Gm, 100Gm, 1L"},
	{"fieldname": "ssv_size_group", "fieldtype": "Data", "label": "Size Group", "insert_after": "ssv_size",
	 "description": "e.g. Crm, Pst, Pwd"},
	{"fieldname": "ssv_size_sort", "fieldtype": "Int", "label": "Size Sort Order", "insert_after": "ssv_size_group"},
	{"fieldname": "ssv_product_class", "fieldtype": "Data", "label": "Product Class", "insert_after": "ssv_size_sort"},
]


def custom_fields():
	return {"Item": ITEM_FIELDS}


def after_install():
	create_custom_fields(custom_fields(), update=True)


def after_migrate():
	create_custom_fields(custom_fields(), update=True)
	from ssv_channel.summary import ensure_built

	ensure_built()
