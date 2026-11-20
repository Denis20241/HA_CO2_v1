"""Add a monitor by its displayed IP or update an existing entry's address."""

from ipaddress import AddressValueError, IPv4Address
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import InvalidMonitorResponse, MonitorConnectionError, read_measurements
from .const import DOMAIN, NAME


class MonitorConfigFlow(ConfigFlow, domain=DOMAIN):
    """Validate the address and firmware API before saving."""

    VERSION = 1
    MINOR_VERSION = 2

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._address_form("user", user_input)

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._address_form(
            "reconfigure", user_input, self._get_reconfigure_entry()
        )

    async def _address_form(
        self, step: str, inputs: dict[str, Any] | None, entry: ConfigEntry | None = None
    ) -> ConfigFlowResult:
        host = entry.data[CONF_HOST] if entry else ""
        errors: dict[str, str] = {}
        if inputs is not None:
            host = inputs[CONF_HOST].strip()
            try:
                host = str(IPv4Address(host))
                await read_measurements(
                    async_get_clientsession(self.hass), host, verify_schema=True
                )
            except AddressValueError:
                errors[CONF_HOST] = "invalid_ip"
            except MonitorConnectionError:
                errors["base"] = "cannot_connect"
            except InvalidMonitorResponse:
                errors["base"] = "invalid_response"
            else:
                if any(
                    current is not entry and current.data[CONF_HOST] == host
                    for current in self._async_current_entries()
                ):
                    return self.async_abort(reason="already_configured")

                if entry is not None:
                    return self.async_update_reload_and_abort(
                        entry, data_updates={CONF_HOST: host}, title=f"{NAME} ({host})"
                    )
                return self.async_create_entry(
                    title=f"{NAME} ({host})", data={CONF_HOST: host}
                )

        return self.async_show_form(
            step_id=step,
            data_schema=vol.Schema({vol.Required(CONF_HOST, default=host): str}),
            errors=errors,
        )
