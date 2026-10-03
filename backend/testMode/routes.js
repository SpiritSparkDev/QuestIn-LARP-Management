import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { getTestModeStatus, loadTestData, removeTestData } from './load.js';

router.get('/test-mode', requireAuth(requireAdminGroup(async () => {
  return { status: 200, body: await getTestModeStatus() };
})));

router.post('/test-mode', requireAuth(requireAdminGroup(async () => {
  try {
    return { status: 201, body: await loadTestData() };
  } catch (err) {
    if (err.code === 'ALREADY_LOADED') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 422, body: { error: `Die Testdaten passen nicht zum Charakterschema: ${err.details.join(', ')}` } };
    }
    throw err;
  }
})));

router.delete('/test-mode', requireAuth(requireAdminGroup(async () => {
  return { status: 200, body: await removeTestData() };
})));
