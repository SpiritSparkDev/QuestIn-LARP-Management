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
