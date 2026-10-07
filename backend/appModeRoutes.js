import { router } from './routes.js';
import { isOffline } from './appMode.js';
import { getSummary } from './instanceAuthority/repository.js';

// Public: the frontend shows the offline banner on every page, login included.
router.get('/app-config', async () => {
  let snapshotTakenAt = null;
  if (isOffline()) {
    try {
      snapshotTakenAt = (await getSummary()).snapshotTakenAt;
    } catch {
      // Table missing -- banner just shows without a time.
    }
  }
  return { status: 200, body: { mode: isOffline() ? 'offline' : 'online', snapshotTakenAt } };
});
