// Turns a .create-card button into a small SC/NSC chooser menu.
// hasNsc() is checked on every click: without an NSC schema the click goes
// straight to onSc (no menu).
export function attachCreateMenu(trigger, { hasNsc, onSc, onNsc }) {
  const wrap = document.createElement("div");
  wrap.className = "create-menu-wrap";
  trigger.parentNode.insertBefore(wrap, trigger);
  wrap.appendChild(trigger);
  const menu = document.createElement("div");
  menu.className = "create-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" role="menuitem" class="create-menu-item" data-kind="sc">
      <strong>Spielercharakter (SC)</strong>
      <span>Erschaffe einen Spielercharakter für dein nächstes Abenteuer.</span>
    </button>
    <button type="button" role="menuitem" class="create-menu-item" data-kind="nsc">
      <strong>Nichtspielercharakter (NSC)</strong>
      <span>Lege eine Figur an, die du als Nichtspielercharakter darstellen kannst – auch ohne Anmeldung.</span>
    </button>`;
  wrap.appendChild(menu);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  const items = [...menu.querySelectorAll("[role=menuitem]")];
  function close(refocus) {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (refocus) trigger.focus();
  }
  function open() {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    items[0].focus();
  }
  trigger.addEventListener("click", () => {
    if (!hasNsc()) return onSc();
    menu.hidden ? open() : close(false);
  });
  items.forEach((item) =>
    item.addEventListener("click", () => {
      close(false);
      (item.dataset.kind === "nsc" ? onNsc : onSc)();
    }),
  );
  wrap.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(false); });
}
