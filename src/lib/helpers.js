'use strict';
const { TZ } = require('./tz');

const ACTIVITY_TYPES = ['Feeding', 'Walk', 'Medication', 'Grooming', 'Play / Enrichment', 'Cleaning', 'Training', 'Vet / Health Check', 'Other'];
const ANIMAL_TYPES = ['Dog', 'Cat', 'Rabbit', 'Bird', 'Reptile', 'Guinea Pig', 'Ferret', 'Other'];
const FREQUENCIES = {
  daily: 'Daily',
  twice_daily: 'Twice daily',
  weekly: 'Weekly',
  biweekly: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  as_needed: 'As needed',
};
// Hours between completions before a task is considered due.
const FREQUENCY_HOURS = { daily: 24, twice_daily: 12, weekly: 168, biweekly: 336, monthly: 720, quarterly: 2160, as_needed: null };

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  let months = now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years <= 0) return `${months} mo`;
  return months ? `${years} yr ${months} mo` : `${years} yr`;
}

function describeAge(animal) {
  if (animal.date_of_birth) return ageFromDob(animal.date_of_birth);
  if (animal.age_years_estimate != null) return `~${Number(animal.age_years_estimate)} yr`;
  return 'Unknown';
}

function fmtDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ });
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: TZ });
}

function fmtMinutes(min) {
  min = Number(min) || 0;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function taskStatus(task) {
  const hours = FREQUENCY_HOURS[task.frequency];
  if (!hours) return 'as_needed';
  if (!task.last_completed_at) return 'overdue';
  const elapsed = (Date.now() - new Date(task.last_completed_at).getTime()) / 36e5;
  if (elapsed >= hours) return 'overdue';
  if (elapsed >= hours * 0.75) return 'due_soon';
  return 'ok';
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

module.exports = { ACTIVITY_TYPES, ANIMAL_TYPES, FREQUENCIES, FREQUENCY_HOURS, describeAge, fmtDateTime, fmtDate, fmtMinutes, taskStatus, clean };
