"""Local integration and built-in air monitor panel."""

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.storage import Store

from .const import DOMAIN
from .coordinator import MonitorCoordinator
from .views import MonitorIndex, MonitorView

PLATFORMS = [Platform.SENSOR]
PANEL = "senseair-air-monitor"
ASSETS = "/senseair-s8-assets/v0-2-0"


async def async_setup(hass, config):
    await hass.http.async_register_static_paths([
        StaticPathConfig(ASSETS, str(Path(__file__).parent / "frontend"), True)
    ])
    hass.http.register_view(MonitorIndex(hass))
    hass.http.register_view(MonitorView(hass))
    return True


async def async_migrate_entry(hass, entry):
    if entry.version != 1:
        return False
    if entry.minor_version < 2:
        registry = er.async_get(hass)
        entity_id = registry.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_press")
        if entity_id and (sensor := registry.async_get(entity_id)):
            # Re-evaluate the old system default. Explicit user overrides take precedence.
            options = dict(sensor.options.get("sensor.private", {}))
            options["refresh_initial_entity_options"] = True
            registry.async_update_entity_options(entity_id, "sensor.private", options)
        hass.config_entries.async_update_entry(entry, minor_version=2)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = MonitorCoordinator(hass, entry)
    await coordinator.restore_coverage()
    # Keep existing history and the sidebar available when the monitor boots later than HA.
    await coordinator.async_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    if not frontend.async_panel_exists(hass, PANEL):
        await panel_custom.async_register_panel(
            hass, PANEL, "senseair-monitor-panel", sidebar_title="Монитор воздуха",
            sidebar_icon="mdi:chart-areaspline", config_panel_domain=DOMAIN, module_url=f"{ASSETS}/panel.js",
        )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    await entry.runtime_data.store.async_save(entry.runtime_data.saved_segments())
    if not any(other is not entry and other.state.value == "loaded"
               for other in hass.config_entries.async_entries(DOMAIN)):
        frontend.async_remove_panel(hass, PANEL)
    return True


async def async_remove_entry(hass, entry):
    await Store(hass, 1, f"{DOMAIN}.{entry.entry_id}.coverage").async_remove()
