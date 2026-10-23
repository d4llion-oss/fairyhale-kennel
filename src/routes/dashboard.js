'use strict';
const express = require('express');
const db = require('../db');
const { requireLogin } = require('../lib/auth');
const { taskStatus } = require('../lib/helpers');

const router = express.Router();

router.get('/', requireLogin, async (req, res, next) => {
  try {
    // Optional animal-type filter: ?type=Dog&type=Cat (multi-select checkboxes on the page)
    let selectedTypes = [].concat(req.query.type || []).map((t) => String(t).trim()).filter(Boolean);
    const [animals, tasks, recent, today, typeRows] = await Promise.all([
      db.query(`SELECT a.*, COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.performed_at >= now() - interval '24 hours'),0)::int AS minutes_today,
                       MAX(e.performed_at) AS last_activity_at,
                       (SELECT p.id FROM animal_photos p WHERE p.animal_id=a.id ORDER BY p.position LIMIT 1) AS photo_id,
                       COALESCE((SELECT json_agg(json_build_object('name', g.name, 'color', g.color) ORDER BY g.name) FROM potty_group_members m JOIN potty_groups g ON g.id=m.group_id WHERE m.animal_id=a.id), '[]'::json) AS groups
                FROM animals a LEFT JOIN activity_entries e ON e.animal_id = a.id
                WHERE a.is_active ${selectedTypes.length ? 'AND a.animal_type = ANY($1)' : ''}
                GROUP BY a.id ORDER BY a.name`, selectedTypes.length ? [selectedTypes] : []),
      db.query(`SELECT t.*, (SELECT MAX(completed_at) FROM task_completions c WHERE c.task_id = t.id) AS last_completed_at
                FROM kennel_tasks t WHERE t.is_active ORDER BY t.title`),
      db.query(`SELECT e.*, a.name AS animal_name, u.display_name AS user_name
                FROM activity_entries e JOIN animals a ON a.id=e.animal_id JOIN users u ON u.id=e.user_id
                ORDER BY e.performed_at DESC LIMIT 8`),
      db.query(`SELECT COALESCE(SUM(duration_minutes),0)::int AS minutes, COUNT(*)::int AS entries
                FROM activity_entries WHERE performed_at >= date_trunc('day', now())`),
      db.query(`SELECT animal_type, COUNT(*)::int AS n FROM animals WHERE is_active GROUP BY animal_type ORDER BY animal_type`),
    ]);
    const availableTypes = typeRows.rows;
    selectedTypes = selectedTypes.filter((t) => availableTypes.some((r) => r.animal_type === t));
    const tasksWithStatus = tasks.rows.map((t) => ({ ...t, status: taskStatus(t) }));
    const dueTasks = tasksWithStatus.filter((t) => t.status === 'overdue' || t.status === 'due_soon');
    res.render('dashboard', {
      title: 'Dashboard',
      animals: animals.rows,
      availableTypes,
      selectedTypes,
      dueTasks,
      taskCount: tasks.rows.length,
      recent: recent.rows,
      today: today.rows[0],
    });
  } catch (e) { next(e); }
});

module.exports = router;
