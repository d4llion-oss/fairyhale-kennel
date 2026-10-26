'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TZ, toLocalInput } = require('../src/lib/tz');

test('kennel timezone is applied to the process', () => {
  assert.equal(process.env.TZ, TZ);
  // 2026-10-26T14:44Z is 09:44 CDT
  const d = new Date('2026-10-26T14:44:00Z');
  assert.equal(d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }), '9:44 AM');
  assert.equal(toLocalInput(d), '2026-10-26T09:44');
});

test('datetime-local input parses as kennel time', () => {
  const d = new Date('2026-10-26T09:44'); // what the form submits, no zone
  assert.equal(d.toISOString(), '2026-10-26T14:44:00.000Z');
});
