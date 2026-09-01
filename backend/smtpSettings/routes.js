import nodemailer from 'nodemailer';
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getSmtpSettings, setSmtpSettings } from './repository.js';

router.get('/admin/settings/smtp', requireAuth(requireAdminGroup(async () => {
  const settings = await getSmtpSettings();
  return { status: 200, body: settings ?? { host: null, port: null, username: null, hasPassword: false, fromAddress: null } };
})));

router.put('/admin/settings/smtp', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { host, port, username, password, fromAddress } = body;
  const saved = await setSmtpSettings({ host, port: port ? Number(port) : null, username, password, fromAddress });
  return { status: 200, body: saved };
})));

router.post('/admin/settings/smtp/test', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { host, port, username, password, fromAddress, to } = body;
  if (!host || !to) return { status: 400, body: { error: 'host and to are required' } };
  try {
    const transporter = nodemailer.createTransport({
      host,
      port: Number(port) || 587,
      auth: username ? { user: username, pass: password } : undefined,
    });
    await transporter.sendMail({
      to,
      from: fromAddress || 'no-reply@pakyrion.local',
      subject: 'Pakyrion SMTP-Test',
      text: 'Diese Test-Mail bestätigt, dass deine SMTP-Einstellungen funktionieren.',
    });
    return { status: 200, body: { sent: true } };
  } catch (err) {
    return { status: 502, body: { error: `SMTP-Test fehlgeschlagen: ${err.message}` } };
  }
})));
