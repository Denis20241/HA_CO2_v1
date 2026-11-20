"""Authenticated panel endpoints. Device paths and commands are server-owned."""

import asyncio
from json import JSONDecodeError
from math import isfinite
from time import time

from aiohttp import ClientError, web

from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.const import KEY_HASS_USER
from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er

from .api import MEASUREMENT_KEYS
from .const import DOMAIN
from .history import WINDOWS, history

BASE = f"/api/{DOMAIN}"
COMMANDS = {"toggle_abc", "calibrate", "offsets", "wifi", "factory_reset"}


def _entities(hass, entry, user):
    if entry.domain != DOMAIN or entry.state != ConfigEntryState.LOADED:
        return None
    registry = er.async_get(hass)
    ids = {key: registry.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_{key}")
           for key in MEASUREMENT_KEYS}
    if all(eid and user.permissions.check_entity(eid, POLICY_READ) for eid in ids.values()):
        return ids
    return None


def _snapshot(entry, now):
    coordinator = entry.runtime_data
    readings = coordinator.data or {}
    return {
        "values": {key: readings.get(key) if coordinator.last_update_success else None
                   for key in MEASUREMENT_KEYS},
        "online": coordinator.last_update_success,
        "last_success": coordinator.last_success,
        "host": coordinator.host,
        "diagnostics": {key: readings.get(key) for key in ("abc", "ip", "time", "status", "t_off", "h_off")},
        "exposure": coordinator.coverage.totals(now),
    }


class MonitorIndex(HomeAssistantView):
    url = BASE
    name = f"api:{DOMAIN}:index"

    def __init__(self, hass):
        self.hass = hass

    async def get(self, request):
        devices = dr.async_get(self.hass)
        areas = ar.async_get(self.hass)
        monitors = []
        for entry in self.hass.config_entries.async_entries(DOMAIN):
            if not _entities(self.hass, entry, request[KEY_HASS_USER]):
                continue
            device = devices.async_get_device(identifiers={(DOMAIN, entry.entry_id)})
            area = areas.async_get_area(device.area_id) if device and device.area_id else None
            monitors.append({"id": entry.entry_id, "name": (device.name_by_user if device else None)
                             or entry.title, "area": area.name if area else ""})
        return self.json(monitors)


class MonitorView(HomeAssistantView):
    url = BASE + "/{entry_id}/{resource}"
    name = f"api:{DOMAIN}:monitor"

    def __init__(self, hass):
        self.hass = hass

    def _entry(self, request, entry_id):
        entry = self.hass.config_entries.async_get_entry(entry_id)
        if not entry or not (ids := _entities(self.hass, entry, request[KEY_HASS_USER])):
            raise web.HTTPNotFound()
        return entry, ids

    async def get(self, request, entry_id, resource):
        entry, ids = self._entry(request, entry_id)
        coord = entry.runtime_data
        if resource == "live":
            return self.json(_snapshot(entry, time()))
        if resource == "history":
            period = request.query.get("period", "day")
            if period not in WINDOWS:
                raise web.HTTPBadRequest()
            return self.json(await history(self.hass, coord, ids, period, time()))
        if resource not in ("journal", "csv"):
            raise web.HTTPNotFound()
        path = "table" if resource == "journal" else "export"
        try:
            async with asyncio.timeout(8):
                async with coord.session.get(f"http://{coord.host}/api/{path}", allow_redirects=False) as resp:
                    if resp.status != 200:
                        raise web.HTTPBadGateway()
                    if resource == "csv":
                        return web.Response(body=await resp.read(), content_type="text/csv",
                                            headers={"Content-Disposition": 'attachment; filename="co2_export.csv"'})
                    payload = await resp.json(content_type=None)
                    if not isinstance(payload, dict) or not isinstance(payload.get("points"), list):
                        raise web.HTTPBadGateway()
                    return self.json(payload["points"])
        except (ClientError, TimeoutError, ValueError) as err:
            raise web.HTTPBadGateway() from err

    async def post(self, request, entry_id, resource):
        if not request[KEY_HASS_USER].is_admin:
            raise web.HTTPForbidden()
        entry, _ = self._entry(request, entry_id)
        if resource not in COMMANDS:
            raise web.HTTPNotFound()
        try:
            data = await request.json()
        except (JSONDecodeError, ValueError):
            raise web.HTTPBadRequest() from None
        fields = _form(resource, data)
        coord = entry.runtime_data
        if coord.command_lock.locked():
            raise web.HTTPConflict()
        async with coord.command_lock:
            try:
                async with asyncio.timeout(8):
                    async with coord.session.post(f"http://{coord.host}/api/{resource}", data=fields,
                                                  allow_redirects=False) as resp:
                        if resp.status != 200:
                            raise web.HTTPBadGateway()
                        await resp.read()
            except (ClientError, TimeoutError):
                return self.json({"message": "Результат неизвестен. Проверьте состояние прибора."}, status_code=504)
        return self.json({"accepted": True})


def _form(command, data):
    if not isinstance(data, dict):
        raise web.HTTPBadRequest()
    if command == "offsets":
        if set(data) != {"t_off", "h_off"} or not all(
            type(v) in (float, int) and abs(v) <= 3.4028235e38 and isfinite(v) for v in data.values()
        ):
            raise web.HTTPBadRequest()
        return {k: str(v) for k, v in data.items()}
    if command == "wifi":
        if (set(data) != {"ssid", "pass"} or not all(isinstance(v, str) for v in data.values())
                or not 0 < len(data["ssid"].encode()) <= 32 or len(data["pass"].encode()) > 64):
            raise web.HTTPBadRequest()
        return data
    if data:
        raise web.HTTPBadRequest()
    return {}
