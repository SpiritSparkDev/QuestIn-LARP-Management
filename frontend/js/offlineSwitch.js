import { api } from './api.js';
import { escapeHtml } from './formFields.js';

// Mode chip (Online / Offline / Rückgabe offen / Konflikte) plus the guided
// switch dialogs. Fed from /account.instance by nav.js; admins can click it,
// everybody else only reads it.

const fmt = (iso) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ONLINE_URL_KEY = 'offlineOnlineUrl';
let busy = false;
let lastAccount = null;
let snapshotId = null;

export function chipState(instance, mode) {
  const i = instance ?? { role: 'primary', openConflicts: 0 };
  if (i.openConflicts > 0) return { key: 'conflicts', icon: 'warning', text: `Konflikte (${i.openConflicts})`, title: 'Datenabgleich: offene Konflikte' };
  if (mode === 'offline' || i.role === 'offline_primary' || i.role === 'retired') {
    const retired = i.role === 'retired';
    return { key: 'offline', icon: 'cloud_off', text: `${retired ? 'Offline beendet' : 'Offline'} · Stand ${i.snapshotTakenAt ? fmt(i.snapshotTakenAt) : 'unbekannt'}`, title: 'Offline-Version' };
  }
  if (i.role === 'delegated') return { key: 'pending', icon: 'sync_problem', text: 'Offline-Rückgabe offen', title: i.delegatedSince ? `Delegiert seit ${fmt(i.delegatedSince)}` : 'Delegiert' };
  return { key: 'online', icon: 'cloud_done', text: 'Online · live', title: 'Normale Datenbank' };
}

let appMode = null;
async function loadMode() {
  if (appMode) return appMode;
  try {
    appMode = (await (await fetch('/app-config')).json()).mode;
  } catch {
    appMode = 'online';
  }
  return appMode;
}

export async function updateModeChip(account) {
  lastAccount = account;
  const mode = await loadMode();
  // Only roles the admin allowed to use the offline database see (and can click) the chip.
  if (account.canUseOffline !== true) {
    document.getElementById('mode-chip')?.remove();
    return;
  }
  const state = chipState(account.instance, mode);
  const isAdmin = true;
  if (isAdmin && !snapshotId && state.key !== 'online') {
    try {
      const events = (await api.get('/offline/status')).events;
      snapshotId = events[0]?.snapshotId ?? null;
    } catch {
      // Tooltip just stays without the id.
    }
  }
  const bar = document.querySelector('.standalone-bar');
  let chip = document.getElementById('mode-chip');
  if (!chip) {
    chip = document.createElement('a');
    chip.id = 'mode-chip';
    if (bar) bar.insertBefore(chip, bar.querySelector('.standalone-logout'));
    else (document.body ?? document.documentElement).append(chip);
  }
  chip.className = `mode-chip mode-chip-${state.key}${bar ? ' mode-chip-inline' : ''}`;
  chip.title = state.title + (snapshotId && state.key !== 'online' ? ` · Snapshot ${snapshotId.slice(0, 8)}` : '');
  chip.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${state.icon}</span><span>${escapeHtml(state.text)}</span>`;
  if (state.key === 'conflicts' && isAdmin) {
    chip.href = '/admin/sync.html';
    chip.removeAttribute('role');
  } else if (isAdmin) {
    chip.href = '#';
    chip.setAttribute('role', 'button');
  } else {
    chip.removeAttribute('href');
    chip.removeAttribute('role');
  }
  chip.onclick = isAdmin && state.key !== 'conflicts' ? (e) => { e.preventDefault(); openSwitchDialog(mode); } : null;
}

async function postRaw(path, data) {
  const res = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || `Fehler ${res.status}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return res;
}

async function download(res, fallbackName) {
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function mergeMessage(r) {
  const rep = r.report;
  const counts = rep ? ` (${rep.checkIns} Check-ins, ${rep.newTransactions} Buchungen, ${rep.conflicts} Konflikte)` : '';
  return ({
    released: 'Rückgabe abgeschlossen, Online ist wieder schreibberechtigt.',
    interim: 'Zwischenabgleich abgeschlossen, Online bleibt delegiert.',
    conflicts: 'Rückgabe eingespielt, es gibt offene Konflikte. Lösung online unter „Datenabgleich“.',
    forced_release: 'Die Delegation wurde online aufgehoben; das Paket liegt als Konflikt zur Einzelprüfung vor.',
    clock_skew: 'Uhrenabweichung festgestellt, siehe Konfliktliste online.',
    already_applied: 'Dieses Paket wurde bereits eingespielt.',
  }[r.status] ?? r.status) + counts;
}

function openSwitchDialog(mode) {
  if (busy || document.querySelector('dialog[open]:not(.mode-dialog):not(#toast-stack)')) {
    alert('Es läuft gerade ein Vorgang. Bitte zuerst abschließen.');
    return;
  }
  document.querySelector('dialog.mode-dialog')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'mode-dialog';
  dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  document.body.append(dlg);
  const role = lastAccount?.instance?.role ?? 'primary';
  if (mode === 'offline') renderToOnline(dlg);
  else if (role === 'delegated') renderPending(dlg);
  else renderToOffline(dlg);
  dlg.showModal();
}

const closeBtn = '<button type="button" class="btn-ghost" data-close>Schließen</button>';
function wireClose(dlg) {
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!busy) dlg.close(); }));
}

function runBusy(dlg, btn, msgEl, work) {
  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    dlg.querySelectorAll('button, input, select').forEach((el) => { el.disabled = true; });
    msgEl.className = 'sub';
    msgEl.textContent = 'Vorgang läuft …';
    let ok = false;
    try {
      msgEl.textContent = await work();
      ok = true;
    } catch (err) {
      msgEl.className = 'mode-error';
      msgEl.textContent = err.message;
    } finally {
      busy = false;
      // After success the page reloads; the buttons stay locked until then.
      if (!ok) dlg.querySelectorAll('button, input, select').forEach((el) => { el.disabled = false; });
      else dlg.querySelectorAll('[data-close]').forEach((el) => { el.disabled = false; });
    }
  });
}

function renderPending(dlg) {
  const since = lastAccount.instance.delegatedSince;
  dlg.innerHTML = `<h2>Offline-Rückgabe offen</h2>
    <p>Check-in und Taverne sind hier gesperrt${since ? ` (delegiert seit ${escapeHtml(fmt(since))})` : ''}, bis die Offline-Version zurückgegeben wurde.</p>
    <p>Rückgabe einspielen, Delegation aufheben oder Konflikte klären: Datenabgleich.</p>
    <div class="dialog-actions"><a class="btn" href="/admin/sync.html">Zum Datenabgleich</a>${closeBtn}</div>`;
  wireClose(dlg);
}

async function renderToOffline(dlg) {
  dlg.innerHTML = `<h2>Auf Offline-Version wechseln</h2>
    <p>Check-in und Taverne dieses Events werden hier <strong>gesperrt</strong>, bis die Offline-Version zurückgegeben wurde. Anmeldungen und Zahlungen laufen online weiter.</p>
    <p>Das Paket enthält personenbezogene Daten. Es wird mit der Passphrase verschlüsselt: sicher aufbewahren, Laptop-Festplatte verschlüsseln und das Paket nach der Rückgabe löschen.</p>
    <label>Event <select id="md-event"></select></label>
    <label>Passphrase (mind. 8 Zeichen) <input type="password" id="md-pass" autocomplete="new-password" minlength="8"></label>
    <label>Passphrase wiederholen <input type="password" id="md-pass2" autocomplete="new-password"></label>
    <p id="md-msg" class="sub" role="status"></p>
    <div class="dialog-actions"><button type="button" class="btn" id="md-go">Sperren und Paket herunterladen</button>${closeBtn}</div>`;
  wireClose(dlg);
  const select = dlg.querySelector('#md-event');
  try {
    const events = (await api.get('/events')).filter((e) => e.is_active);
    select.innerHTML = events.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join('');
  } catch (err) {
    dlg.querySelector('#md-msg').textContent = err.message;
  }
  runBusy(dlg, dlg.querySelector('#md-go'), dlg.querySelector('#md-msg'), async () => {
    const pass = dlg.querySelector('#md-pass').value;
    if (pass.length < 8) throw new Error('Die Passphrase braucht mindestens 8 Zeichen.');
    if (pass !== dlg.querySelector('#md-pass2').value) throw new Error('Die Passphrasen stimmen nicht überein.');
    if (!select.value) throw new Error('Bitte ein Event wählen.');
    await download(await postRaw('/offline/snapshot', { eventId: select.value, passphrase: pass }), 'questin-offline.qpkg');
    setTimeout(() => window.location.reload(), 2500);
    return 'Paket heruntergeladen. Dieses Event ist jetzt delegiert. Das Paket auf der Offline-Instanz importieren (npm run offline:import).';
  });
}

function renderToOnline(dlg) {
  let url = '';
  try { url = localStorage.getItem(ONLINE_URL_KEY) ?? ''; } catch { /* no storage */ }
  const retired = lastAccount?.instance?.role === 'retired';
  dlg.innerHTML = `<h2>Zurück zu Online</h2>
    <p>Die Rückgabe sendet die vor Ort erfassten Check-ins und Buchungen an den Online-Server. Ist er nicht erreichbar, erzeugt „Als Datei exportieren“ eine Datei, die online importiert wird.</p>
    <label>Adresse des Online-Servers <input type="url" id="md-url" placeholder="https://anmeldung.example.de" value="${escapeHtml(url)}"></label>
    <label>Passphrase (mind. 8 Zeichen) <input type="password" id="md-pass" autocomplete="new-password"></label>
    <label><input type="radio" name="md-kind" value="interim" ${retired ? 'disabled' : 'checked'}> Zwischenabgleich: Offline bleibt schreibberechtigt, Online bleibt delegiert</label>
    <label><input type="radio" name="md-kind" value="final" ${retired ? 'checked' : ''}> Endgültige Rückgabe: Diese Offline-Instanz wird danach nur noch lesend</label>
    <p id="md-msg" class="sub" role="status"></p>
    <div class="dialog-actions"><button type="button" class="btn" id="md-push">Online abgleichen</button><button type="button" class="btn-secondary" id="md-file">Als Datei exportieren</button>${closeBtn}</div>`;
  wireClose(dlg);
  const input = () => ({
    pass: dlg.querySelector('#md-pass').value,
    final: dlg.querySelector('input[name="md-kind"]:checked')?.value === 'final',
    onlineUrl: dlg.querySelector('#md-url').value.trim(),
  });
  const check = (i, needUrl) => {
    if (i.pass.length < 8) throw new Error('Die Passphrase braucht mindestens 8 Zeichen.');
    if (needUrl && !i.onlineUrl) throw new Error('Bitte die Adresse des Online-Servers angeben.');
    if (i.final && !confirm('Endgültige Rückgabe: Diese Instanz wird danach nur noch lesend. Fortfahren?')) throw new Error('Abgebrochen.');
  };
  runBusy(dlg, dlg.querySelector('#md-push'), dlg.querySelector('#md-msg'), async () => {
    const i = input();
    check(i, true);
    try { localStorage.setItem(ONLINE_URL_KEY, i.onlineUrl); } catch { /* no storage */ }
    try {
      const res = await (await postRaw('/offline/return-push', { onlineUrl: i.onlineUrl, passphrase: i.pass, final: i.final })).json();
      setTimeout(() => window.location.reload(), 4000);
      return mergeMessage(res.result);
    } catch (err) {
      if (err.status === 502) throw new Error('Online-Server nicht erreichbar. Bitte „Als Datei exportieren“ nutzen und die Datei online importieren.');
      throw err;
    }
  });
  runBusy(dlg, dlg.querySelector('#md-file'), dlg.querySelector('#md-msg'), async () => {
    const i = input();
    check(i, false);
    await download(await postRaw('/offline/return-package', { passphrase: i.pass, final: i.final }), 'questin-rueckgabe.qpkg');
    setTimeout(() => window.location.reload(), 2500);
    return 'Rückgabedatei heruntergeladen. Online unter „Datenabgleich“ importieren und sicher aufbewahren.';
  });
}
