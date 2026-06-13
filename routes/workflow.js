const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('./auth');

// Forward Request (Next stage in workflow)
router.post('/forward', verifyToken, async (req, res) => {
  const { request_id, remarks } = req.body;
  if (!request_id) {
    return res.status(400).json({ error: 'Request ID is required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch active request
    const requestRes = await client.query('SELECT * FROM requests WHERE id = $1', [request_id]);
    if (requestRes.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    const requestData = requestRes.rows[0];

    let nextStage, nextStatus, nextAssigneeId = null;
    let assignmentRemarks = remarks || 'Forwarded to next stage.';

    if (requestData.current_stage === 'Clerk') {
      nextStage = 'Officer';
      nextStatus = 'In_Review_Officer';
      // Find an Officer in same department
      const officerRes = await client.query(
        "SELECT id FROM users WHERE role = 'Officer' AND department_id = (SELECT department_id FROM users WHERE id = $1) ORDER BY RANDOM() LIMIT 1",
        [requestData.current_assignee_id]
      );
      nextAssigneeId = officerRes.rows[0] ? officerRes.rows[0].id : null;
    } else if (requestData.current_stage === 'Officer') {
      nextStage = 'Manager';
      nextStatus = 'In_Review_Manager';
      // Find a Manager in same department
      const managerRes = await client.query(
        "SELECT id FROM users WHERE role = 'Manager' AND department_id = (SELECT department_id FROM users WHERE id = $1) ORDER BY RANDOM() LIMIT 1",
        [requestData.current_assignee_id]
      );
      nextAssigneeId = managerRes.rows[0] ? managerRes.rows[0].id : null;
    } else if (requestData.current_stage === 'Manager') {
      nextStage = 'Completed';
      nextStatus = 'Approved';
      nextAssigneeId = null;
      assignmentRemarks = remarks || 'Final approval granted by manager.';
    } else if (requestData.current_stage === 'Citizen') {
      // Re-submitted by Citizen -> Back to Clerk
      nextStage = 'Clerk';
      nextStatus = 'In_Review_Clerk';
      const clerkRes = await client.query(
        "SELECT id FROM users WHERE role = 'Clerk' AND department_id = $1 ORDER BY RANDOM() LIMIT 1",
        [requestData.department_id || 1]
      );
      nextAssigneeId = clerkRes.rows[0] ? clerkRes.rows[0].id : null;
      assignmentRemarks = remarks || 'Re-submitted with corrections.';
    } else {
      return res.status(400).json({ error: 'Cannot forward completed request.' });
    }

    // Update assignment
    await client.query(
      "UPDATE assignments SET status = 'Completed', completed_at = CURRENT_TIMESTAMP WHERE request_id = $1 AND status = 'Pending'",
      [request_id]
    );

    // Create new assignment
    if (nextAssigneeId) {
      await client.query(
        "INSERT INTO assignments (request_id, assigner_id, assignee_id, status, remarks) VALUES ($1, $2, $3, 'Pending', $4)",
        [request_id, req.user.id, nextAssigneeId, assignmentRemarks]
      );
    }

    // Update Request
    const updatedRequest = await client.query(
      `UPDATE requests 
       SET current_stage = $1, status = $2, current_assignee_id = $3, last_action_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $4 RETURNING *`,
      [nextStage, nextStatus, nextAssigneeId, request_id]
    );

    // Create Audit Log
    await client.query(
      "INSERT INTO audit_logs (request_id, user_id, action, from_status, to_status, remarks) VALUES ($1, $2, 'Forward Request', $3, $4, $5)",
      [request_id, req.user.id, requestData.status, nextStatus, remarks]
    );

    // Notify applicant
    await client.query(
      "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'in_app')",
      [
        requestData.citizen_id,
        `Request Stage Updated`,
        `Your request ${requestData.reference_number} was forwarded to ${nextStage}. Status: ${nextStatus}`
      ]
    );

    // Notify new assignee
    if (nextAssigneeId) {
      await client.query(
        "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'in_app')",
        [
          nextAssigneeId,
          `New Task Assigned`,
          `Request ${requestData.reference_number} has been assigned to you for review.`
        ]
      );
    }

    // Update Officer Metrics if processed by Officer
    if (req.user.role === 'Officer') {
      const durationSeconds = Math.round((new Date() - new Date(requestData.last_action_at)) / 1000);
      await client.query(
        `UPDATE officer_metrics 
         SET processed_count = processed_count + 1,
             average_time_seconds = (average_time_seconds * processed_count + $1) / (processed_count + 1)
         WHERE officer_id = $2`,
        [durationSeconds, req.user.id]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Request forwarded successfully.', request: updatedRequest.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error forwarding request.' });
  } finally {
    client.release();
  }
});

// Return for Correction (Send back to Citizen)
router.post('/return', verifyToken, async (req, res) => {
  const { request_id, remarks } = req.body;
  if (!request_id || !remarks) {
    return res.status(400).json({ error: 'Request ID and remarks are required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const requestRes = await client.query('SELECT * FROM requests WHERE id = $1', [request_id]);
    if (requestRes.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    const requestData = requestRes.rows[0];

    // Update old assignment
    await client.query(
      "UPDATE assignments SET status = 'Returned', completed_at = CURRENT_TIMESTAMP WHERE request_id = $1 AND status = 'Pending'",
      [request_id]
    );

    // Create new assignment pointing to the citizen
    await client.query(
      "INSERT INTO assignments (request_id, assigner_id, assignee_id, status, remarks) VALUES ($1, $2, $3, 'Pending', $4)",
      [request_id, req.user.id, requestData.citizen_id, remarks]
    );

    // Update Request
    const updatedRequest = await client.query(
      `UPDATE requests 
       SET current_stage = 'Citizen', status = 'Returned_For_Correction', current_assignee_id = citizen_id, last_action_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 RETURNING *`,
      [request_id]
    );

    // Create Audit Log
    await client.query(
      "INSERT INTO audit_logs (request_id, user_id, action, from_status, to_status, remarks) VALUES ($1, $2, 'Return for Correction', $3, 'Returned_For_Correction', $4)",
      [request_id, req.user.id, requestData.status, remarks]
    );

    // Notify Citizen
    await client.query(
      "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'in_app')",
      [
        requestData.citizen_id,
        `Application Returned for Correction`,
        `Your application ${requestData.reference_number} requires attention: ${remarks}`
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Request returned for correction.', request: updatedRequest.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error returning request.' });
  } finally {
    client.release();
  }
});

// Reject Request
router.post('/reject', verifyToken, async (req, res) => {
  const { request_id, remarks } = req.body;
  if (!request_id || !remarks) {
    return res.status(400).json({ error: 'Request ID and rejection remarks are required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const requestRes = await client.query('SELECT * FROM requests WHERE id = $1', [request_id]);
    if (requestRes.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    const requestData = requestRes.rows[0];

    // Update old assignment
    await client.query(
      "UPDATE assignments SET status = 'Completed', completed_at = CURRENT_TIMESTAMP WHERE request_id = $1 AND status = 'Pending'",
      [request_id]
    );

    // Update Request
    const updatedRequest = await client.query(
      `UPDATE requests 
       SET current_stage = 'Completed', status = 'Rejected', current_assignee_id = NULL, last_action_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 RETURNING *`,
      [request_id]
    );

    // Create Audit Log
    await client.query(
      "INSERT INTO audit_logs (request_id, user_id, action, from_status, to_status, remarks) VALUES ($1, $2, 'Reject Request', $3, 'Rejected', $4)",
      [request_id, req.user.id, requestData.status, remarks]
    );

    // Notify Citizen
    await client.query(
      "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'rejection')",
      [
        requestData.citizen_id,
        `Application Rejected`,
        `Your application ${requestData.reference_number} has been rejected. Reason: ${remarks}`
      ]
    );

    // Update Officer Metrics Rejection rate
    if (req.user.role === 'Officer') {
      const metricsRes = await client.query('SELECT processed_count FROM officer_metrics WHERE officer_id = $1', [req.user.id]);
      const processed = metricsRes.rows[0] ? metricsRes.rows[0].processed_count : 0;
      await client.query(
        `UPDATE officer_metrics 
         SET processed_count = processed_count + 1,
             rejection_rate = (rejection_rate * processed + 1.0) / (processed + 1)
         WHERE officer_id = $2`,
        [req.user.id]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Request rejected successfully.', request: updatedRequest.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error rejecting request.' });
  } finally {
    client.release();
  }
});

// Escalate Request (Manual or SLA triggered)
router.post('/escalate', verifyToken, async (req, res) => {
  const { request_id, remarks } = req.body;
  if (!request_id) {
    return res.status(400).json({ error: 'Request ID is required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const requestRes = await client.query('SELECT * FROM requests WHERE id = $1', [request_id]);
    if (requestRes.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    const requestData = requestRes.rows[0];

    // Assign directly to a Manager in same department
    const managerRes = await client.query(
      "SELECT id FROM users WHERE role = 'Manager' AND department_id = $1 ORDER BY RANDOM() LIMIT 1",
      [requestData.department_id || 1]
    );
    const managerId = managerRes.rows[0] ? managerRes.rows[0].id : null;

    if (!managerId) {
      throw new Error('No department manager found to escalate to.');
    }

    // Update current assignment to 'Escalated'
    await client.query(
      "UPDATE assignments SET status = 'Escalated', completed_at = CURRENT_TIMESTAMP WHERE request_id = $1 AND status = 'Pending'",
      [request_id]
    );

    // Create new assignment for manager
    await client.query(
      "INSERT INTO assignments (request_id, assigner_id, assignee_id, status, remarks) VALUES ($1, $2, $3, 'Pending', $4)",
      [request_id, req.user.id, managerId, remarks || 'Escalated due to SLA breach / urgency.']
    );

    // Update Request
    const updatedRequest = await client.query(
      `UPDATE requests 
       SET current_stage = 'Manager', status = 'In_Review_Manager', current_assignee_id = $1, is_escalated = TRUE, last_action_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 RETURNING *`,
      [managerId, request_id]
    );

    // Create Audit Log
    await client.query(
      "INSERT INTO audit_logs (request_id, user_id, action, from_status, to_status, remarks) VALUES ($1, $2, 'Escalate Request', $3, 'In_Review_Manager', $4)",
      [request_id, req.user.id, requestData.status, remarks || 'SLA Escalation']
    );

    // Notify current assignee about escalation
    if (requestData.current_assignee_id) {
      await client.query(
        "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'escalation')",
        [
          requestData.current_assignee_id,
          `Task Escalated Away`,
          `Request ${requestData.reference_number} was escalated to the Manager due to processing delays.`
        ]
      );
      
      // If it was an Officer, log escalation metrics
      await client.query(
        'UPDATE officer_metrics SET escalation_count = escalation_count + 1 WHERE officer_id = $1',
        [requestData.current_assignee_id]
      );
    }

    // Notify Manager
    await client.query(
      "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'escalation')",
      [
        managerId,
        `Urgent: Escalated Task`,
        `Request ${requestData.reference_number} has been escalated to your desk. Action required.`
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Request escalated successfully.', request: updatedRequest.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error escalating request.' });
  } finally {
    client.release();
  }
});

module.exports = router;
