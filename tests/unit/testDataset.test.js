import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildTestDataset, GROUPS, TEST_EMAIL_DOMAIN } = await import('../../backend/testMode/dataset.js');

test('the test data set has 75 unique people on the reserved test domain', () => {
  const { persons } = buildTestDataset();
  assert.equal(persons.length, 75);
  assert.equal(new Set(persons.map((p) => p.email)).size, 75);
  assert.equal(new Set(persons.map((p) => `${p.firstName} ${p.lastName}`)).size, 75);
  assert.ok(persons.every((p) => p.email.endsWith(`@${TEST_EMAIL_DOMAIN}`)));
});

test('some people form groups with one owner each, the rest are individuals', () => {
  const { persons } = buildTestDataset();
  const grouped = persons.filter((p) => p.groupIndex !== null);
  assert.equal(grouped.length, GROUPS.reduce((sum, g) => sum + g.size, 0));
  GROUPS.forEach((group, index) => {
    const members = grouped.filter((p) => p.groupIndex === index);
    assert.equal(members.length, group.size);
    assert.equal(members.filter((p) => p.isGroupOwner).length, 1);
    assert.ok(members.filter((p) => !p.isGroupOwner).every((p) => p.isManaged));
  });
  assert.equal(persons.filter((p) => p.groupIndex === null).length, 75 - grouped.length);
});

test('the data set is deterministic and mixes roles and statuses', () => {
  assert.deepEqual(buildTestDataset(), buildTestDataset());
  const { persons } = buildTestDataset();
  const roles = new Set(persons.map((p) => p.role));
  for (const role of ['sc', 'nsc', 'helfer', 'orga', 'hilfs_orga', 'ticket']) assert.ok(roles.has(role), role);
  const statuses = new Set(persons.map((p) => p.status));
  for (const status of ['confirmed', 'pending', 'checked_in', 'waitlisted', 'cancelled']) assert.ok(statuses.has(status), status);
});
