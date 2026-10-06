// "Branding" tab of the admin settings page (admin/settings.html): logo,
// title, color scheme and image uploads. Call initBranding() once after the
// page's DOM exists, then load() once the admin session is confirmed.
import { api } from '/js/api.js';
import { applyBranding, applyColorScheme, applyBackground, BACKGROUND_PRESETS, CUSTOM_COLOR_KEYS } from '/js/branding.js';

export function initBranding({ notify }) {
  const form = document.getElementById('branding-form');

  const CUSTOM_COLOR_LABELS = {
    'surface': 'Oberfläche',
    'surface-container-lowest': 'Oberfläche – unterste Ebene',
    'surface-container-low': 'Oberfläche – niedrige Ebene',
    'surface-container': 'Oberfläche – Container',
    'surface-container-high': 'Oberfläche – hohe Ebene',
    'surface-container-highest': 'Oberfläche – höchste Ebene',
    'on-surface': 'Text auf Oberfläche',
    'on-surface-variant': 'Text auf Oberfläche (Variante)',
    'outline': 'Rahmen',
    'outline-variant': 'Rahmen (Variante)',
    'primary': 'Primärfarbe',
    'primary-deep': 'Primärfarbe (dunkel)',
    'primary-container': 'Primärfarbe – Container',
    'on-primary': 'Text auf Primärfarbe',
    'on-primary-container': 'Text auf Primärfarbe-Container',
    'gold': 'Akzentfarbe',
    'gold-container': 'Akzentfarbe – Container',
    'on-gold-container': 'Text auf Akzentfarbe-Container',
    'secondary': 'Sekundärfarbe',
    'secondary-container': 'Sekundärfarbe – Container',
    'error': 'Fehlerfarbe',
    'success': 'Erfolgsfarbe',
  };

  function currentComputedColors() {
    const computed = getComputedStyle(document.documentElement);
    const colors = {};
    for (const key of CUSTOM_COLOR_KEYS) colors[key] = computed.getPropertyValue(`--${key}`).trim();
    return colors;
  }

  function readCustomColors() {
    const colors = {};
    document.querySelectorAll('#custom-color-grid input[type="color"]').forEach((input) => {
      colors[input.dataset.key] = input.value;
    });
    return colors;
  }

  function buildCustomColorGrid(initialColors) {
    const grid = document.getElementById('custom-color-grid');
    grid.innerHTML = '';
    for (const key of CUSTOM_COLOR_KEYS) {
      const value = initialColors[key] || '#000000';
      const field = document.createElement('div');
      field.className = 'color-field';

      const label = document.createElement('label');
      label.textContent = CUSTOM_COLOR_LABELS[key] || key;
      label.setAttribute('for', `custom-color-${key}`);

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.id = `custom-color-${key}`;
      colorInput.dataset.key = key;
      colorInput.value = value;

      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.value = value;

      colorInput.addEventListener('input', () => {
        textInput.value = colorInput.value;
        previewCustomColors();
      });
      textInput.addEventListener('input', () => {
        if (/^#[0-9a-fA-F]{6}$/.test(textInput.value)) {
          colorInput.value = textInput.value;
          previewCustomColors();
        }
      });

      field.append(label, colorInput, textInput);
      grid.appendChild(field);
    }
  }

  function previewCustomColors() {
    applyColorScheme({ themeMode: form.elements.themeMode.value, colorScheme: 'custom', customColors: readCustomColors() });
  }

  function previewScheme() {
    const colorScheme = form.elements.colorScheme.value;
    const themeMode = form.elements.themeMode.value;
    applyColorScheme({ themeMode, colorScheme, customColors: colorScheme === 'custom' ? readCustomColors() : null });
  }

  form.elements.colorScheme.addEventListener('change', () => {
    const isCustom = form.elements.colorScheme.value === 'custom';
    document.getElementById('custom-colors-section').style.display = isCustom ? '' : 'none';
    form.elements.themeMode.disabled = isCustom;
    if (isCustom) buildCustomColorGrid(currentComputedColors());
    previewScheme();
  });

  form.elements.themeMode.addEventListener('change', previewScheme);

  // Background picker: "no graphic", the built-in presets (tinted with the
  // scheme colour) and -- once uploaded -- the own picture. Choosing one
  // previews it right away; "Speichern" stores it.
  function buildBackgroundPicker({ backgroundPreset, hasUploadedBackgroundImage }) {
    const picker = document.getElementById('bg-picker');
    const options = [
      ['none', 'Kein Hintergrund', ''],
      ...BACKGROUND_PRESETS.map(([key, label]) => [key, label, `--tile-mask:url(/img/bg/${key}.webp);--tile-opacity:0.55`]),
      ['custom', 'Eigenes Bild', ''],
    ];
    picker.innerHTML = options.map(([key, label, style]) => {
      const disabled = key === 'custom' && !hasUploadedBackgroundImage;
      const preview = key === 'custom' && hasUploadedBackgroundImage ? 'background-image:url(/app-settings/background-image)' : style;
      return `<label class="bg-tile${backgroundPreset === key ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}">
        <input type="radio" name="backgroundPreset" value="${key}" ${backgroundPreset === key ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span class="bg-tile-preview" style="${preview}"></span>
        <span>${label}${disabled ? ' (erst hochladen)' : ''}</span>
      </label>`;
    }).join('');
    picker.querySelectorAll('input[name="backgroundPreset"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        picker.querySelectorAll('.bg-tile').forEach((tile) => tile.classList.toggle('is-selected', tile.querySelector('input').checked));
        applyBackground({ backgroundPreset: radio.value, hasUploadedBackgroundImage });
      });
    });
  }

  function refreshBgImagePreview(hasUploadedBackgroundImage) {
    api.get('/app-settings').then(buildBackgroundPicker).catch(() => {});
    const preview = document.getElementById('bg-image-preview');
    const empty = document.getElementById('bg-image-preview-empty');
    const removeBtn = document.getElementById('bg-image-remove-btn');
    if (hasUploadedBackgroundImage) {
      preview.src = `/app-settings/background-image?t=${Date.now()}`;
      preview.style.display = '';
      empty.style.display = 'none';
      removeBtn.style.display = '';
    } else {
      preview.style.display = 'none';
      empty.style.display = '';
      removeBtn.style.display = 'none';
    }
  }

  async function loadSettings() {
    const settings = await api.get('/app-settings');
    buildBackgroundPicker(settings);
    form.elements.appTitle.value = settings.appTitle ?? '';
    form.elements.eventName.value = settings.eventName ?? '';
    form.elements.logoUrl.value = settings.logoUrl ?? '';
    form.elements.quotaMbPerCharacter.value = settings.quotaMbPerCharacter ?? '';
    form.elements.themeMode.value = settings.themeMode ?? 'light';
    form.elements.colorScheme.value = settings.colorScheme ?? 'sahara';
    form.elements.themeMode.disabled = settings.colorScheme === 'custom';
    applyColorScheme(settings);
    document.getElementById('custom-colors-section').style.display = settings.colorScheme === 'custom' ? '' : 'none';
    buildCustomColorGrid(currentComputedColors());
    refreshLogoPreview(settings.hasUploadedLogo);
    refreshTicketBgPreview(settings.hasUploadedTicketBackground);
    refreshBgImagePreview(settings.hasUploadedBackgroundImage);
  }

  const IMAGE_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp'];

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function refreshLogoPreview(hasUploadedLogo) {
    const preview = document.getElementById('logo-preview');
    const empty = document.getElementById('logo-preview-empty');
    const removeBtn = document.getElementById('logo-remove-btn');
    const urlNote = document.getElementById('logo-url-note');
    if (hasUploadedLogo) {
      preview.src = `/app-settings/logo?t=${Date.now()}`;
      preview.style.display = '';
      empty.style.display = 'none';
      removeBtn.style.display = '';
      urlNote.style.display = '';
    } else {
      preview.style.display = 'none';
      empty.style.display = '';
      removeBtn.style.display = 'none';
      urlNote.style.display = 'none';
    }
  }

  function refreshTicketBgPreview(hasUploadedTicketBackground) {
    const preview = document.getElementById('ticket-bg-preview');
    const empty = document.getElementById('ticket-bg-preview-empty');
    const removeBtn = document.getElementById('ticket-bg-remove-btn');
    if (hasUploadedTicketBackground) {
      preview.src = `/app-settings/ticket-background?t=${Date.now()}`;
      preview.style.display = '';
      empty.style.display = 'none';
      removeBtn.style.display = '';
    } else {
      preview.style.display = 'none';
      empty.style.display = '';
      removeBtn.style.display = 'none';
    }
  }

  // Shared by the logo and ticket-background upload/remove buttons, whose
  // behavior (validate, base64-encode, PUT/DELETE, refresh preview) is
  // identical -- only the endpoint and preview refresh differ.
  function wireImageUpload({ fileInputId, uploadBtnId, removeBtnId, endpoint, refreshPreview, removeConfirmMessage, uploadedMessage, removedMessage }) {
    document.getElementById(uploadBtnId).addEventListener('click', async () => {
      const file = document.getElementById(fileInputId).files[0];
      if (!file) return;
      if (!IMAGE_MIME_ALLOWLIST.includes(file.type)) {
        notify('Nicht unterstützter Dateityp.', 'error');
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        notify('Datei ist größer als 2 MB.', 'error');
        return;
      }
      try {
        const dataBase64 = await readFileAsBase64(file);
        await api.put(endpoint, { dataBase64, mimeType: file.type });
        refreshPreview(true);
        await applyBranding();
        notify(uploadedMessage, 'success');
      } catch (err) {
        notify(err.message, 'error');
      }
    });

    document.getElementById(removeBtnId).addEventListener('click', async () => {
      if (!confirm(removeConfirmMessage)) return;
      try {
        await api.delete(endpoint);
        refreshPreview(false);
        await applyBranding();
        notify(removedMessage, 'success');
      } catch (err) {
        notify(err.message, 'error');
      }
    });
  }

  wireImageUpload({
    fileInputId: 'logo-file', uploadBtnId: 'logo-upload-btn', removeBtnId: 'logo-remove-btn',
    endpoint: '/app-settings/logo', refreshPreview: refreshLogoPreview,
    removeConfirmMessage: 'Logo wirklich entfernen?', uploadedMessage: 'Logo hochgeladen.', removedMessage: 'Logo entfernt.',
  });

  wireImageUpload({
    fileInputId: 'ticket-bg-file', uploadBtnId: 'ticket-bg-upload-btn', removeBtnId: 'ticket-bg-remove-btn',
    endpoint: '/app-settings/ticket-background', refreshPreview: refreshTicketBgPreview,
    removeConfirmMessage: 'Ticket-Hintergrund wirklich entfernen?', uploadedMessage: 'Ticket-Hintergrund hochgeladen.', removedMessage: 'Ticket-Hintergrund entfernt.',
  });

  wireImageUpload({
    fileInputId: 'bg-image-file', uploadBtnId: 'bg-image-upload-btn', removeBtnId: 'bg-image-remove-btn',
    endpoint: '/app-settings/background-image', refreshPreview: refreshBgImagePreview,
    removeConfirmMessage: 'Hintergrundbild wirklich entfernen?', uploadedMessage: 'Hintergrundbild hochgeladen.', removedMessage: 'Hintergrundbild entfernt.',
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.quotaMbPerCharacter = data.quotaMbPerCharacter ? Number(data.quotaMbPerCharacter) : undefined;
    if (form.elements.colorScheme.value === 'custom') data.customColors = readCustomColors();
    try {
      await api.put('/app-settings', data);
      notify('Gespeichert.', 'success');
      await loadSettings();
      await applyBranding();
    } catch (err) {
      notify(err.message, 'error');
    }
  });

  return { load: loadSettings };
}
