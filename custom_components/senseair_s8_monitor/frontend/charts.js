const METRICS = {
  co2: { name: "CO₂", unit: "ppm", color: "#199675", digits: 0 },
  temp: { name: "Температура", unit: "°C", color: "#db7c36", digits: 1 },
  hum: { name: "Влажность", unit: "%", color: "#3484c5", digits: 1 },
  press: { name: "Давление", unit: "мм рт. ст.", color: "#a170ce", digits: 1 },
};
function number(value, key) {
  return Number.isFinite(value)
    ? value.toLocaleString("ru-RU", {
        maximumFractionDigits: METRICS[key].digits,
      })
    : "—";
}
function summary(rows) {
  let low = Infinity,
    high = -Infinity,
    area = 0,
    duration = 0,
    last = null;
  for (const [start, end, mean, min, max, observed] of rows) {
    if (![mean, min, max].every(Number.isFinite)) continue;
    low = Math.min(low, min);
    high = Math.max(high, max);
    last = mean;
    const weight = Math.max(0, observed ?? end - start);
    duration += weight;
    area += mean * weight;
  }
  return {
    min: last === null ? null : low,
    max: last === null ? null : high,
    mean: duration ? area / duration : last,
  };
}
function element(tag, cls, value) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (value !== undefined) el.textContent = value;
  return el;
}
const longDate = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
class AirChart {
  constructor(host, multi) {
    this.multi = multi;
    this.box = element("div", "plot");
    this.canvas = element("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.tip = element("div", "tip");
    this.tip.hidden = true;
    this.note = element("div", "scale");
    this.box.append(this.canvas, this.tip);
    host.append(this.box, this.note);
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(this.canvas);
    this.canvas.onpointermove = (e) =>
      this.probe(e.clientX - this.canvas.getBoundingClientRect().left);
    this.canvas.onpointerdown = this.canvas.onpointermove;
    this.canvas.onpointerleave = () => this.clear();
    this.canvas.onblur = () => this.clear();
    this.canvas.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "Escape"].includes(e.key)) return;
      e.preventDefault();
      if (e.key === "Escape") return this.clear();
      this.probe(
        (this.cursor ?? this.w / 2) +
          ((e.key === "ArrowRight" ? 1 : -1) * this.w) / 60,
      );
    };
  }
  close() {
    this.resize.disconnect();
  }
  clear() {
    this.cursor = null;
    this.tip.hidden = true;
    this.draw();
  }
  set(data, keys, period) {
    this.data = data;
    this.keys = keys;
    this.period = period;
    this.note.replaceChildren();
    this.stats = {};
    for (const key of keys) {
      const s = summary(data.series[key] || []);
      this.stats[key] = s;
      if (this.multi && s.mean !== null) {
        const text = element(
          "span",
          "",
          `${METRICS[key].name}  ${number(s.min, key)}–${number(s.max, key)} ${METRICS[key].unit}`,
        );
        this.note.append(text);
      }
    }
    this.canvas.setAttribute(
      "aria-label",
      keys.map((k) => METRICS[k].name).join(", ") +
        ". Стрелки влево и вправо — значения по времени.",
    );
    this.cursor = null;
    this.tip.hidden = true;
    this.draw();
  }
  timeLabel(ts) {
    const options =
      this.period === "year"
        ? { month: "short", day: "numeric" }
        : this.period === "week"
          ? { weekday: "short", day: "numeric" }
          : { hour: "2-digit", minute: "2-digit" };
    return new Date(ts * 1000).toLocaleString("ru-RU", options);
  }
  draw() {
    if (!this.data) return;
    const canvas = this.canvas,
      w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (!w || !h) return;
    this.w = w;
    const pixel = window.devicePixelRatio || 1;
    if (
      canvas.width !== Math.round(w * pixel) ||
      canvas.height !== Math.round(h * pixel)
    ) {
      canvas.width = Math.round(w * pixel);
      canvas.height = Math.round(h * pixel);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(pixel, 0, 0, pixel, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const theme = getComputedStyle(this.box);
    // Resolve theme variables before assigning a browser canvas color.
    ctx.fillStyle = theme.color;
    ctx.font = "11px system-ui";
    ctx.lineWidth = 1;
    this.left = this.multi ? 9 : 48;
    this.right = w - 9;
    const top = 16,
      bottom = h - 26;
    const { start, end, series } = this.data;
    const x = (t) =>
      this.left + ((t - start) / (end - start)) * (this.right - this.left);
    for (let i = 0; i <= 4; i++) {
      const y = top + ((bottom - top) * i) / 4;
      ctx.strokeStyle = theme.color;
      ctx.globalAlpha = 0.12;
      ctx.beginPath();
      ctx.moveTo(this.left, y);
      ctx.lineTo(this.right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
      if (w > 360 || i % 2 === 0)
        ctx.fillText(
          this.timeLabel(start + ((end - start) * i) / 4),
          x(start + ((end - start) * i) / 4),
          h - 5,
        );
    }
    let any = false;
    for (const key of this.keys) {
      const s = this.stats[key],
        m = METRICS[key];
      if (s.mean === null) continue;
      any = true;
      const pad = (s.max - s.min) * 0.09 || (key === "co2" ? 1 : 0.1);
      const lo = s.min - pad,
        hi = s.max + pad;
      const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
      if (!this.multi) {
        ctx.textAlign = "right";
        ctx.fillStyle = theme.color;
        for (let i = 0; i < 3; i++)
          ctx.fillText(
            number(lo + ((hi - lo) * i) / 2, key),
            this.left - 5,
            y(lo + ((hi - lo) * i) / 2) + 3,
          );
      }
      let group = [];
      const paint = () => {
        if (!group.length) return;
        ctx.fillStyle = m.color;
        ctx.strokeStyle = m.color;
        if (!this.multi && this.period !== "hour") {
          ctx.globalAlpha = 0.17;
          ctx.beginPath();
          for (const [a, b, , low] of group) {
            ctx.lineTo(x(a), y(low));
            ctx.lineTo(x(b), y(low));
          }
          for (let j = group.length - 1; j >= 0; j--) {
            const [a, b, , , high] = group[j];
            ctx.lineTo(x(b), y(high));
            ctx.lineTo(x(a), y(high));
          }
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        for (const [a, b, mean] of group) {
          ctx.lineTo(x(a), y(mean));
          ctx.lineTo(x(b), y(mean));
        }
        ctx.lineWidth = this.multi ? 2 : 2.2;
        ctx.stroke();
        const last = group.at(-1);
        ctx.beginPath();
        ctx.arc(x(last[1]), y(last[2]), 2.25, 0, Math.PI * 2);
        ctx.fill();
        group = [];
      };
      for (const row of series[key]) {
        if (row[2] === null) {
          paint();
          continue;
        }
        if (group.length && row[0] - group.at(-1)[1] > 1) paint();
        group.push(row);
      }
      paint();
    }
    if (!any) {
      ctx.fillStyle = theme.color;
      ctx.textAlign = "center";
      ctx.font = "14px system-ui";
      ctx.fillText(
        this.keys.length
          ? this.period === "year"
            ? "Нет почасовой статистики за период"
            : "Нет данных за период"
          : "Выберите показатели выше",
        w / 2,
        h / 2,
      );
    }
    if (this.cursor != null) {
      ctx.strokeStyle = theme.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(this.cursor, top);
      ctx.lineTo(this.cursor, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  probe(px) {
    if (!this.data || !this.keys.length || !this.w) return;
    this.cursor = Math.max(this.left, Math.min(this.right, px));
    const t =
      this.data.start +
      ((this.cursor - this.left) / (this.right - this.left)) *
        (this.data.end - this.data.start);
    const lines = [longDate.format(t * 1000)];
    for (const key of this.keys) {
      const row = this.data.series[key].find((r) => r[0] <= t && t <= r[1]);
      const m = METRICS[key];
      if (!row || row[2] === null) {
        lines.push(m.name + " · —");
        continue;
      }
      if (this.period === "hour")
        lines.push(`${m.name} · ${number(row[2], key)} ${m.unit}`);
      else
        lines.push(
          `${longDate.format(row[0] * 1000)} – ${longDate.format(row[1] * 1000)}\n${m.name} · мин ${number(row[3], key)} / ср ${number(row[2], key)} / макс ${number(row[4], key)} ${m.unit}`,
        );
    }
    this.tip.textContent = lines.join("\n");
    this.tip.hidden = false;
    this.tip.style.top = "0px";
    this.tip.style.left =
      Math.max(0, Math.min(this.w - this.tip.offsetWidth, this.cursor + 8)) +
      "px";
    this.draw();
  }
}
export { AirChart, METRICS, element, number, summary };
