"""Read the existing room monitor's local HTTP API."""

from __future__ import annotations

import asyncio
from math import isfinite

from aiohttp import ClientError, ClientSession

MEASUREMENT_KEYS = ("co2", "temp", "hum", "press")


class MonitorConnectionError(Exception):
    """The monitor did not answer the HTTP request successfully."""


class InvalidMonitorResponse(ValueError):
    """The response is not a usable snapshot from the room monitor."""


async def read_measurements(
    session: ClientSession, host: str, *, verify_schema: bool = False
) -> dict[str, int | float | None]:
    """Retrieve all four measurements in one request."""
    try:
        async with asyncio.timeout(3):
            async with session.get(
                f"http://{host}/api/data", allow_redirects=False
            ) as response:
                if response.status == 404:
                    raise InvalidMonitorResponse("Monitor endpoint not found")
                if response.status != 200:
                    raise MonitorConnectionError(f"HTTP {response.status}")
                try:
                    payload = await response.json(content_type=None)
                except ValueError as err:
                    raise InvalidMonitorResponse("Invalid JSON") from err
    except (ClientError, TimeoutError) as err:
        raise MonitorConnectionError("Monitor did not respond") from err

    if not isinstance(payload, dict) or not isinstance(payload.get("abc"), bool):
        raise InvalidMonitorResponse("Missing monitor status fields")
    if verify_schema and not all(key in payload for key in MEASUREMENT_KEYS):
        raise InvalidMonitorResponse("Missing required measurement fields")

    readings = {}
    for key in MEASUREMENT_KEYS:
        value = payload.get(key)
        if type(value) is int or (type(value) is float and isfinite(value)):
            readings[key] = value
        else:
            readings[key] = None
    if all(value is None for value in readings.values()):
        raise InvalidMonitorResponse("No numeric measurements")
    return readings
