# Copyright (c) 2026, SSV Platform contributors
# For license information, please see license.txt
"""Pure report arithmetic. Runs without a bench:
	python -m unittest discover -s ssv_channel/tests -p "test_analytics*.py"   (from the app root)
Also picked up by  bench run-tests --app ssv_channel.
"""

import datetime as dt
import unittest

try:
	from ssv_channel import analytics as A
	from ssv_channel import charts as C
	from ssv_channel import mapping as M
except ImportError:  # running from inside the package folder
	import analytics as A
	import charts as C
	import mapping as M


class TestMappingSuggestions(unittest.TestCase):
	ITEMS = [
		{"name": "CEAT-ZOOM-205-55-R16", "item_name": "CEAT – Zoom – 205/55 R16 – Car Tyre"},
		{"name": "CEAT-SPORTDRIVE-215-55-R17", "item_name": "CEAT – SportDrive – 215/55 R17 – Car Tyre"},
		{"name": "CEAT-ZOOM-PLUS-90-90-12", "item_name": "CEAT – Zoom Plus – 90/90-12 – Scooter Tyre"},
		{"name": "CEAT-MILAZE-145-80-R12", "item_name": "CEAT – Milaze – 145/80 R12 – Car Tyre"},
	]

	def test_the_way_distributors_write_it(self):
		for tally_name in ("CEAT Zoom 205/55R16", "Zoom 205-55-16 CEAT tyre", "ZOOM 205 55 R16", "Ceat zoom tyre 205/55/16"):
			self.assertEqual(M.best_match(tally_name, self.ITEMS)[0], "CEAT-ZOOM-205-55-R16", tally_name)
		self.assertEqual(M.best_match("Milaze 145 80 12", self.ITEMS)[0], "CEAT-MILAZE-145-80-R12")

	def test_a_different_size_is_not_suggested(self):
		self.assertIsNone(M.best_match("CEAT Zoom 195/55 R16", self.ITEMS)[0])
		self.assertIsNone(M.best_match("Bajaj Chetak side mirror", self.ITEMS)[0])

	def test_part_number_equal_to_the_item_code_is_certain(self):
		self.assertEqual(M.best_match("some odd name", self.ITEMS, part_no="ceat-milaze-145-80-r12"), ("CEAT-MILAZE-145-80-R12", 1.0))


class TestCharts(unittest.TestCase):
	TREE = [
		{"label": "Pune", "indent": 0, "net_qty": 50, "Apr 2026::net_qty": 20, "May 2026::net_qty": 30, "total::net_qty": 50},
		{"label": "Farmax", "indent": 1, "net_qty": 50},
		{"label": "Nagpur", "indent": 0, "net_qty": 80, "Apr 2026::net_qty": 80, "May 2026::net_qty": 0, "total::net_qty": 80},
	]

	def test_bars_largest_first_top_level_only(self):
		chart = C.bars(C.level(self.TREE), [("net_qty", "Net Sale Qty")])
		self.assertEqual(chart["data"]["labels"], ["Nagpur", "Pune"])
		self.assertEqual(chart["data"]["datasets"][0]["values"], [80, 50])

	def test_months_as_lines(self):
		chart = C.over_columns(C.level(self.TREE), ["Apr 2026", "May 2026"], "net_qty", "total::net_qty", as_line=True)
		self.assertEqual(chart["type"], "line")
		self.assertEqual([d["name"] for d in chart["data"]["datasets"]], ["Nagpur", "Pune"])
		self.assertEqual(chart["data"]["datasets"][1]["values"], [20, 30])

	def test_nothing_to_draw_gives_no_chart(self):
		self.assertIsNone(C.bars([], [("net_qty", "x")]))
		self.assertIsNone(C.bars([{"label": "A", "net_qty": 0}], [("net_qty", "x")]))
		self.assertIsNone(C.counts({"OK": 0, "Stale": 0}))
		self.assertEqual(C.counts({"OK": 3, "Stale": 0})["data"]["labels"], ["OK"])


def line(**kw):
	base = {"base_type": "Sales", "direction": "out", "qty": 0, "amount": 0, "is_tracked": 0}
	base.update(kw)
	return base


class TestMeasures(unittest.TestCase):
	def test_sales_returns_purchases(self):
		self.assertEqual(A.measures(line(qty=10, amount=550))["net_qty"], 10)
		m = A.measures(line(base_type="Credit Note", direction="in", qty=2, amount=110))
		self.assertEqual((m["return_qty"], m["net_qty"], m["net_value"]), (2, -2, -110))
		self.assertEqual(A.measures(line(base_type="Purchase", direction="in", qty=5))["purchase_qty"], 5)
		self.assertEqual(A.measures(line(base_type="Debit Note", direction="out", qty=1))["purchase_qty"], -1)

	def test_tracked_invoice_is_a_sale_but_not_a_stock_move(self):
		inv = line(qty=4, amount=200, is_tracked=1)
		self.assertEqual(A.measures(inv)["sale_qty"], 4)
		self.assertEqual(A.stock_delta(inv), 0)
		self.assertEqual(A.stock_delta(line(base_type="Delivery Note", qty=4)), -4)
		self.assertEqual(A.measures(line(base_type="Delivery Note", qty=4))["sale_qty"], 0)
		# tracked purchase: the receipt note carries both stock and purchase qty
		self.assertEqual(A.measures(line(base_type="Purchase", direction="in", qty=3, is_tracked=1))["purchase_qty"], 0)
		self.assertEqual(A.measures(line(base_type="Receipt Note", direction="in", qty=3))["purchase_qty"], 3)

	def test_a_note_with_its_own_tracking_number_still_moves_stock(self):
		# Tally stamps a delivery / receipt note's lines with the note's own tracking
		# number; found on a real TallyPrime import, 28-Sep-2026.
		self.assertEqual(A.stock_delta(line(base_type="Delivery Note", qty=4, is_tracked=1)), -4)
		self.assertEqual(A.stock_delta(line(base_type="Receipt Note", direction="in", qty=3, is_tracked=1)), 3)

	def test_physical_stock_does_not_move(self):
		self.assertEqual(A.stock_delta(line(base_type="Physical Stock", direction="in", qty=9)), 0)


class TestStockBook(unittest.TestCase):
	def setUp(self):
		k = ("D1", "ITEM")
		self.k = k
		# Tally says 492 on 20-Sep. Movements: +500 opening purchase 1-Sep, −10 on 5-Sep, +2 on 8-Sep, −6 on 22-Sep.
		self.book = A.StockBook(
			[{"key": k, "date": "2026-09-20", "qty": 492, "value": 4920}],
			[{"key": k, "date": "2026-09-01", "delta": 500}, {"key": k, "date": "2026-09-05", "delta": -10},
			 {"key": k, "date": "2026-09-08", "delta": 2}, {"key": k, "date": "2026-09-22", "delta": -6}],
		)

	def test_backwards_and_forwards_from_the_snapshot(self):
		self.assertEqual(self.book.qty_at(self.k, "2026-09-20")[0], 492)
		self.assertEqual(self.book.qty_at(self.k, "2026-09-06")[0], 490)   # 492 − 2
		self.assertEqual(self.book.qty_at(self.k, "2026-08-31")[0], 0)     # before the opening purchase
		self.assertEqual(self.book.qty_at(self.k, "2026-09-30")[0], 486)   # 492 − 6
		self.assertEqual(self.book.value_at(self.k, "2026-09-30"), 4860)   # at the snapshot's rate of 10

	def test_snapshot_wins_over_movements(self):
		# Tally's count differs from what the movements imply: trust Tally from that date on.
		book = A.StockBook([{"key": "k", "date": "2026-09-10", "qty": 100, "value": 0}], [{"key": "k", "date": "2026-09-01", "delta": 50}])
		self.assertEqual(book.qty_at("k", "2026-09-15")[0], 100)
		self.assertEqual(book.qty_at("k", "2026-08-31")[0], 50)

	def test_negative_stock_is_kept(self):
		book = A.StockBook([{"key": "k", "date": "2026-09-10", "qty": -72, "value": 0}], [])
		self.assertEqual(book.qty_at("k", "2026-09-10")[0], -72)

	def test_without_snapshot_uses_movements(self):
		book = A.StockBook([], [{"key": "k", "date": "2026-09-01", "delta": 7}])
		self.assertEqual(book.qty_at("k", "2026-09-02"), (7, "movements only"))

	def test_stock_turn(self):
		self.assertEqual(A.stock_turn(100, 60, 160), 2.0)
		self.assertIsNone(A.stock_turn(0, 0, 10))


class TestPeriods(unittest.TestCase):
	def test_deck_presets(self):
		t = dt.date(2013, 8, 28)  # a Wednesday, as in the deck's screenshots
		self.assertEqual(A.period_range("Current Financial Year", t), (dt.date(2013, 4, 1), dt.date(2014, 3, 31)))
		self.assertEqual(A.period_range("Current Quarter", t), (dt.date(2013, 7, 1), dt.date(2013, 9, 30)))
		self.assertEqual(A.period_range("Last Quarter", t), (dt.date(2013, 4, 1), dt.date(2013, 6, 30)))
		self.assertEqual(A.period_range("Current Month", t), (dt.date(2013, 8, 1), dt.date(2013, 8, 31)))
		self.assertEqual(A.period_range("Current Week", t), (dt.date(2013, 8, 25), dt.date(2013, 8, 31)))
		self.assertEqual(A.period_range("Last Week", t), (dt.date(2013, 8, 18), dt.date(2013, 8, 24)))
		self.assertEqual(A.period_range("Current Quarter", dt.date(2014, 2, 1)), (dt.date(2014, 1, 1), dt.date(2014, 3, 31)))


class TestTree(unittest.TestCase):
	def test_subtotals_at_every_level_and_pivot_columns(self):
		rows = [
			{"distributor": "D1", "item": "A", "month": "Apr", "net_qty": 5},
			{"distributor": "D1", "item": "A", "month": "May", "net_qty": 3},
			{"distributor": "D1", "item": "B", "month": "Apr", "net_qty": 2},
			{"distributor": "D2", "item": "A", "month": "Apr", "net_qty": 1},
		]
		spread = A.spread(rows, "month", ["net_qty"])
		keys = ["Apr::net_qty", "May::net_qty", "total::net_qty"]
		out = A.tree(spread, ["distributor", "item"], keys)
		d1 = next(r for r in out if r["id"] == "D1")
		self.assertEqual((d1["Apr::net_qty"], d1["May::net_qty"], d1["total::net_qty"]), (7, 3, 10))
		a = next(r for r in out if r["id"] == "D1/A")
		self.assertEqual((a["indent"], a["parent"], a["total::net_qty"]), (1, "D1", 8))
		self.assertEqual(A.pivot_keys(rows, "month", order=["Apr", "May"]), ["Apr", "May"])


if __name__ == "__main__":
	unittest.main()
