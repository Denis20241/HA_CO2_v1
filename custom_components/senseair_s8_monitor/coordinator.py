"""Share one poll between all of a monitor's sensors."""

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import InvalidMonitorResponse, MonitorConnectionError, read_measurements
from .const import DOMAIN, POLL_INTERVAL


class MonitorCoordinator(DataUpdateCoordinator[dict[str, int | float | None]]):
    """Poll the configured address, keeping a single failed poll as a grace period."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            logging.getLogger(__name__),
            config_entry=entry,
            name=DOMAIN,
            update_interval=POLL_INTERVAL,
            always_update=False,
        )
        self._host = entry.data[CONF_HOST]
        self._session = async_get_clientsession(hass)
        self._misses = 0

    async def _async_update_data(self) -> dict[str, int | float | None]:
        try:
            readings = await read_measurements(self._session, self._host)
        except (InvalidMonitorResponse, MonitorConnectionError) as err:
            self._misses += 1
            if self._misses == 1 and self.data is not None:
                return self.data
            raise UpdateFailed(str(err)) from err

        self._misses = 0
        return readings
