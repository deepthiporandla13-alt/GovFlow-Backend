const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken, checkRole } = require('./auth');

// Dashboard Overview / Analytics Summary
router.get('/summary', verifyToken, async (req, res) => {
  const { role, department_id: deptId } = req.user;

  try {
    let statsQuery = `
      SELECT 
        COUNT(*) as total_requests,
        COUNT(CASE WHEN status = 'Submitted' THEN 1 END) as pending_clerk,
        COUNT(CASE WHEN status LIKE 'In_Review%' THEN 1 END) as active_review,
        COUNT(CASE WHEN status = 'Approved' THEN 1 END) as approved_count,
        COUNT(CASE WHEN status = 'Rejected' THEN 1 END) as rejected_count,
        COUNT(CASE WHEN status = 'Returned_For_Correction' THEN 1 END) as returned_count,
        COUNT(CASE WHEN is_escalated = TRUE THEN 1 END) as escalated_count,
        COUNT(CASE WHEN sla_deadline < CURRENT_TIMESTAMP AND status NOT IN ('Approved', 'Rejected') THEN 1 END) as sla_breached_count
      FROM requests
    `;
    const params = [];

    // Filter by department if clerk, officer, or manager
    if (role === 'Clerk' || role === 'Officer' || role === 'Manager') {
      params.push(deptId);
      statsQuery += ` WHERE current_assignee_id IN (SELECT id FROM users WHERE department_id = $1) OR current_assignee_id IS NULL`;
    }

    const statsRes = await db.query(statsQuery, params);
    
    // Submissions Over Time (last 7 days/weeks)
    const trendsQuery = `
      SELECT DATE_TRUNC('day', created_at) as date, COUNT(*) as count 
      FROM requests 
      GROUP BY DATE_TRUNC('day', created_at) 
      ORDER BY date ASC 
      LIMIT 15
    `;
    const trendsRes = await db.query(trendsQuery);

    // Resolution rates by department
    const deptPerformanceQuery = `
      SELECT 
        d.name as department_name,
        COUNT(r.id) as total,
        COUNT(CASE WHEN r.status = 'Approved' THEN 1 END) as approved,
        COUNT(CASE WHEN r.status = 'Rejected' THEN 1 END) as rejected,
        ROUND(AVG(EXTRACT(EPOCH FROM (r.updated_at - r.created_at))/86400)::numeric, 1) as avg_resolution_days
      FROM requests r
      JOIN users u ON r.citizen_id = u.id -- Citizen who created
      -- But we want to group by department of the assignee
      LEFT JOIN users ass ON r.current_assignee_id = ass.id
      LEFT JOIN departments d ON r.department_id = d.id OR ass.department_id = d.id
      WHERE d.name IS NOT NULL
      GROUP BY d.name
    `;
    const deptRes = await db.query(deptPerformanceQuery);

    res.json({
      summary: statsRes.rows[0],
      trends: trendsRes.rows,
      departments: deptRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching dashboard metrics.' });
  }
});

// Officer Performance Rankings (Manager / Super Admin)
router.get('/officers', verifyToken, checkRole(['Manager', 'Super Admin']), async (req, res) => {
  const { department_id: deptId, role } = req.user;
  
  let queryText = `
    SELECT u.id, u.username, u.email, d.name as department_name,
           COALESCE(m.pending_count, 0) as pending_count,
           COALESCE(m.processed_count, 0) as processed_count,
           ROUND((COALESCE(m.average_time_seconds, 0) / 3600)::numeric, 1) as avg_time_hours,
           COALESCE(m.escalation_count, 0) as escalation_count,
           ROUND((COALESCE(m.rejection_rate, 0) * 100)::numeric, 1) as rejection_percent
    FROM users u
    JOIN departments d ON u.department_id = d.id
    LEFT JOIN officer_metrics m ON u.id = m.officer_id
    WHERE u.role = 'Officer'
  `;
  const params = [];

  if (role === 'Manager') {
    params.push(deptId);
    queryText += ` AND u.department_id = $1`;
  }

  queryText += ` ORDER BY pending_count DESC, processed_count DESC`;

  try {
    const result = await db.query(queryText, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching officer metrics.' });
  }
});

// Anomaly / Corruption Risk Reports (Manager / Super Admin)
router.get('/corruption-anomalies', verifyToken, checkRole(['Manager', 'Super Admin']), async (req, res) => {
  const { department_id: deptId, role } = req.user;

  let queryText = `
    SELECT ar.*, r.reference_number, r.type as request_type, r.status,
           u.username as officer_name, d.name as department_name,
           cit.username as citizen_name
    FROM anomaly_reports ar
    JOIN requests r ON ar.request_id = r.id
    JOIN users cit ON r.citizen_id = cit.id
    LEFT JOIN users u ON ar.suspect_officer_id = u.id
    LEFT JOIN departments d ON ar.department_id = d.id
    WHERE 1=1
  `;
  const params = [];

  if (role === 'Manager') {
    params.push(deptId);
    queryText += ` AND ar.department_id = $1`;
  }

  queryText += ` ORDER BY ar.risk_score DESC LIMIT 30`;

  try {
    const result = await db.query(queryText, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching anomalies.' });
  }
});

// Department Bottleneck Clustering Report
router.get('/bottlenecks', verifyToken, checkRole(['Manager', 'Super Admin']), async (req, res) => {
  const { department_id: deptId, role } = req.user;

  try {
    // Generate department lists and aggregate processing speeds to report
    let queryText = `
      SELECT 
        d.id as department_id,
        d.name as department_name,
        d.code as department_code,
        COUNT(r.id) as total_requests,
        COUNT(CASE WHEN r.status NOT IN ('Approved', 'Rejected') THEN 1 END) as pending_queue,
        COUNT(CASE WHEN r.sla_deadline < CURRENT_TIMESTAMP AND r.status NOT IN ('Approved', 'Rejected') THEN 1 END) as sla_breaches,
        ROUND(AVG(EXTRACT(EPOCH FROM (r.updated_at - r.created_at))/86400)::numeric, 1) as avg_processing_days
      FROM departments d
      LEFT JOIN users u ON u.department_id = d.id
      LEFT JOIN requests r ON r.current_assignee_id = u.id
      GROUP BY d.id, d.name, d.code
    `;
    
    const result = await db.query(queryText);
    
    // Format clusters
    const formatted = result.rows.map(row => {
      const days = parseFloat(row.avg_processing_days || 0.0);
      const queue = parseInt(row.pending_queue, 10);
      
      let severity = 'Low';
      let clusterLabel = 'Efficient Stage';
      
      if (days > 15 || queue > 25) {
        severity = 'High';
        clusterLabel = 'Critical Bottleneck';
      } else if (days > 7 || queue > 10) {
        severity = 'Medium';
        clusterLabel = 'Monitor - Queue Accumulating';
      }
      
      return {
        ...row,
        severity,
        cluster_label: clusterLabel
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching bottleneck reports.' });
  }
});

module.exports = router;
