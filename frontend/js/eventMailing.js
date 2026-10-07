// "Rundmail" tab of the event form: WYSIWYG/HTML editor, recipient selection
// (registered people with filters + manually typed addresses), test mail,
// send with progress, history.
import { api } from './api.js';
import { escapeHtml, STATUS_LABELS } from './formFields.js';
import { notify } from './notifications.js';

const ROLE_LABELS = { sc: 'SC', nsc: 'NSC', ticket: 'Ticket', helfer: 'Helfer', orga: 'Orga', hilfs_orga: 'Hilfs-Orga' };
const STATUSES = ['notified', 'pending', 'waitlisted', 'confirmed', 'checked_in', 'checked_out', 'cancelled'];
const TOOLS = [
  ['bold', 'format_bold', 'Fett'], ['italic', 'format_italic', 'Kursiv'], ['underline', 'format_underlined', 'Unterstrichen'],
  ['heading', 'title', 'Überschrift'], ['insertUnorderedList', 'format_list_bulleted', 'Aufzählung'],
  ['insertOrderedList', 'format_list_numbered', 'Nummerierte Liste'], ['link', 'link', 'Link einfügen'],
  ['image', 'image', 'Bild per Adresse einfügen'], ['removeFormat', 'format_clear', 'Formatierung entfernen'],
];

export function renderMailingPanel() {
  return `
    <p class="sub" id="mailing-unsaved">Speichere das Event zuerst, dann kannst du hier Rundmails senden.</p>
    <div id="mailing-body" hidden>
      <input id="mailing-subject" type="text" maxlength="200">
      <label for="mailing-subject">Betreff</label>

      <div class="mail-editor">
        <div class="mail-toolbar" role="toolbar" aria-label="Textformatierung">
          ${TOOLS.map(([cmd, icon, label]) => `<button type="button" class="rte-btn" data-mail-cmd="${cmd}" title="${label}" aria-label="${label}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span></button>`).join('')}
          <button type="button" class="btn-sm btn-ghost" data-mail-cmd="source">&lt;/&gt; HTML</button>
        </div>
        <div class="mail-wysiwyg" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Nachricht"></div>
        <textarea class="mail-source" rows="12" spellcheck="false" hidden aria-label="HTML-Quelltext"></textarea>
      </div>
      <p class="sub">Du kannst direkt schreiben oder über „&lt;/&gt; HTML" eigenen HTML-Code einfügen. Skripte und Formulare werden beim Senden entfernt.</p>

      <h4>Empfänger</h4>
      <label class="checkbox-row"><input type="checkbox" id="mailing-registered"> Alle Angemeldeten dieses Events anschreiben</label>
      <details id="mailing-filter" class="mailing-filter">
        <summary>Nach Kriterien filtern</summary>
        <p class="sub">Ohne Auswahl bei „Rolle" werden alle Rollen angeschrieben.</p>
        <fieldset><legend>Status</legend>${STATUSES.map((s) => `<label class="check-chip"><input type="checkbox" data-mail-status="${s}"${s === 'cancelled' ? '' : ' checked'}> ${escapeHtml(STATUS_LABELS[s] ?? s)}</label>`).join('')}</fieldset>
        <fieldset><legend>Rolle</legend>${Object.entries(ROLE_LABELS).map(([k, v]) => `<label class="check-chip"><input type="checkbox" data-mail-role="${k}"> ${v}</label>`).join('')}</fieldset>
        <select id="mailing-payment"><option value="any">egal</option><option value="paid">nur Bezahlte</option><option value="unpaid">nur Unbezahlte</option></select>
        <label for="mailing-payment">Zahlung</label>
        <label class="checkbox-row"><input type="checkbox" id="mailing-guests"> Nur Gast-Anmeldungen (ohne Konto)</label>
      </details>
      <textarea id="mailing-manual" rows="3" placeholder="name@example.org, andere@example.org"></textarea>
      <label for="mailing-manual">Weitere E-Mail-Adressen <span style="opacity:0.6;font-size:12px;">kommagetrennt, z. B. von Leuten, die dir ihre Adresse selbst gegeben haben</span></label>
      <p class="sub" id="mailing-count" aria-live="polite"></p>

      <div class="mailing-actions">
        <button type="button" id="mailing-test" class="btn-secondary">Testmail an mich</button>
        <button type="button" id="mailing-send">Rundmail senden</button>
      </div>
      <p id="mailing-progress" class="sub" aria-live="polite"></p>

      <h4>Bisher gesendet</h4>
      <div id="mailing-history"><p class="sub">Noch keine Rundmails.</p></div>
    </div>`;
}

export function initEventMailing(panel) {
  const $ = (sel) => panel.querySelector(sel);
  const wysiwyg = $('.mail-wysiwyg');
  const source = $('.mail-source');
  let eventId = null;
  let poll = null;

  const sourceMode = () => !source.hidden;
  const getHtml = () => (sourceMode() ? source.value : wysiwyg.innerHTML).trim();

  function toggleSource() {
    if (sourceMode()) { wysiwyg.innerHTML = source.value; source.hidden = true; wysiwyg.hidden = false; }
    else { source.value = wysiwyg.innerHTML; source.hidden = false; wysiwyg.hidden = true; }
  }

  panel.addEventListener('mousedown', (e) => { if (e.target.closest('[data-mail-cmd]')) e.preventDefault(); });
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mail-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.mailCmd;
    if (cmd === 'source') return toggleSource();
    if (sourceMode()) return;
    wysiwyg.focus();
    if (cmd === 'heading') document.execCommand('formatBlock', false, 'h3');
    else if (cmd === 'link') { const url = window.prompt('Link-Adresse (https://…)'); if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) document.execCommand('createLink', false, url.trim()); }
    else if (cmd === 'image') { const url = window.prompt('Bild-Adresse (https://…)'); if (url && /^https?:\/\//i.test(url.trim())) document.execCommand('insertImage', false, url.trim()); }
    else document.execCommand(cmd, false, null);
  });
  $('#mailing-subject').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

  const filter = () => ({
    statuses: [...panel.querySelectorAll('[data-mail-status]:checked')].map((i) => i.dataset.mailStatus),
    conRoles: [...panel.querySelectorAll('[data-mail-role]:checked')].map((i) => i.dataset.mailRole),
    payment: $('#mailing-payment').value,
    guestsOnly: $('#mailing-guests').checked,
  });
  const recipientsPayload = () => ({ includeRegistered: $('#mailing-registered').checked, filter: filter(), manualEmails: $('#mailing-manual').value });

  let countTimer = null;
  async function refreshCount() {
    if (!eventId) return;
    try {
      const r = await api.post(`/events/${eventId}/mailing/preview`, recipientsPayload());
      const parts = [`<strong>${r.total}</strong> Empfänger`];
      if (r.registered || r.manual) parts.push(`(${r.registered} aus Anmeldungen, ${r.manual} manuell)`);
      let html = parts.join(' ');
      if (r.invalid.length) html += ` – <span class="error">ungültig: ${escapeHtml(r.invalid.slice(0, 5).join(', '))}</span>`;
      if (r.withoutEmail) html += ` – ${r.withoutEmail} Anmeldung(en) ohne E-Mail-Adresse werden nicht erreicht`;
      if (r.total > r.max) html += ` – <span class="error">maximal ${r.max} pro Rundmail</span>`;
      $('#mailing-count').innerHTML = html;
    } catch (err) {
      $('#mailing-count').textContent = err.message;
    }
  }
  const scheduleCount = () => { clearTimeout(countTimer); countTimer = setTimeout(refreshCount, 300); };
  panel.addEventListener('input', (e) => { if (e.target.closest('#mailing-filter, #mailing-manual, #mailing-registered')) scheduleCount(); });
  panel.addEventListener('change', (e) => { if (e.target.closest('#mailing-filter, #mailing-registered')) scheduleCount(); });

  async function loadHistory() {
    if (!eventId) return null;
    const list = await api.get(`/events/${eventId}/mailings`);
    $('#mailing-history').innerHTML = list.length === 0 ? '<p class="sub">Noch keine Rundmails.</p>' : `<ul class="mailing-history">${list.map((m) => `
      <li><strong>${escapeHtml(m.subject)}</strong>${m.testOnly ? ' <span class="tag">Test</span>' : ''}
        <span class="sub">${escapeHtml(new Date(m.createdAt).toLocaleString('de-DE'))}${m.sentBy ? ` · ${escapeHtml(m.sentBy)}` : ''} ·
        ${m.status === 'done' ? `${m.sentCount} von ${m.recipientCount} gesendet${m.failedCount ? `, <span class="error">${m.failedCount} fehlgeschlagen${m.failedAddresses.length ? `: ${escapeHtml(m.failedAddresses.slice(0, 5).join(', '))}` : ''}</span>` : ''}` : `wird gesendet … ${m.sentCount}/${m.recipientCount}`}</span></li>`).join('')}</ul>`;
    return list;
  }

  function watch(mailingId) {
    clearInterval(poll);
    poll = setInterval(async () => {
      const list = await loadHistory().catch(() => null);
      const m = list?.find((x) => x.id === mailingId);
      if (!m) return;
      $('#mailing-progress').textContent = m.status === 'done' ? `Fertig: ${m.sentCount} von ${m.recipientCount} gesendet.` : `Sende … ${m.sentCount}/${m.recipientCount}`;
      if (m.status === 'done') { clearInterval(poll); setButtons(true); }
    }, 1200);
  }

  const setButtons = (on) => { $('#mailing-send').disabled = !on; $('#mailing-test').disabled = !on; };

  async function send(testOnly) {
    const subject = $('#mailing-subject').value.trim();
    const bodyHtml = getHtml();
    if (!subject) return notify('Bitte gib einen Betreff an.', 'error');
    if (!bodyHtml) return notify('Bitte schreibe einen Nachrichtentext.', 'error');
    if (!testOnly) {
      const r = await api.post(`/events/${eventId}/mailing/preview`, recipientsPayload()).catch(() => null);
      if (!r || r.total === 0) return notify('Es sind keine Empfänger ausgewählt.', 'error');
      if (!window.confirm(`Rundmail „${subject}“ an ${r.total} Empfänger senden? Das lässt sich nicht zurückholen.`)) return;
    }
    setButtons(false);
    try {
      const { id, total } = await api.post(`/events/${eventId}/mailing`, { subject, bodyHtml, testOnly, ...recipientsPayload() });
      $('#mailing-progress').textContent = `Sende … 0/${total}`;
      watch(id);
    } catch (err) {
      notify(err.message, 'error');
      setButtons(true);
    }
  }
  $('#mailing-send').addEventListener('click', () => send(false));
  $('#mailing-test').addEventListener('click', () => send(true));

  return {
    // Called when the event form opens: a new, unsaved event has no mailings yet.
    setEvent(id) {
      eventId = id;
      clearInterval(poll);
      $('#mailing-unsaved').hidden = Boolean(id);
      $('#mailing-body').hidden = !id;
      $('#mailing-progress').textContent = '';
      setButtons(true);
      if (id) { loadHistory().catch(() => {}); refreshCount(); }
    },
  };
}
