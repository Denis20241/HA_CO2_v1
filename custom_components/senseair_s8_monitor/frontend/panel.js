import { AirChart, METRICS, element, number, summary } from "./charts.js";

const BASE = "senseair_s8_monitor";
const PERIODS = { hour: "Час", day: "Сутки", week: "Неделя", year: "Год" };
const ACTIONS = {
  toggle_abc: [
    "Переключить ABC",
    "Изменить состояние автоматической базовой калибровки CO₂?",
  ],
  calibrate: [
    "Калибровка на 400 ppm",
    "Подготовьте датчик на свежем воздухе по инструкции прибора. Отправить команду калибровки на 400 ppm?",
  ],
  offsets: ["Поправки", "Обе поправки сохраняются на приборе."],
  wifi: [
    "Сеть Wi-Fi",
    "Прибор сохранит сеть и перезапустится. Если IP изменится, укажите новый адрес в существующей записи интеграции.",
  ],
  factory_reset: [
    "Заводской сброс",
    "Будут удалены настройки Wi-Fi и поправки. Журнал прибора очистится после перезапуска. Понадобится заново настроить сеть. История в Home Assistant сохранится.",
  ],
};
const KEYS = Object.keys(METRICS);
const blank = () => Object.fromEntries(KEYS.map((k) => [k, []]));
const date = (t) =>
  new Date(t * 1000).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const duration = (s) =>
  s == null
    ? "Нет данных"
    : s < 60
      ? `${s} с`
      : `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
function button(label, action) {
  const el = element("button", "", label);
  el.type = "button";
  el.dataset.action = action;
  return el;
}
function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private browsing. */
  }
}
class SenseairPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.period = "day";
    this.visible = new Set(KEYS);
    this.generation = 0;
    this.widgets = {};
    this.lastHistory = 0;
  }
  set hass(value) {
    const changed = this._hass?.user.id !== value.user.id;
    this._hass = value;
    if (changed && this.ready && this.isConnected) this.start();
    const dark = value.themes?.darkMode;
    if (dark !== this.dark) {
      this.dark = dark;
      requestAnimationFrame(() =>
        Object.values(this.widgets).forEach((w) => w.draw()),
      );
    }
  }
  get $() {
    return (id) => this.shadowRoot.getElementById(id);
  }
  async connectedCallback() {
    if (!this.ready) {
      try {
        const res = await fetch(new URL("./layout.html", import.meta.url));
        if (!res.ok) throw Error();
        const html = await res.text();
        if (this.ready) return;
        this.shadowRoot.innerHTML = html;
        const link = element("link");
        link.rel = "stylesheet";
        link.href = new URL("./style.css", import.meta.url).href;
        this.shadowRoot.prepend(link);
        this.setup();
        this.ready = true;
      } catch {
        this.shadowRoot.textContent =
          "Не удалось открыть панель. Обновите страницу.";
        return;
      }
    }
    if (this._hass && this.isConnected) this.start();
  }
  disconnectedCallback() {
    clearInterval(this.timer);
    this.generation++;
    for (const item of Object.values(this.widgets)) item.close();
  }
  setup() {
    for (const key of KEYS) {
      const m = METRICS[key],
        card = element("div", "metric");
      card.style.setProperty("--series", m.color);
      const val = element("span", "", "—");
      val.id = "val-" + key;
      const row = element("div", "reading");
      row.append(val, " ", element("small", "", m.unit));
      card.append(element("div", "name", m.name), row);
      if (key === "co2") {
        const band = element("div", "band");
        band.id = "band";
        card.append(band);
      }
      this.$("metrics").append(card);
      const toggle = button(m.name, "toggle");
      toggle.className = "toggle";
      toggle.dataset.key = key;
      toggle.style.setProperty("--series", m.color);
      toggle.prepend(element("i", "dot"));
      this.$("legend").append(toggle);
      const detail = element("article", "card");
      detail.append(element("h3", "", `${m.name} · ${m.unit}`));
      const slot = element("div");
      slot.id = "plot-" + key;
      const stats = element("div", "summary");
      stats.id = "stats-" + key;
      detail.append(slot, stats);
      if (key === "co2") {
        const exposure = element("p", "exposure");
        exposure.id = "exposure";
        detail.append(exposure);
      }
      this.$("charts").append(detail);
    }
    for (const [key, label] of Object.entries(PERIODS)) {
      const b = button(label, "period");
      b.dataset.key = key;
      this.$("period").append(b);
    }
    for (const [key, [label]] of Object.entries(ACTIONS)) {
      const b = button(label, key);
      if (key === "factory_reset") b.className = "danger";
      this.$("commands").append(b);
    }
    this.$("device").onchange = () => this.choose(this.$("device").value);
    this.$("form").onsubmit = (e) => {
      e.preventDefault();
      this.submit();
    };
    this.shadowRoot.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-action]");
      if (!b) return;
      const a = b.dataset.action,
        k = b.dataset.key;
      if (a === "menu")
        this.dispatchEvent(
          new CustomEvent("hass-toggle-menu", {
            bubbles: true,
            composed: true,
          }),
        );
      else if (a === "toggle") {
        this.visible.has(k) ? this.visible.delete(k) : this.visible.add(k);
        save(this.pref + "series", [...this.visible]);
        this.draw();
      } else if (a === "period") {
        if (this.period === k) return;
        this.period = k;
        this.historyRevision++;
        this.lastHistory = 0;
        this.data = null;
        this.draw();
        this.loadHistory();
      } else if (a === "journal") this.journal();
      else if (a === "csv") this.csv();
      else if (a === "cancel") this.$("dialog").close();
      else if (ACTIONS[a]) this.dialog(a);
    });
  }
  async start() {
    const run = ++this.generation;
    clearInterval(this.timer);
    for (const [key, w] of Object.entries(this.widgets)) {
      w.close();
      this.$(key === "combined" ? "combined" : "plot-" + key).replaceChildren();
    }
    this.widgets = { combined: new AirChart(this.$("combined"), true) };
    for (const key of KEYS)
      this.widgets[key] = new AirChart(this.$("plot-" + key), false);
    this.pref = "senseair:" + this._hass.user.id + ":";
    this.visible = new Set(
      stored(this.pref + "series", KEYS).filter((k) => KEYS.includes(k)),
    );
    this.$("content").hidden = true;
    this.$("controls").hidden = !this._hass.user.is_admin;
    this.notify("Загрузка приборов…");
    this.devices = [];
    const find = async () => {
      try {
        const devices = await this._hass.callApi("GET", BASE);
        if (run !== this.generation) return;
        this.devices = devices;
        if (!devices.length) {
          this.notify(
            "Нет доступных мониторов. Проверьте подключение и доступ в Home Assistant.",
          );
          return;
        }
        this.$("device").replaceChildren(
          ...devices.map((d) => {
            const o = element(
              "option",
              "",
              [d.area, d.name].filter(Boolean).join(" · "),
            );
            o.value = d.id;
            return o;
          }),
        );
        const wanted = stored(this.pref + "device", null);
        this.choose(devices.find((d) => d.id === wanted)?.id || devices[0].id);
      } catch {
        if (run === this.generation)
          this.notify(
            "Не удалось получить список приборов. Повторяем подключение…",
          );
      }
    };
    await find();
    if (run !== this.generation) return;
    this.timer = setInterval(() => {
      if (document.hidden) return;
      if (!this.devices.length) find();
      else this.live();
    }, 5000);
  }
  notify(text) {
    this.$("notice").textContent = text;
    this.$("notice").hidden = !text;
  }
  choose(id) {
    this.id = id;
    this.ticket = (this.ticket || 0) + 1;
    this.reconnectAfter = null;
    this.historyRevision = 0;
    this.historyPending = null;
    this.livePending = null;
    this.lastHistory = 0;
    this.data = null;
    this.snapshot = null;
    this.$("dialog").close();
    this.$("feedback").textContent = "";
    this.$("table").replaceChildren();
    this.$("device").value = id;
    save(this.pref + "device", id);
    this.$("room").textContent =
      this.devices.find((d) => d.id === id)?.area || "";
    this.$("content").hidden = false;
    this.notify("");
    this.paintLive();
    this.draw();
    this.live();
    this.loadHistory();
  }
  endpoint(part) {
    return `${BASE}/${this.id}/${part}`;
  }
  async live() {
    if (this.livePending === this.ticket) return;
    const ticket = this.ticket,
      run = this.generation;
    this.livePending = ticket;
    try {
      const snap = await this._hass.callApi("GET", this.endpoint("live"));
      if (ticket !== this.ticket || run !== this.generation) return;
      this.snapshot = snap;
      this.paintLive();
      this.notify("");
      if (
        Date.now() - this.lastHistory >
        (this.period === "hour" ? 5000 : 60000)
      )
        this.loadHistory();
    } catch {
      if (ticket === this.ticket && run === this.generation)
        this.notify(
          "Связь с Home Assistant прервана. Показаны последние полученные данные.",
        );
    } finally {
      if (ticket === this.ticket) this.livePending = null;
    }
  }
  paintLive() {
    const s = this.snapshot,
      diag = s?.diagnostics || {};
    if (
      this.reconnectAfter &&
      s?.online &&
      s.last_success > this.reconnectAfter
    ) {
      this.$("feedback").textContent =
        "Связь восстановлена. Прибор ответил " + date(s.last_success) + ".";
      this.reconnectAfter = null;
    }
    for (const key of KEYS)
      this.$("val-" + key).textContent = number(s?.values[key], key);
    const c = s?.values.co2,
      band = this.$("band");
    band.textContent =
      c == null
        ? "Нет данных"
        : c < 800
          ? "Ниже 800 ppm"
          : c <= 1200
            ? "800–1200 ppm"
            : "Выше 1200 ppm";
    band.parentNode.style.setProperty(
      "--series",
      c == null
        ? "var(--muted)"
        : c < 800
          ? "#199675"
          : c <= 1200
            ? "#b8811b"
            : "#d05545",
    );
    const pairs = [
      ["Связь с прибором", !s ? "—" : s.online ? "На связи" : "Нет связи"],
      ["IP прибора", diag.ip || s?.host || "—"],
      [
        "Время прибора",
        diag.time && diag.time !== "--:--"
          ? diag.time
          : "Время прибора недоступно",
      ],
      ["Статус S8", diag.status ?? "—"],
      ["Последний ответ", s?.last_success ? date(s.last_success) : "—"],
      [
        "Автокалибровка ABC",
        diag.abc == null ? "—" : diag.abc ? "Включена" : "Выключена",
      ],
    ];
    this.$("diagnostics").replaceChildren(
      ...pairs.map(([name, value]) => {
        const g = element("div");
        g.append(element("dt", "", name), element("dd", "", value));
        return g;
      }),
    );
    const link = this.$("deviceLink");
    link.hidden = !s?.host;
    if (s?.host) link.href = `http://${s.host}/`;
    this.exposure();
  }
  exposure() {
    const el = this.$("exposure"),
      e = this.snapshot?.exposure;
    el.hidden = this.period !== "day";
    el.textContent = `Выше 1200 ppm: ${duration(e?.high)} · наблюдение: ${duration(e?.covered)} за сутки`;
  }
  async loadHistory() {
    const key = `${this.generation}/${this.ticket}/${this.historyRevision}`;
    if (this.historyPending === key) return;
    this.historyPending = key;
    this.$("range").textContent = "Загрузка истории…";
    try {
      const data = await this._hass.callApi(
        "GET",
        this.endpoint("history?period=" + this.period),
      );
      if (this.historyPending !== key || !this.isConnected) return;
      this.data = data;
      this.lastHistory = Date.now();
      this.draw();
    } catch {
      if (this.historyPending === key)
        this.$("range").textContent =
          "Не удалось загрузить историю. Проверьте Recorder.";
    } finally {
      if (this.historyPending === key) this.historyPending = null;
    }
  }
  draw() {
    const active = (node, predicate) =>
      node
        .querySelectorAll("button")
        .forEach((b) =>
          b.setAttribute("aria-pressed", String(predicate(b.dataset.key))),
        );
    active(this.$("legend"), (k) => this.visible.has(k));
    active(this.$("period"), (k) => this.period === k);
    const d = this.data || {
      start: Date.now() / 1000 - 3600,
      end: Date.now() / 1000,
      series: blank(),
    };
    this.widgets.combined.set(d, [...this.visible], this.period);
    for (const key of KEYS) {
      this.widgets[key].set(d, [key], this.period);
      const s = summary(d.series[key]);
      this.$("stats-" + key).replaceChildren(
        ...[
          ["Мин", s.min],
          ["Среднее", s.mean],
          ["Макс", s.max],
        ].map(([label, val]) => {
          const line = element("span", "", label + " ");
          line.append(element("b", "", number(val, key)));
          return line;
        }),
      );
    }
    this.$("range").textContent = this.data
      ? `${date(d.start)} — ${date(d.end)} · У каждой линии своя шкала${d.recorder ? "" : " · Recorder отключён"}`
      : "Загрузка истории…";
    this.exposure();
  }
  async journal() {
    const ticket = this.ticket,
      table = this.$("table");
    table.textContent = "Загрузка…";
    try {
      const rows = await this._hass.callApi("GET", this.endpoint("journal"));
      if (ticket !== this.ticket) return;
      if (!rows.length) {
        table.textContent = "В журнале пока нет часовых записей.";
        return;
      }
      const grid = element("table"),
        head = grid.createTHead().insertRow();
      for (const value of [
        "Время",
        ...KEYS.map((k) => `${METRICS[k].name}, ${METRICS[k].unit}`),
      ])
        head.append(element("th", "", value));
      const body = grid.createTBody();
      for (const row of [...rows].reverse()) {
        const tr = body.insertRow();
        tr.insertCell().textContent = row.t ? date(row.t) : "—";
        for (const k of KEYS) tr.insertCell().textContent = number(row[k], k);
      }
      table.replaceChildren(grid);
    } catch {
      if (ticket === this.ticket)
        table.textContent = "Не удалось получить журнал с прибора.";
    }
  }
  async csv() {
    const path = this.endpoint("csv"),
      ticket = this.ticket;
    try {
      const response = await this._hass.fetchWithAuth("/api/" + path);
      if (!response.ok) throw Error();
      const blob = await response.blob();
      if (ticket !== this.ticket) return;
      const url = URL.createObjectURL(blob),
        a = element("a");
      a.href = url;
      a.download = "co2_export.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch {
      if (ticket === this.ticket)
        this.$("table").textContent = "Не удалось скачать CSV с прибора.";
    }
  }
  dialog(action) {
    if (this.busy || !this._hass.user.is_admin) return;
    this.action = action;
    this.$("dialogTitle").textContent = ACTIONS[action][0];
    this.$("dialogText").textContent = ACTIONS[action][1];
    const fields = this.$("fields");
    fields.replaceChildren();
    const field = (name, label, type, value, required = true) => {
      const wrap = element("label", "", label),
        input = element("input");
      input.name = name;
      input.type = type;
      input.required = required;
      if (type === "number") input.step = "any";
      input.value = value ?? "";
      if (type === "password") input.autocomplete = "new-password";
      wrap.append(input);
      fields.append(wrap);
    };
    if (action === "offsets") {
      const d = this.snapshot?.diagnostics || {};
      field("t_off", "Температура, °C", "number", d.t_off);
      field("h_off", "Влажность, %", "number", d.h_off);
    }
    if (action === "wifi") {
      field("ssid", "Имя сети (SSID)", "text", "");
      field("pass", "Пароль Wi-Fi", "password", "", false);
    }
    this.$("dialog").showModal();
  }
  async submit() {
    if (this.busy) return;
    const form = this.$("form"),
      action = this.action,
      ticket = this.ticket,
      fields = Object.fromEntries(new FormData(form));
    if (action === "offsets")
      for (const k of Object.keys(fields)) fields[k] = Number(fields[k]);
    this.busy = true;
    this.$("dialog").close();
    this.$("fields").replaceChildren();
    const buttons = [...this.$("commands").querySelectorAll("button")];
    buttons.forEach((b) => (b.disabled = true));
    const feedback = this.$("feedback");
    feedback.textContent = "Отправка команды…";
    try {
      await this._hass.callApi("POST", this.endpoint(action), fields);
      if (ticket === this.ticket && ["wifi", "factory_reset"].includes(action))
        this.reconnectAfter = Date.now() / 1000 + 3;
      if (ticket === this.ticket)
        feedback.textContent = ["wifi", "factory_reset"].includes(action)
          ? "Запрос принят прибором. После перезапуска проверьте время последнего ответа и IP."
          : "Запрос принят прибором.";
    } catch (err) {
      if (ticket === this.ticket)
        feedback.textContent =
          err.status_code === 403 || err.status === 403
            ? "Требуются права администратора."
            : err.status_code === 400 || err.status === 400
              ? "Проверьте введённые значения."
              : err.status_code === 409 || err.status === 409
                ? "Прибор уже выполняет команду."
                : "Результат неизвестен. Проверьте состояние прибора.";
    } finally {
      this.busy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }
}
customElements.define("senseair-monitor-panel", SenseairPanel);
