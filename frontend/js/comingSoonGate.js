// Shared by the public entry pages (index.html, register.html): sends a
// visitor to the "Anmeldung startet bald" screen instead of the real page
// while an admin has it enabled. login.html is deliberately NOT gated by
// this -- existing members/staff must always be able to log in, even while
// public registration is paused.
export async function redirectIfComingSoonEnabled() {
  try {
    const res = await fetch('/app-settings');
    if (!res.ok) return false;
    const settings = await res.json();
    if (settings.comingSoonEnabled) {
      window.location.replace('/coming-soon.html');
      return true;
    }
  } catch {
    // Network hiccup -- fail open and show the real page.
  }
  return false;
}
