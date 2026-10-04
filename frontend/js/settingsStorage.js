// "Speicher" tab of the admin settings page (admin/settings.html): where
// uploaded character files are stored (local/FTP/S3), usage and migration.
import { api } from '/js/api.js';

export function initStorage({ notify }) {
  const form = document.getElementById('storage-form');
  const backendSelect = document.getElementById('backend-select');
  const ftpFields = document.getElementById('ftp-fields');
  const s3Fields = document.getElementById('s3-fields');

  function updateVisibleFields() {
    ftpFields.hidden = backendSelect.value !== 'ftp';
    s3Fields.hidden = backendSelect.value !== 's3';
  }
  backendSelect.addEventListener('change', updateVisibleFields);

  function formToPayload(data) {
    return {
      backend: data.backend,
      ftp: {
        host: data.ftpHost || null,
        port: data.ftpPort ? Number(data.ftpPort) : null,
        username: data.ftpUsername || null,
        password: data.ftpPassword || undefined,
        secure: data.ftpSecure === 'on',
        baseDir: data.ftpBaseDir || null,
      },
      s3: {
        bucket: data.s3Bucket || null,
        region: data.s3Region || null,
        endpoint: data.s3Endpoint || null,
        accessKeyId: data.s3AccessKeyId || null,
        secretAccessKey: data.s3SecretAccessKey || undefined,
      },
    };
  }

  async function loadSettings() {
    const settings = await api.get('/admin/settings/storage');
    backendSelect.value = settings.backend;
    form.elements.ftpHost.value = settings.ftp.host ?? '';
    form.elements.ftpPort.value = settings.ftp.port ?? '';
    form.elements.ftpUsername.value = settings.ftp.username ?? '';
    form.elements.ftpPassword.placeholder = settings.ftp.hasPassword
      ? 'Gesetzt — leer lassen, um es zu behalten'
      : 'Leer lassen, um das bestehende Passwort zu behalten';
    form.elements.ftpSecure.checked = settings.ftp.secure;
    form.elements.ftpBaseDir.value = settings.ftp.baseDir ?? '';
    form.elements.s3Bucket.value = settings.s3.bucket ?? '';
    form.elements.s3Region.value = settings.s3.region ?? '';
    form.elements.s3Endpoint.value = settings.s3.endpoint ?? '';
    form.elements.s3AccessKeyId.value = settings.s3.accessKeyId ?? '';
    form.elements.s3SecretAccessKey.placeholder = settings.s3.hasSecretKey
      ? 'Gesetzt — leer lassen, um ihn zu behalten'
      : 'Leer lassen, um den bestehenden Schlüssel zu behalten';
    updateVisibleFields();
  }

  function renderUsageChart(usage) {
    const entries = [['Lokal', usage.local], ['FTP', usage.ftp], ['S3', usage.s3]];
    const max = Math.max(1, ...entries.map(([, bytes]) => bytes));
    const svg = document.getElementById('usage-chart');
    const barHeight = 20;
    const gap = 10;
    const chartWidth = 260;
    svg.innerHTML = entries.map(([label, bytes], i) => {
      const y = i * (barHeight + gap);
      const width = Math.max(2, (bytes / max) * chartWidth);
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      return `
        <text x="0" y="${y + barHeight - 5}" font-size="12">${label}</text>
        <rect x="60" y="${y}" width="${width}" height="${barHeight}" fill="currentColor"></rect>
        <text x="${60 + chartWidth + 10}" y="${y + barHeight - 5}" font-size="12">${mb} MB</text>
      `;
    }).join('');
  }

  async function loadUsage() {
    const usage = await api.get('/admin/settings/storage/usage');
    renderUsageChart(usage);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await api.put('/admin/settings/storage', formToPayload(data));
      notify('Gespeichert.', 'success');
      form.elements.ftpPassword.value = '';
      form.elements.s3SecretAccessKey.value = '';
      await loadSettings();
    } catch (err) {
      notify(err.message, 'error');
    }
  });

  document.getElementById('test-connection').addEventListener('click', async () => {
    const data = Object.fromEntries(new FormData(form));
    try {
      await api.post('/admin/settings/storage/test', formToPayload(data));
      notify('Verbindung erfolgreich.', 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  });

  document.getElementById('migrate-button').addEventListener('click', async (evt) => {
    if (!confirm('Alle Dateien wirklich zum konfigurierten Backend migrieren?')) return;
    const button = evt.currentTarget;
    const spinner = document.getElementById('migrate-spinner');
    const result = document.getElementById('migrate-result');
    result.textContent = '';
    spinner.hidden = false;
    button.disabled = true;
    try {
      const { migrated, failed } = await api.post('/admin/settings/storage/migrate', {});
      result.textContent = failed.length === 0
        ? `${migrated} Datei(en) migriert.`
        : `${migrated} Datei(en) migriert, ${failed.length} fehlgeschlagen: ${failed.map((f) => f.error).join('; ')}`;
      await loadUsage();
    } catch (err) {
      result.textContent = err.message;
    } finally {
      spinner.hidden = true;
      button.disabled = false;
    }
  });

  return {
    async load() {
      await loadSettings();
      await loadUsage();
    },
  };
}
