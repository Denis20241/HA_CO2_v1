"""Regression checks for history carried over from 0.1 and measured exposure."""

from types import SimpleNamespace
import unittest

from custom_components.senseair_s8_monitor.coverage import Coverage
from custom_components.senseair_s8_monitor.history import _aggregate_tail, _recent_points, _value


class PanelHistoryTest(unittest.TestCase):
    def test_pressure_before_and_after_unit_migration(self):
        old = SimpleNamespace(state="979.39", attributes={"unit_of_measurement": "hPa"})
        new = SimpleNamespace(state="734.6", attributes={"unit_of_measurement": "mmHg"})
        self.assertAlmostEqual(_value(old, "press"), 734.6, places=1)
        self.assertEqual(_value(new, "press"), 734.6)

    def test_exposure_excludes_threshold_misses_and_restart(self):
        coverage = Coverage()
        for ts, value in [(0, 1200), (5, 1300), (10, 1300), (15, None),
                          (20, 1300), (25, 1100), (40, 1300)]:
            coverage.sample(ts, value)
        self.assertEqual(coverage.totals(40), {"covered": 15, "high": 10})
        restored = Coverage(list(coverage.segments))
        restored.sample(45, 1300)
        self.assertEqual(restored.totals(45), coverage.totals(45))
        self.assertEqual(restored.totals(86408), {"covered": 7, "high": 7})

    def test_partial_bucket_uses_observed_duration(self):
        samples = [(0, {"temp": 20}), (5, {"temp": None}), (10, {"temp": 24}),
                   (15, {"temp": 24}), (20, {"temp": 16})]
        points = _recent_points(samples, "temp", 0, 20)
        row, = _aggregate_tail(points, 300, 0, 20)
        self.assertEqual(row[3:], [20, 24, 15])
        self.assertAlmostEqual(row[2], (20 * 5 + 24 * 10) / 15)
