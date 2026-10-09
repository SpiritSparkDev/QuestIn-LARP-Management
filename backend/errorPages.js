import { serveStaticFile } from './staticFiles.js';

const HOME = '<a class="btn" href="/">Zur Startseite</a>';
const LOGIN = '<a class="btn" href="/login.html">Zum Login</a>';
const RELOAD = '<button type="button" id="reload">Neu laden</button>';

// Browser-facing wording per status; everything else falls back to its class (4xx / 5xx).
const PAGES = {
  400: ['Ungültige Anfrage', 'Die Anfrage konnte nicht verarbeitet werden. Bitte prüfe den Link.', HOME],
  401: ['Bitte melde dich an', 'Für diese Seite musst du angemeldet sein.', LOGIN],
  403: ['Kein Zugriff', 'Dafür hast du keine Berechtigung. Wende dich an die Orga, falls das nicht stimmen kann.', HOME],
  405: ['Nicht erlaubt', 'Diese Aktion ist an dieser Stelle nicht möglich.', HOME],
  409: ['Das passt gerade nicht', 'Der Stand hat sich zwischenzeitlich geändert. Bitte lade die Seite neu.', RELOAD],
  429: ['Zu viele Anfragen', 'Bitte warte einen Moment und versuche es dann noch einmal.', RELOAD],
  500: ['Da ist etwas schiefgegangen', 'Das tut uns leid. Bitte versuche es gleich noch einmal. Besteht das Problem weiter, gib der Orga Bescheid.', RELOAD],
  502: ['Server nicht erreichbar', 'Der Server antwortet gerade nicht. Bitte versuche es in ein paar Minuten noch einmal.', RELOAD],
  504: ['Server antwortet nicht', 'Der Server braucht zu lange. Bitte versuche es in ein paar Minuten noch einmal.', RELOAD],
};

function textsFor(status) {
  if (PAGES[status]) return PAGES[status];
  if (status >= 500) return ['Serverfehler', 'Auf unserer Seite ist ein Fehler aufgetreten. Bitte versuche es später noch einmal.', RELOAD];
  return ['Anfrage nicht möglich', 'Diese Anfrage kann nicht ausgeführt werden.', HOME];
}

// The generic error page for `status` as { data, contentType }, or null if the template is missing.
export async function renderErrorPage(status) {
  const template = await serveStaticFile('/error.html');
  if (!template) return null;
  const [heading, text, actions] = textsFor(status);
  const html = template.data.toString('utf8')
    .replaceAll('{{code}}', String(status))
    .replaceAll('{{heading}}', heading)
    .replaceAll('{{text}}', text)
    .replaceAll('{{actions}}', actions);
  return { data: Buffer.from(html, 'utf8'), contentType: template.contentType };
}
