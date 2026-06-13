const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes Imports
const { router: authRouter } = require('./routes/auth');
const requestsRouter = require('./routes/requests');
const workflowRouter = require('./routes/workflow');
const analyticsRouter = require('./routes/analytics');
const chatbotRouter = require('./routes/chatbot');

// API Routes mounting
app.use('/api/auth', authRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/workflow', workflowRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/chatbot', chatbotRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'API server is running', timestamp: new Date() });
});

// SLA Background Auto-Escalation Engine
// Periodically checks for requests that have exceeded their SLA deadline,
// are not approved or rejected, and are not yet escalated, then escalates them.
const runAutoEscalationCheck = async () => {
  console.log('Running SLA Breach & Auto-Escalation check...');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    
    // Find requests that crossed deadline, not completed, not escalated
    const breachedRes = await client.query(
      `SELECT r.*, d.id as dept_id 
       FROM requests r
       LEFT JOIN users u ON r.current_assignee_id = u.id
       LEFT JOIN departments d ON u.department_id = d.id OR r.department_id = d.id
       WHERE r.sla_deadline < CURRENT_TIMESTAMP 
         AND r.status NOT IN ('Approved', 'Rejected') 
         AND r.is_escalated = FALSE`
    );

    if (breachedRes.rows.length > 0) {
      console.log(`Found ${breachedRes.rows.length} requests breaching SLA. Escalating...`);
      for (const req of breachedRes.rows) {
        // Find a manager in department
        const managerRes = await client.query(
          "SELECT id FROM users WHERE role = 'Manager' AND department_id = $1 ORDER BY RANDOM() LIMIT 1",
          [req.department_id || req.dept_id || 1]
        );
        const managerId = managerRes.rows[0] ? managerRes.rows[0].id : null;

        if (managerId) {
          // Complete old assignment
          await client.query(
            "UPDATE assignments SET status = 'Escalated', completed_at = CURRENT_TIMESTAMP WHERE request_id = $1 AND status = 'Pending'",
            [req.id]
          );

          // Add manager assignment
          await client.query(
            "INSERT INTO assignments (request_id, assigner_id, assignee_id, status, remarks) VALUES ($1, NULL, $2, 'Pending', 'Auto-escalated by SLA Engine due to deadline breach')",
            [req.id, managerId]
          );

          // Update request status/stage
          await client.query(
            `UPDATE requests 
             SET current_stage = 'Manager', status = 'In_Review_Manager', current_assignee_id = $1, is_escalated = TRUE, last_action_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [managerId, req.id]
          );

          // Log Audit
          await client.query(
            "INSERT INTO audit_logs (request_id, user_id, action, from_status, to_status, remarks) VALUES ($1, NULL, 'Auto Escalation', $2, 'In_Review_Manager', 'SLA deadline breached. Automated engine escalation.')",
            [req.id, req.status]
          );

          // Notifications
          await client.query(
            "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'Application Escalated', $2, 'escalation')",
            [req.citizen_id, `Your request ${req.reference_number} was automatically escalated to the manager due to processing delay.`]
          );
          
          await client.query(
            "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'Urgent: SLA Breached Task', $2, 'escalation')",
            [managerId, `Request ${req.reference_number} has breached SLA deadline and was auto-escalated to you.`]
          );

          if (req.current_assignee_id) {
            await client.query(
              "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'Task Escalated Away', $2, 'escalation')",
              [req.current_assignee_id, `Request ${req.reference_number} was escalated away due to SLA deadline violation.`]
            );
            await client.query(
              'UPDATE officer_metrics SET escalation_count = escalation_count + 1 WHERE officer_id = $1',
              [req.current_assignee_id]
            );
          }
        }
      }
    }
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in Auto-Escalation Job:', err.message);
  } finally {
    client.release();
  }
};

// Check every 30 seconds
setInterval(runAutoEscalationCheck, 30000);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`GovFlow backend server listening on port ${PORT}`);
  // Run an initial check after a few seconds
  setTimeout(runAutoEscalationCheck, 5000);
});
