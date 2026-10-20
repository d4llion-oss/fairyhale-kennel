'use strict';
const express = require('express');
const db = require('../db');
const { requireLogin } = require('../lib/auth');
const { taskStatus } = require('../lib/helpers');

const router = express.Router();

router.get('/', requireLogin, async (req, res, next) => {
  try {
    const [animals, tasks, recent, today] = await Promise.all([
      db.query(`SELECT a.*, COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.performed_at >= now() - interval '24 hours'),0)::int AS minutes_today,
                       MAX(e.performed_at) AS last_activity_at
                FROM animals a LEFT JOIN activity_entries e ON e.animal_id = a.id
                WHERE a.is_active GROUP BY a.id ORDER BY a.name`),
      db.query(`SELECT t.*, (SELECT MAX(completed_at) FROM task_completions c WHERE c.task_id = t.id) AS last_completed_at
                FROM kennel_tasks t WHERE t.is_active ORDER BY t.title`),
      db.query(`SELECT e.*, a.name AS animal_name, u.display_name AS user_name
                FROM activity_entries e JOIN animals a ON a.id=e.animal_id JOIN users u ON u.id=e.user_id
                ORDER BY e.performed_at DESC LIMIT 8`),
      db.query(`SELECT COALESCE(SUM(duration_minutes),0)::int AS minutes, COUNT(*)::int AS entries
                FROM activity_entries WHERE performed_at >= date_trunc('day', now())`),
    ]);
    const tasksWithStatus = tasks.rows.map((t) => ({ ...t, status: taskStatus(t) }));
    const dueTasks = tasksWithStatus.filter((t) => t.status === 'overdue' || t.status === 'due_soon');
    res.render('dashboard', {
      title: 'Dashboard',
      animals: animals.rows,
      dueTasks,
      taskCount: tasks.rows.length,
      recent: recent.rows,
      today: today.rows[0],
    });
  } catch (e) { next(e); }
});

module.exports = router;
