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
  form { display: grid; gap: 4px; max-width: 520px; }
  header { margin-bottom: 4px; }
  .progress { list-style: none; display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 16px; padding: 0; font-size: .8em; }
  .progress li { display: flex; align-items: center; gap: 6px; padding: 4px 10px 4px 4px; border-radius: 999px; background: rgba(128,128,128,.12); opacity: .65; }
  .progress li span { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(128,128,128,.35); font-weight: 600; font-size: .9em; }
  .progress li.current { opacity: 1; background: color-mix(in srgb, var(--accent) 16%, transparent); font-weight: 600; }
  .progress li.current span, .progress li.done span { background: var(--accent); color: #fff; }
  .progress li.done { opacity: .9; }
  section h4 { margin: 4px 0 2px; font-size: 1.1em; }
  .intro { margin: 0 0 14px; opacity: .75; font-size: .9em; }
  .roles { display: grid; gap: 10px; margin-bottom: 16px; }
  .role { position: relative; display: grid; gap: 2px; padding: 14px 16px 14px 44px; margin: 0; border: 1.5px solid rgba(128,128,128,.4); border-radius: calc(var(--radius) * 1.5); opacity: 1; font-size: 1em; cursor: pointer; }
  .role input { position: absolute; left: 16px; top: 18px; width: auto; margin: 0; accent-color: var(--accent); }
  .role strong { font-size: 1em; }
  .role span { font-size: .85em; opacity: .75; }
  .role:has(input:checked) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .role:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .summary { margin: 0 0 14px; padding: 12px 14px; border: 1px solid rgba(128,128,128,.4); border-radius: var(--radius); }
  .summary div { display: flex; gap: 12px; justify-content: space-between; padding: 3px 0; }
  .summary dt { opacity: .7; } .summary dd { margin: 0; font-weight: 600; text-align: right; }
  .nav { display: flex; gap: 10px; justify-content: space-between; margin-top: 8px; }
  .nav [data-next], .nav [data-submit] { margin-left: auto; }
  button.ghost { background: transparent; color: inherit; border: 1px solid rgba(128,128,128,.6); }
  [hidden] { display: none !important; }
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

  const ROLES = [
    { key: 'sc', title: 'Spielercharakter (SC)', text: 'Du reist mit eigenem Charakter an.' },
    { key: 'nsc', title: 'Nichtspieler (NSC)', text: 'Du unterstützt die Spielleitung, ob in einer Festrolle oder bei einer Quest.' },
  ];
  const euro = (cents) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

  async function init() {
    if (!code) return say('Kein Event angegeben (data-event fehlt).', 'error');
    let event;
    try {
      event = await call(`/public/events/${encodeURIComponent(code)}`);
    } catch (err) {
      return say(err.message, 'error');
    }
    const scFields = event.scFields ?? [];
    const nscFields = event.nscFields ?? [];
    const priceOptions = event.priceGroups.map((g) => {
      const cents = event.prices[g];
      return `<option value="${esc(g)}">${esc(g)}${Number.isInteger(cents) ? ` (${euro(cents)})` : ''}</option>`;
    }).join('');

    const section = (id, title, intro, body) =>
      `<section data-step="${id}" data-title="${esc(title)}" hidden><h4>${esc(title)}</h4>${intro ? `<p class="intro">${intro}</p>` : ''}${body}</section>`;
    form.innerHTML = `
      <header><h3>${esc(event.name)}</h3><p class="date">${esc(event.eventDate)}</p></header>
      <ol class="progress" aria-label="Fortschritt"></ol>
      ${section('role', 'Teilnahme', 'Wie nimmst du am Event teil?', `
        <div class="roles">${ROLES.map((r, i) => `<label class="role"><input type="radio" name="conRole" value="${r.key}"${i === 0 ? ' checked' : ''}><strong>${esc(r.title)}</strong><span>${esc(r.text)}</span></label>`).join('')}</div>
        ${priceOptions ? `<select id="pk-priceGroup" name="priceGroup">${priceOptions}</select><label for="pk-priceGroup">Teilnahmegruppe</label>` : ''}`)}
      ${section('person', 'Zur Person', 'Damit wir dich erreichen und dein Ticket zuordnen können.', `
        ${field('firstName', 'Vorname', 'text', true)}${field('lastName', 'Nachname', 'text', true)}
        ${field('nickname', 'Rufname')}${field('email', 'E-Mail', 'email', true)}`)}
      ${event.accountFields.length ? section('account', 'Persönliche Angaben', 'Diese Angaben bleiben verschlüsselt gespeichert und helfen uns bei Verpflegung, Sicherheit und Erster Hilfe.', `<div data-fields="account">${event.accountFields.map((f) => fieldHtml(f, 'account')).join('')}</div>`) : ''}
      ${section('sc', 'Dein Charakter', 'Wer wirst du auf dem Event sein?', `
        <label class="check"><input type="checkbox" name="emptyCharacter"> Charakter später ausfüllen – ich melde zunächst einen leeren Charakter an.</label>
        <div class="char-fields">
          ${field('characterName', 'Charaktername', 'text', true)}
          <div data-fields="sc">${scFields.map((f) => fieldHtml(f, 'sc')).join('')}</div>
        </div>`)}
      ${nscFields.length ? section('nsc', 'Dein NSC-Profil', 'Optional – je mehr du uns verrätst, desto besser können wir dich einsetzen.', `<div data-fields="nsc">${nscFields.map((f) => fieldHtml(f, 'nsc')).join('')}</div>`) : ''}
      ${event.registrationFields.length ? section('registration', 'Zur Anmeldung', '', `<div data-fields="registration">${event.registrationFields.map((f) => fieldHtml(f, 'registration')).join('')}</div>`) : ''}
      ${section('confirm', 'Abschluss', 'Bitte prüfe deine Angaben.', `
        <dl class="summary"></dl>
        ${event.waiverHtml ? `<div class="waiver">${event.waiverHtml}</div><label class="check"><input type="checkbox" name="waiverAccepted" required> Ich habe die AGB und die Einverständniserklärung gelesen und stimme zu.</label>` : ''}
        <label class="check"><input type="checkbox" name="conPayer"> Con-Zahler: Ich bezahle erst vor Ort beim Check-In. Das Ticket wird trotzdem ausgestellt und als „Con-Zahler“ gekennzeichnet.</label>`)}
      <div class="nav"><button type="button" class="ghost" data-back>Zurück</button><button type="button" data-next>Weiter</button><button type="submit" data-submit>Ticket sichern</button></div>`;
    say('');
    form.hidden = false;
    form.noValidate = true; // steps are validated one by one, hidden steps must not block submit

    const sections = [...form.querySelectorAll('section')];
    const byId = (id) => sections.find((s) => s.dataset.step === id);
    const roleOf = () => form.querySelector('input[name=conRole]:checked').value;
    // Which steps apply depends on the chosen role: SC gets a character, NSC an optional profile.
    const activeSteps = () => {
      const role = roleOf();
      return sections.filter((s) => {
        const id = s.dataset.step;
        if (id === 'sc') return role === 'sc';
        if (id === 'nsc') return role === 'nsc';
        return true;
      });
    };
    let index = 0;
    const value = (name) => form.elements[name]?.value.trim() ?? '';
    const emptyCharacter = () => roleOf() === 'sc' && Boolean(form.elements.emptyCharacter?.checked);
    const syncEmptyCharacter = () => { form.querySelector('.char-fields').hidden = emptyCharacter(); };

    const fillSummary = () => {
      const role = ROLES.find((r) => r.key === roleOf());
      const rows = [['Teilnahme', role.title]];
      if (form.elements.priceGroup) {
        const g = form.elements.priceGroup.value;
        rows.push(['Teilnahmegruppe', `${g}${Number.isInteger(event.prices[g]) ? ` – ${euro(event.prices[g])}` : ''}`]);
      }
      rows.push(['Name', [value('firstName'), value('lastName')].join(' ')], ['E-Mail', value('email')]);
      if (roleOf() === 'sc') rows.push(['Charakter', emptyCharacter() ? 'leer – wird später ausgefüllt' : value('characterName')]);
      form.querySelector('.summary').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    };

    const show = (i) => {
      const steps = activeSteps();
      index = Math.max(0, Math.min(i, steps.length - 1));
      sections.forEach((s) => { s.hidden = s !== steps[index]; });
      if (steps[index].dataset.step === 'confirm') fillSummary();
      form.querySelector('.progress').innerHTML = steps.map((s, n) =>
        `<li class="${n < index ? 'done' : ''}${n === index ? ' current' : ''}"><span>${n < index ? '✓' : n + 1}</span>${esc(s.dataset.title)}</li>`).join('');
      const last = index === steps.length - 1;
      form.querySelector('[data-back]').hidden = index === 0;
      form.querySelector('[data-next]').hidden = last;
      form.querySelector('[data-submit]').hidden = !last;
      say('');
    };
    const valid = () => {
      for (const el of activeSteps()[index].querySelectorAll('input, select, textarea')) {
        if (el.closest('[hidden]')) continue;
        if (!el.checkValidity()) { el.reportValidity(); return false; }
      }
      return true;
    };
    form.querySelector('[data-next]').addEventListener('click', () => { if (valid()) show(index + 1); });
    form.querySelector('[data-back]').addEventListener('click', () => show(index - 1));
    form.querySelectorAll('input[name=conRole]').forEach((r) => r.addEventListener('change', () => show(index)));
    form.elements.emptyCharacter.addEventListener('change', syncEmptyCharacter);
    show(0);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!valid()) return;
      if (index < activeSteps().length - 1) return show(index + 1); // Enter key on an early step
      const button = form.querySelector('[data-submit]');
      button.disabled = true;
      say('');
      const role = roleOf();
      const data = {
        conRole: role,
        firstName: value('firstName'), lastName: value('lastName'), nickname: value('nickname'), email: value('email'),
        waiverAccepted: Boolean(form.elements.waiverAccepted?.checked),
        conPayer: Boolean(form.elements.conPayer?.checked),
        accountData: collectFields(form.querySelector('[data-fields=account]'), event.accountFields),
        registrationData: collectFields(form.querySelector('[data-fields=registration]'), event.registrationFields),
      };
      if (form.elements.priceGroup) data.priceGroup = form.elements.priceGroup.value;
      if (role === 'sc') {
        data.character = emptyCharacter()
          ? { empty: true }
          : { name: value('characterName'), data: collectFields(form.querySelector('[data-fields=sc]'), scFields) };
      }
      if (role === 'nsc') data.character = { data: collectFields(form.querySelector('[data-fields=nsc]'), nscFields) };
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
        if (result.ticketUrl) msg.insertAdjacentHTML('beforeend', ` <a href="${base}${result.ticketUrl}">Ticket anzeigen</a>`);
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
