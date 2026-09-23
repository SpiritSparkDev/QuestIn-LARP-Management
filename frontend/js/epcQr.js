// EPC069-12 ("Girocode"): 12 newline-getrennte Felder, die jede SEPA-fähige
// Banking-App als vorausgefüllte Überweisung liest. BIC darf laut Spec seit
// 2020 leer sein (dann übernimmt die App-IBAN-Validierung), leere Felder
// bleiben trotzdem als eigene Zeile stehen.
export function buildEpcQrPayload({ iban, bic, name, amountCents, reference }) {
  const amount = (amountCents / 100).toFixed(2);
  return [
    'BCD',
    '002',
    '1',
    'SCT',
    bic || '',
    name,
    iban,
    `EUR${amount}`,
    '',
    '',
    reference,
    '',
  ].join('\n');
}
