// Konto-Bereich: Karte „QuestIn-Konto aktivieren“ (Opt-in-Umzug in den Hub).
// Erscheint nur, wenn die Instanz an den Hub gekoppelt ist und das Konto noch nicht verbunden ist.
import { api } from '/js/api.js';
import { notify } from '/js/notifications.js';

const card = document.getElementById('hub-optin-card');
const form = document.getElementById('hub-optin-form');

try {
  const { available, linked } = await api.get('/auth/hub/status');
  card.hidden = !available || linked;
} catch {
  // Nicht angemeldet oder Netzfehler: Karte bleibt versteckt.
}

// Anmelden-Tab: Abweichungen zwischen QuestIn-Profil und Konto anbieten, nie automatisch übernehmen.
const profileCard = document.getElementById('hub-profile-card');
const profileForm = document.getElementById('hub-profile-form');

async function renderProfileOffer() {
  const offer = await api.get('/hub/profile');
  if (!offer.available || !offer.mapped) return;
  const differing = offer.items.filter((i) => !i.same);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  document.getElementById('hub-profile-intro').textContent = !offer.fetchedAt
    ? 'Du kannst Angaben wie Adresse oder Notfallkontakt aus deinem QuestIn-Profil übernehmen. QuestIn fragt dich, welche Bereiche du teilen möchtest.'
    : differing.length === 0
      ? `Dein Konto stimmt mit deinem QuestIn-Profil überein (Stand ${new Date(offer.fetchedAt).toLocaleDateString('de-DE')}).`
      : 'Diese Angaben weichen von deinem QuestIn-Profil ab. Wähle aus, was du übernehmen möchtest:';
  document.getElementById('hub-profile-items').innerHTML = differing.map((i) => `<label class="checkbox-row">
    <input type="checkbox" name="${esc(i.hubKey)}" checked>
    <span><strong>${esc(i.label)}</strong>: ${esc(i.hub)}${i.local ? ` <span class="sub">(bisher: ${esc(i.local)})</span>` : ''}</span></label>`).join('');
  document.getElementById('hub-profile-apply').hidden = differing.length === 0;
  profileCard.hidden = false;
}

try { await renderProfileOffer(); } catch { /* nicht angemeldet oder nicht gekoppelt */ }

profileForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { applied } = await api.post('/hub/profile/apply', { keys: [...new FormData(profileForm).keys()] });
    notify(`${applied.length} Angabe(n) übernommen.`, 'success');
    await renderProfileOffer();
  } catch (err) {
    notify(err.message, 'error');
  }
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api.post('/auth/hub/optin', { consent: document.getElementById('hub-optin-consent').checked });
    card.hidden = true;
    notify('Dein QuestIn-Konto ist aktiv. Du kannst dich ab jetzt auch mit „Mit QuestIn anmelden“ einloggen.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
});
