// Admin-Einstellungen: Zuordnung QuestIn-Stammprofil -> Kontofeld.
// Die Karte erscheint nur, wenn die Instanz an den Hub gekoppelt ist.
import { api } from '/js/api.js';
import { notify } from '/js/notifications.js';
import { escapeHtml } from '/js/formFields.js';

const card = document.getElementById('hub-mapping-card');
const rows = document.getElementById('hub-mapping-rows');

try {
  const providers = await (await fetch('/auth/oauth/providers')).json();
  if (providers.hub) {
    const [{ hubFields, mapping }, schema] = await Promise.all([api.get('/admin/hub-profile-mapping'), api.get('/account-schema')]);
    const options = (selected) => ['<option value="">– nicht übernehmen –</option>',
      ...schema.map((f) => `<option value="${escapeHtml(f.key)}"${f.key === selected ? ' selected' : ''}>${escapeHtml(f.label ?? f.key)}</option>`)].join('');
    rows.innerHTML = Object.entries(hubFields).map(([key, field]) => `<div>
      <select id="hub-map-${key}" name="${key}">${options(mapping[key])}</select>
      <label for="hub-map-${key}">${escapeHtml(field.label)}</label></div>`).join('');
    card.hidden = false;
  }
} catch {
  // Kein Admin oder Hub nicht gekoppelt: Karte bleibt versteckt.
}

document.getElementById('hub-mapping-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api.put('/admin/hub-profile-mapping', { mapping: Object.fromEntries(new FormData(event.target)) });
    notify('Zuordnung gespeichert.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
});
