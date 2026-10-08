import { api } from '/js/api.js';
import { applyBranding } from '/js/branding.js';
import { hideLoading } from '/js/loading.js';
import { escapeHtml } from '/js/formFields.js';
import { renderNavLinks, renderSidebarUser, initSidebarToggle } from '/js/nav.js';
import { notify } from '/js/notifications.js';
applyBranding();
initSidebarToggle();

const SCOPE_LABELS = { participants: 'Teilnehmende', events: 'Events', all: 'Alles' };
const TARGET_LABELS = { download: 'Download', local: 'Server-Ordner', s3: 'S3', sftp: 'SFTP' };
const PART_LABELS = { participants: 'Teilnehmende', events: 'Events' };
const $ = (id) => document.getElementById(id);

let scope = 'participants';
const scopeButtons = [...document.querySelectorAll('#backup-scope .role-card')];
scopeButtons.forEach((button) => button.addEventListener('click', () => {
  scope = button.dataset.scope;
  scopeButtons.forEach((b) => b.classList.toggle('active', b === button));
}));

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const readBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(',')[1]);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

async function loadHistory() {
  const rows = await api.get('/backup/history');
  document.querySelector('#backup-history tbody').innerHTML = rows.length ? rows.map((r) => {
    const what = r.action === 'backup.restored'
      ? `Eingespielt (${(r.details?.parts ?? []).map((p) => PART_LABELS[p]).join(', ')})`
      : `Erstellt: ${SCOPE_LABELS[r.details?.scope] ?? '–'} → ${(r.details?.targets ?? ['download']).map((t) => TARGET_LABELS[t]).join(', ')}`;
    return `<tr>
      <td>${escapeHtml(new Date(r.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }))}</td>
      <td>${escapeHtml(r.actorName ?? '–')}</td>
      <td>${escapeHtml(what)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="3" class="sub">Noch keine Sicherung erstellt.</td></tr>';
}

// ---- Ziele einrichten ----
const FIELDS = {
  s3: ['bucket', 'prefix', 'endpoint', 'region', 'accessKeyId', 'secretAccessKey'],
  sftp: ['host', 'port', 'username', 'dir', 'password', 'privateKey'],
};
const SECRETS = { s3: ['secretAccessKey'], sftp: ['password', 'privateKey'] };

function fillSettings(settings) {
  $('local-dir').textContent = settings.local.dir;
  for (const target of ['s3', 'sftp']) {
    for (const field of FIELDS[target]) {
      $(`${target}-${field}`).value = SECRETS[target].includes(field) ? '' : (settings[target][field] ?? '');
    }
  }
  $('s3-secret-label').textContent = `Secret Access Key${settings.s3.hasSecretAccessKey ? ' (gespeichert)' : ''}`;
  $('sftp-password-label').textContent = `Passwort${settings.sftp.hasPassword ? ' (gespeichert)' : ''}`;
  $('sftp-key-label').textContent = `Privater Schlüssel (optional)${settings.sftp.hasPrivateKey ? ' (gespeichert)' : ''}`;
}

function collectSettings() {
  const result = {};
  for (const target of ['s3', 'sftp']) {
    result[target] = Object.fromEntries(FIELDS[target].map((field) => [field, $(`${target}-${field}`).value.trim()]));
  }
  return result;
}

$('backup-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    fillSettings(await api.put('/backup/settings', collectSettings()));
    notify('Einstellungen gespeichert.', 'success');
  } catch (err) { notify(err.message, 'error'); }
});

document.querySelectorAll('[data-test]').forEach((button) => button.addEventListener('click', async () => {
  try {
    fillSettings(await api.put('/backup/settings', collectSettings()));
    const result = await api.post('/backup/settings/test', { target: button.dataset.test });
    notify(result.ok ? 'Verbindung funktioniert.' : `Fehlgeschlagen: ${result.error}`, result.ok ? 'success' : 'error');
  } catch (err) { notify(err.message, 'error'); }
}));

// ---- Sicherung erstellen ----
$('backup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('backup-submit');
  const passphrase = $('backup-passphrase');
  const targets = [...document.querySelectorAll('#backup-targets input:checked')].map((i) => i.value);
  if (targets.length === 0) { notify('Bitte mindestens ein Ziel wählen.', 'error'); return; }
  button.disabled = true;
  try {
    const res = await fetch('/backup/export', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, passphrase: passphrase.value, targets }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Backup fehlgeschlagen (${res.status})`);
    let results;
    if (targets.includes('download')) {
      results = JSON.parse(decodeURIComponent(res.headers.get('X-Backup-Results') ?? '[]'));
      saveBlob(await res.blob(), /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'questin-backup.qbak');
      results.unshift({ target: 'download', ok: true, detail: 'Datei heruntergeladen' });
    } else {
      results = (await res.json()).results;
    }
    $('backup-results').innerHTML = results
      .map((r) => `<li class="${r.ok ? 'ok' : 'error'}"><strong>${escapeHtml(TARGET_LABELS[r.target])}</strong>: ${r.ok ? '✓' : '✗'} ${escapeHtml(r.detail)}</li>`)
      .join('');
    passphrase.value = '';
    const allOk = results.every((r) => r.ok);
    notify(allOk ? 'Sicherung erstellt.' : 'Sicherung erstellt, aber nicht überall zugestellt.', allOk ? 'success' : 'error');
    await loadHistory();
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

// ---- Backup einspielen ----
$('restore-inspect').addEventListener('click', async () => {
  const file = $('restore-file').files[0];
  if (!file || !$('restore-passphrase').value) { notify('Bitte Datei und Passwort angeben.', 'error'); return; }
  try {
    const info = await api.post('/backup/inspect', { fileBase64: await readBase64(file), passphrase: $('restore-passphrase').value });
    const m = info.manifest;
    const counts = Object.entries(m.counts).map(([table, n]) => `${n} ${table}`).join(', ');
    const warning = info.compatible ? '' : ` NICHT einspielbar: Der Datenbankstand passt nicht (Datei ${m.schemaVersion}, hier ${info.localSchemaVersion}).`;
    $('restore-summary').textContent = `Erstellt am ${new Date(m.createdAt).toLocaleString('de-DE')} (App ${m.appVersion}). Inhalt: ${counts}.${warning}`;
    $('restore-parts').innerHTML = info.parts.map((p) => `<label><input type="checkbox" value="${p}" checked> ${PART_LABELS[p]}</label>`).join('');
    $('restore-info').hidden = false;
    $('restore-info').dataset.compatible = info.compatible ? '1' : '';
    $('restore-confirm').checked = false;
    $('restore-submit').disabled = true;
  } catch (err) { notify(err.message, 'error'); }
});

$('restore-confirm').addEventListener('change', () => {
  $('restore-submit').disabled = !($('restore-confirm').checked && $('restore-info').dataset.compatible);
});

$('restore-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const parts = [...document.querySelectorAll('#restore-parts input:checked')].map((i) => i.value);
  if (parts.length === 0) { notify('Bitte mindestens einen Teil wählen.', 'error'); return; }
  $('restore-submit').disabled = true;
  try {
    const { restored } = await api.post('/backup/restore', {
      fileBase64: await readBase64($('restore-file').files[0]), passphrase: $('restore-passphrase').value, parts, confirm: true,
    });
    notify(`Eingespielt: ${Object.entries(restored).map(([table, n]) => `${n} ${table}`).join(', ')}.`, 'success');
    $('restore-info').hidden = true;
    $('restore-passphrase').value = '';
    await loadHistory();
  } catch (err) {
    notify(err.message, 'error');
    $('restore-submit').disabled = false;
  }
});

$('logout-link').addEventListener('click', async (evt) => {
  evt.preventDefault();
  if (!confirm('Wirklich abmelden?')) return;
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});

try {
  const account = await api.get('/account');
  $('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  $('sidebar-user-info').innerHTML = renderSidebarUser(account);
  fillSettings(await api.get('/backup/settings'));
  await loadHistory();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
  else notify(err.status === 403 ? 'Kein Zugriff – nur für Admins.' : err.message, 'error');
} finally {
  hideLoading();
}
