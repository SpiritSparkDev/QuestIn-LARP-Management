// Embeddable widgets for any website.
// Ticket form:
//   <script src="https://<host>/widget.js" data-event="<QR-Kennung>" defer></script>
// Countdown with button (counts down to data-until, else to the event date):
//   <script src="https://<host>/widget.js" data-widget="countdown" data-event="<QR-Kennung>"
//           data-until="2027-09-01T10:00" data-button="Ticket sichern" defer></script>
//   data-href sets where the button leads (default: the ticket form page).
// The form is rendered into the host page (inside a shadow root, so page CSS
// can't break it and ours can't leak). It inherits the page's font and text
// colour; set --pk-accent / --pk-radius on the script's parent to restyle.
// Optional: data-target="#some-id" mounts it there instead of after the tag.
//
// Frameworks (React/Next.js, Vue, ...) do not run <script> tags that are part
// of a rendered template. There, load widget.js once (e.g. next/script) and
// put placeholders where the widget should appear:
//   <div data-pakyrion="ticket" data-event="<QR-Kennung>"></div>
//   <div data-pakyrion="countdown" data-event="<QR-Kennung>" data-until="..."></div>
// Placeholders that are rendered later are picked up automatically.
(() => {
  const own = document.currentScript || [...document.scripts].reverse().find((s) => /\/widget\.js(\?|$)/.test(s.src));
  if (!own) return;
  const base = new URL(own.src).origin;

  function mount(host, cfg) {
  const code = cfg.event;
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
<style>
  :host { display: block; font: inherit; color: inherit; --accent: var(--pk-accent, #9c4a1a); --radius: var(--pk-radius, 6px); }
  * { box-sizing: border-box; font: inherit; }
  form { display: grid; gap: 4px; max-width: 480px; }
  h3 { margin: 0; font-size: 1.25em; font-weight: 600; }
  h4 { margin: 18px 0 8px; font-size: 1em; font-weight: 600; }
  .multi > span { display: block; margin-bottom: 4px; }
  textarea { width: 100%; padding: 10px 12px; border: 1px solid rgba(128,128,128,.6); border-radius: var(--radius); background: transparent; color: inherit; }
  .date { margin: 0 0 12px; opacity: .7; }
  input, select { width: 100%; padding: 10px 12px; border: 1px solid rgba(128,128,128,.6); border-radius: var(--radius); background: transparent; color: inherit; }
  input[type=checkbox] { width: auto; margin-right: 8px; }
  label { font-size: .8em; opacity: .75; margin-bottom: 10px; }
  label.check { font-size: .9em; opacity: 1; display: flex; align-items: flex-start; margin: 4px 0 14px; }
  .waiver { max-height: 160px; overflow: auto; font-size: .85em; padding: 8px 12px; margin-bottom: 6px; border: 1px solid rgba(128,128,128,.4); border-radius: var(--radius); }
  button { padding: 12px 18px; border: 0; border-radius: var(--radius); background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cd { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0 16px; }
  .cd div { min-width: 64px; padding: 10px 8px; text-align: center; border: 1px solid rgba(128,128,128,.4); border-radius: var(--radius); }
  .cd strong { display: block; font-size: 1.8em; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .cd span { font-size: .75em; opacity: .7; }
  a.btn { display: inline-block; padding: 12px 18px; border-radius: var(--radius); background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; }
  a.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .msg { margin: 0 0 12px; } .error { color: #b3261e; } .success { color: #1b6e3a; }
</style>
<div class="msg" role="status">Lädt …</div>
<form hidden></form>`;

  const msg = root.querySelector('.msg');
  const form = root.querySelector('form');
  const say = (text, kind) => { msg.textContent = text; msg.className = `msg ${kind ?? ''}`; msg.hidden = !text; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const field = (name, label, type = 'text', required = false) =>
    `<input id="pk-${name}" name="${name}" type="${type}"${required ? ' required' : ''}><label for="pk-${name}">${label}</label>`;

  // Schema-driven extra fields (same definitions as in the app). "Dokument"
  // fields are plain text areas here; the server cleans them anyway.
  const fieldHtml = (f, prefix) => {
    const id = `pk-${prefix}-${f.key}`;
    const label = esc(f.label ?? f.key) + (f.required ? ' *' : '');
    const req = f.required ? ' required' : '';
    const opts = (f.options ?? []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    if (f.type === 'boolean') return `<label class="check"><input type="checkbox" data-field="${esc(f.key)}"${req}> ${label}</label>`;
    if (f.type === 'multiselect') {
      return `<div class="multi"><span>${label}</span>${(f.options ?? []).map((o) => `<label class="check"><input type="checkbox" data-field="${esc(f.key)}" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>`;
    }
    let control;
    if (f.type === 'select') control = `<select id="${id}" data-field="${esc(f.key)}"${req}><option value=""></option>${opts}</select>`;
    else if (f.type === 'textarea' || f.type === 'document') control = `<textarea id="${id}" data-field="${esc(f.key)}" rows="3"${req}></textarea>`;
    else control = `<input id="${id}" data-field="${esc(f.key)}" type="${{ number: 'number', date: 'date', link: 'url' }[f.type] ?? 'text'}"${req}>`;
    return `${control}<label for="${id}">${label}</label>`;
  };
  const fieldsSection = (title, fields, prefix) => (fields?.length
    ? `<h4>${esc(title)}</h4><div data-fields="${prefix}">${fields.map((f) => fieldHtml(f, prefix)).join('')}</div>` : '');
  const collectFields = (container, fields) => {
    const out = {};
    for (const f of fields ?? []) {
      const inputs = [...(container?.querySelectorAll('[data-field]') ?? [])].filter((i) => i.dataset.field === f.key);
      if (inputs.length === 0) continue;
      if (f.type === 'boolean') out[f.key] = inputs[0].checked;
      else if (f.type === 'multiselect') out[f.key] = inputs.filter((i) => i.checked).map((i) => i.value);
      else if (f.type === 'number') out[f.key] = inputs[0].value === '' ? null : Number(inputs[0].value);
      else out[f.key] = inputs[0].value;
    }
    return out;
  };

  async function call(path, options) {
    const res = await fetch(base + path, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Fehler ${res.status}`);
    return body;
  }

  async function init() {
    if (!code) return say('Kein Event angegeben (data-event fehlt).', 'error');
    let event;
    try {
      event = await call(`/public/events/${encodeURIComponent(code)}`);
    } catch (err) {
      return say(err.message, 'error');
    }
    const groups = event.priceGroups.map((g) => {
      const cents = event.prices[g];
      return `<option value="${esc(g)}">${esc(g)}${Number.isInteger(cents) ? ` (${(cents / 100).toFixed(2).replace('.', ',')} €)` : ''}</option>`;
    }).join('');
    form.innerHTML = `
      <h3>${esc(event.name)}</h3><p class="date">${esc(event.eventDate)}</p>
      ${field('firstName', 'Vorname', 'text', true)}
      ${field('lastName', 'Nachname', 'text', true)}
      ${field('nickname', 'Rufname')}
      ${field('email', 'E-Mail', 'email', true)}
      ${groups ? `<select id="pk-priceGroup" name="priceGroup">${groups}</select><label for="pk-priceGroup">Teilnahmegruppe</label>` : ''}
      ${fieldsSection('Persönliche Angaben', event.accountFields, 'account')}
      ${fieldsSection('Angaben zur Anmeldung', event.registrationFields, 'registration')}
      ${event.waiverHtml ? `<div class="waiver">${event.waiverHtml}</div><label class="check"><input type="checkbox" name="waiverAccepted" required> Ich habe die AGB und die Einverständniserklärung gelesen und stimme zu.</label>` : ''}
      <button type="submit">Ticket sichern</button>`;
    say('');
    form.hidden = false;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      say('');
      const data = Object.fromEntries(new FormData(form));
      data.waiverAccepted = Boolean(form.elements.waiverAccepted?.checked);
      data.accountData = collectFields(form.querySelector('[data-fields=account]'), event.accountFields);
      data.registrationData = collectFields(form.querySelector('[data-fields=registration]'), event.registrationFields);
      try {
        const result = await call(`/public/events/${event.id}/guest-registration`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (result.paymentUrl) {
          window.location.href = base + result.paymentUrl;
          return;
        }
        form.hidden = true;
        say('Dein Ticket ist gesichert! Du erhältst eine Bestätigung per E-Mail.', 'success');
      } catch (err) {
        say(err.message, 'error');
        button.disabled = false;
      }
    });
  }

  async function initCountdown() {
    let title = cfg.title ?? '';
    let target = cfg.until ? new Date(cfg.until) : null;
    if (!target || !title) {
      if (!code) return say('Kein Event angegeben (data-event fehlt).', 'error');
      try {
        const event = await call(`/public/events/${encodeURIComponent(code)}`);
        title = title || event.name;
        target ??= new Date(`${event.eventDate}T00:00:00`);
      } catch (err) {
        if (!target) return say(err.message, 'error');
      }
    }
    if (Number.isNaN(target.getTime())) return say('data-until ist kein gültiges Datum.', 'error');
    const href = cfg.href || (code ? `${base}/ticket-widget.html?event=${encodeURIComponent(code)}` : base);
    say('');
    form.outerHTML = `
      <div class="wrap">
        ${title ? `<h3>${esc(title)}</h3>` : ''}
        <div class="cd" aria-live="off"></div>
        <p class="done msg" hidden>${esc(cfg.done ?? 'Es geht los!')}</p>
        <a class="btn" href="${esc(href)}" target="_blank" rel="noopener">${esc(cfg.button ?? 'Ticket sichern')}</a>
      </div>`;
    const cd = root.querySelector('.cd');
    const doneEl = root.querySelector('.done');
    const unit = (n, label) => `<div><strong>${n}</strong><span>${label}</span></div>`;
    const tick = () => {
      const left = Math.max(0, Math.floor((target - Date.now()) / 1000));
      cd.hidden = left === 0;
      doneEl.hidden = left !== 0;
      cd.innerHTML = unit(Math.floor(left / 86400), 'Tage') + unit(Math.floor(left % 86400 / 3600), 'Std.')
        + unit(Math.floor(left % 3600 / 60), 'Min.') + unit(left % 60, 'Sek.');
      if (left === 0) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    tick();
  }

  (cfg.widget === 'countdown' || cfg.pakyrion === 'countdown' ? initCountdown : init)();
  }

  if (own.dataset.event || own.dataset.widget) {
    const host = document.createElement('div');
    const target = own.dataset.target && document.querySelector(own.dataset.target);
    if (target) target.appendChild(host);
    else own.insertAdjacentElement('afterend', host);
    mount(host, own.dataset);
  }

  const scan = () => document.querySelectorAll('[data-pakyrion]:not([data-pk-mounted])').forEach((el) => {
    el.dataset.pkMounted = '1';
    mount(el, el.dataset);
  });
  scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
})();
