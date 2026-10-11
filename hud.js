// Einblendungen, die im Kamerabild liegen (damit sie auch in der Brille sichtbar sind).
export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lastKey = '';
  }

  // Zeichnet nur neu, wenn sich etwas geändert hat. Gibt true zurück, wenn neu gezeichnet wurde.
  draw(state) {
    const { w, h } = { w: this.canvas.width, h: this.canvas.height };
    const key = JSON.stringify([w, h, state]);
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    // Maßeinheit nach der kürzeren Seite, damit Texte auch hochkant ins Bild passen.
    const u = Math.min(w, h) / 100;

    if (state.grid) this._grid(c, w, h, u);

    if (state.clear) {
      c.lineWidth = 2.5 * u;
      c.strokeStyle = 'rgba(198, 242, 78, 0.95)';
      c.strokeRect(1.5 * u, 1.5 * u, w - 3 * u, h - 3 * u);
      this._label(c, 'SICHT FREI', w / 2, 14 * u, 7 * u, 'rgba(20, 24, 12, 0.85)', '#c6f24e');
    } else if (state.nozzle) {
      // Zielmarke des Strahlrohrs: Ring in der Breite des Strahlkegels, darunter die Strahlart.
      const { coneRadius, label, wide } = state.nozzle;
      const color = state.spraying ? 'rgba(160, 210, 255, 0.95)' : 'rgba(255, 255, 255, 0.6)';
      c.strokeStyle = color;
      c.fillStyle = color;
      c.lineWidth = 0.4 * u;
      c.beginPath();
      c.arc(w / 2, h / 2, 0.7 * u, 0, Math.PI * 2);
      c.fill();
      c.setLineDash(wide ? [1.6 * u, 1.2 * u] : []);
      c.beginPath();
      c.arc(w / 2, h / 2, Math.max(2.2 * u, coneRadius), 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
      c.font = `600 ${2.8 * u}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'top';
      c.fillStyle = 'rgba(0, 0, 0, 0.5)';
      const tw = c.measureText(label).width;
      // Bei breitem Kegel bleibt die Beschriftung nahe der Mitte, damit sie in der Brille sichtbar ist.
      const y = h / 2 + (coneRadius < 8 * u ? Math.max(2.2 * u, coneRadius) : 2.2 * u) + 1.2 * u;
      c.fillRect(w / 2 - tw / 2 - u, y - 0.4 * u, tw + 2 * u, 3.6 * u);
      c.fillStyle = color;
      c.fillText(label, w / 2, y);
    }

    if (state.headline) {
      this._label(c, state.headline, w / 2, h / 2 - 12 * u, 8 * u, 'rgba(120, 20, 0, 0.85)', '#ffe2c4');
    }

    state.toasts.forEach((t, i) => {
      const colors = {
        info: ['rgba(18, 21, 25, 0.78)', '#eef1f4'],
        ok: ['rgba(20, 60, 30, 0.85)', '#d6ffd9'],
        warn: ['rgba(120, 52, 0, 0.88)', '#ffe0b8'],
      }[t.kind || 'info'];
      this._label(c, t.text, w / 2, h * 0.7 + i * 7.5 * u, 4.6 * u, colors[0], colors[1]);
    });

    if (state.debug && state.debug.length) {
      c.font = `${2.6 * u}px ui-monospace, Menlo, Consolas, monospace`;
      c.textAlign = 'left';
      c.textBaseline = 'top';
      const x = w * 0.27;
      let y = h * 0.24;
      const lineH = 3.4 * u;
      c.fillStyle = 'rgba(0, 0, 0, 0.55)';
      c.fillRect(x - u, y - u, 46 * u, state.debug.length * lineH + 2 * u);
      c.fillStyle = '#d7f7ff';
      for (const line of state.debug) {
        c.fillText(line, x, y);
        y += lineH;
      }
    }
    return true;
  }

  _label(c, text, x, y, size, bg, fg) {
    c.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const tw = c.measureText(text).width;
    const padX = size * 0.6;
    const boxH = size * 1.5;
    c.fillStyle = bg;
    this._round(c, x - tw / 2 - padX, y - boxH / 2, tw + padX * 2, boxH, boxH * 0.25);
    c.fill();
    c.fillStyle = fg;
    c.fillText(text, x, y + size * 0.04);
  }

  _round(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  _grid(c, w, h, u) {
    c.strokeStyle = 'rgba(0, 255, 200, 0.6)';
    c.lineWidth = 0.25 * u;
    for (let i = -8; i <= 8; i++) {
      const x = w / 2 + i * 10 * u;
      const y = h / 2 + i * 10 * u;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    c.strokeStyle = 'rgba(255, 60, 160, 0.8)';
    c.lineWidth = 0.4 * u;
    for (const r of [25, 50]) {
      c.beginPath();
      c.arc(w / 2, h / 2, r * u, 0, Math.PI * 2);
      c.stroke();
    }
  }
}
