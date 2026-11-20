"""One HTTP poll per monitor, with recent samples and measured CO₂ exposure."""

import asyncio
from collections import deque
import logging
from time import time

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import MEASUREMENT_KEYS, InvalidMonitorResponse, MonitorConnectionError, read_measurements
from .const import DOMAIN, POLL_INTERVAL
from .coverage import Coverage


class MonitorCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, entry: ConfigEntry) -> None:
        super().__init__(hass, logging.getLogger(__name__), config_entry=entry,
                         name=DOMAIN, update_interval=POLL_INTERVAL, always_update=False)
        self.host = entry.data[CONF_HOST]
        self.session = async_get_clientsession(hass)
        self.command_lock = asyncio.Lock()
        self.history_lock = asyncio.Lock()
        self.history_cache = {}
        self._misses = 0
        self.last_success = None
        self.recent = deque()
        self.coverage = Coverage()
        self.store = Store(hass, 1, f"{DOMAIN}.{entry.entry_id}.coverage")
        self._next_save = 0

    async def restore_coverage(self):
        self.coverage = Coverage(await self.store.async_load() or ())

    def _sample(self, readings):
        now = time()
        values = {key: readings.get(key) for key in MEASUREMENT_KEYS}
        self.recent.append((now, values))
        while self.recent and self.recent[0][0] < now - 3605:
            self.recent.popleft()
        self.coverage.sample(now, values["co2"])
        if now >= self._next_save:
            self._next_save = now + 60
            self.store.async_delay_save(self.saved_segments, 60)

    def saved_segments(self):
        return [row.copy() for row in self.coverage.segments]

    async def _async_update_data(self):
        try:
            snapshot = await read_measurements(self.session, self.host)
        except (InvalidMonitorResponse, MonitorConnectionError) as err:
            self._sample({})
            self._misses += 1
            if self._misses == 1 and self.data is not None:
                return self.data
            raise UpdateFailed(str(err)) from err

        self._sample(snapshot)
        self.last_success = self.recent[-1][0]
        self._misses = 0
        return snapshot
