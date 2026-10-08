// Plain-language reason why the camera could not be started (getUserMedia).
export function cameraErrorMessage(err, { secureContext = true, hasMediaDevices = true } = {}) {
  if (!secureContext) return 'Kamerazugriff funktioniert nur über eine HTTPS-Verbindung (oder localhost).';
  if (!hasMediaDevices) return 'Dieser Browser unterstützt keinen Kamerazugriff.';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Kamerazugriff verweigert. Bitte in den Browser-Einstellungen für diese Seite erlauben und den Scan neu starten.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Keine Kamera gefunden.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'Die Kamera wird gerade von einer anderen App benutzt. Andere App schließen und erneut versuchen.';
    default:
      return 'Die Kamera konnte nicht gestartet werden.';
  }
}
