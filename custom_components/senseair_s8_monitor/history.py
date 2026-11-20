"""Read the existing HA recorder history in the monitor's native units."""

from datetime import datetime, timezone
from math import isfinite
from time import monotonic

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import get_significant_states
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.util.unit_conversion import PressureConverter, TemperatureConverter

from .api import MEASUREMENT_KEYS

WINDOWS = {"hour": 3600, "day": 86400, "week": 604800, "year": 31536000}
PERIODS = {"day": "5minute", "week": "hour", "year": "day"}


def _utc(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc)


def _value(state, key):
    try:
        value = float(state.state)
        unit = state.attributes.get("unit_of_measurement")
        if key == "press" and unit not in PressureConverter.VALID_UNITS:
            return None
        if key == "temp" and unit not in TemperatureConverter.VALID_UNITS:
            return None
        if key == "press":
            value = PressureConverter.convert(value, unit, "mmHg")
        elif key == "temp":
            value = TemperatureConverter.convert(value, unit, "°C")
        return value if isfinite(value) else None
    except (ValueError, TypeError, KeyError):
        return None


def _point(start, end, mean, low=None, high=None):
    return [start, end, mean, low if low is not None else mean, high if high is not None else mean]


def _recorded(hass, entities, period, start, end):
    result = {key: [] for key in MEASUREMENT_KEYS}
    if end <= start:
        return result
    if period == "hour":
        states = get_significant_states(hass, _utc(start), _utc(end), list(entities.values()))
        for key, entity in entities.items():
            rows = states.get(entity, [])
            for i, state in enumerate(rows):
                left = max(start, state.last_updated.timestamp())
                right = min(end, rows[i + 1].last_updated.timestamp()) if i + 1 < len(rows) else end
                result[key].append(_point(left, right, _value(state, key)))
        return result

    stats = statistics_during_period(hass, _utc(start), _utc(end), set(entities.values()),
                                     PERIODS[period], {"pressure": "mmHg", "temperature": "°C"},
                                     {"min", "mean", "max"})
    for key, entity in entities.items():
        for row in stats.get(entity, []):
            if row.get("mean") is not None and row["end"] > start:
                result[key].append(_point(max(row["start"], start), min(row["end"], end),
                                          row["mean"], row["min"], row["max"]))
    return result


def _recent_points(recent, key, start, end):
    points = []
    for index, (ts, readings) in enumerate(recent):
        stop = recent[index + 1][0] if index + 1 < len(recent) else ts
        if stop <= start or ts > end:
            continue
        if stop - ts > 9:
            points.append(_point(max(ts, start), max(ts, start), readings[key]))
            points.append(_point(max(ts, start), min(stop, end), None))
        else:
            points.append(_point(max(ts, start), min(stop, end), readings[key]))
    return points


def _aggregate_tail(points, step, start, end):
    # Only integrate observed intervals. A failed poll carries no value.
    buckets = {}
    for left, right, value, _, _ in points:
        if value is None:
            continue
        while left < right:
            boundary = int(left // step) * step
            stop = min(right, boundary + step)
            bucket = buckets.setdefault(boundary, [0, 0, value, value])
            bucket[0] += (stop - left) * value
            bucket[1] += stop - left
            bucket[2] = min(value, bucket[2])
            bucket[3] = max(value, bucket[3])
            left = stop
    return [[*_point(max(boundary, start), min(boundary + step, end), total / duration, low, high), duration]
            for boundary, (total, duration, low, high) in buckets.items()]


async def history(hass, coordinator, entities, period, now):
    start = now - WINDOWS[period]
    recent = list(coordinator.recent)
    archived_end = min(now, recent[0][0]) if recent and period == "hour" else now
    result = {key: [] for key in MEASUREMENT_KEYS}
    recorder_enabled = "recorder" in hass.config.components
    if recorder_enabled and archived_end > start:
        # Share recorder reads across open dashboards. Live samples are merged below.
        async with coordinator.history_lock:
            cached = coordinator.history_cache.get(period)
            identity = tuple(entities.items())
            stamp = monotonic()
            if not cached or cached[1] != identity or stamp - cached[0] >= 30:
                archive = await get_instance(hass).async_add_executor_job(
                    _recorded, hass, entities, period, start, archived_end
                )
                coordinator.history_cache[period] = (stamp, identity, archive)
            else:
                archive = cached[2]
            for key, rows in archive.items():
                result[key] = [[max(a, start), min(b, archived_end), *stats]
                               for a, b, *stats in rows if b > start and a <= archived_end]
    for key in MEASUREMENT_KEYS:
        if period == "hour":
            result[key].extend(_recent_points(recent, key, start, now))
        elif period in ("day", "week"):
            tail = result[key][-1][1] if result[key] else start
            tail = max(tail, recent[0][0]) if recent else now
            points = _recent_points(recent, key, tail, now)
            result[key].extend(_aggregate_tail(points, 300 if period == "day" else 3600, tail, now))
    return {"start": start, "end": now, "series": result, "recorder": recorder_enabled}
