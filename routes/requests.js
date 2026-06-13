const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const db = require('../db');
const { verifyToken, checkRole } = require('./auth');
const http = require('http');

// Setup multer for document upload
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Helper to make HTTP POST requests to the Python ML service
const callMLService = (endpoint, payload) => {
  return new Promise((resolve, reject) => {
    const dataString = JSON.stringify(payload);
    const options = {
      hostname: 'localhost',
      port: 5000,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': dataString.length
      },
      timeout: 3000
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.warn(`ML Service connection failed for ${endpoint}: ${err.message}. Using fallback simulator.`);
      resolve(null); // Return null to trigger fallback
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(dataString);
    req.end();
  });
};

// Fallback simulations if ML service is down/starting up
const simulateMLPredictions = (reqType, department, workload, queueSize, priority, urgency) => {
  const prob = Math.min(0.95, Math.max(0.05, (workload / 30.0) + (queueSize / 150.0) + (priority === 'Low' ? 0.1 : 0.0) - (urgency ? 0.2 : 0.0)));
  const violationProb = Math.min(0.95, prob * 1.2);
  const expectedDays = Math.max(1, Math.round(10.0 * (1 + prob * 0.8)));
  const expectedDate = new Date();
  expectedDate.setDate(expectedDate.getDate() + expectedDays);
  
  let riskLevel = 'Low';
  if (prob > 0.8) riskLevel = 'Critical';
  else if (prob > 0.5) riskLevel = 'High';
  else if (prob > 0.25) riskLevel = 'Medium';

  return {
    delay_probability: prob,
    expected_completion_date: expectedDate.toISOString(),
    risk_level: riskLevel,
    sla_violation_probability: violationProb,
    suggested_intervention: prob > 0.7 
      ? "CRITICAL: Reassign to an officer with lower workload (< 5 active requests)." 
      : "None required. On track."
  };
};

// Create reference number (GOV-2026-00001)
const generateRefNumber = async () => {
  const currentYear = new Date().getFullYear();
  const countResult = await db.query('SELECT COUNT(*) FROM requests');
  const count = parseInt(countResult.rows[0].count, 10) + 1;
  const seq = count.toString().padStart(5, '0');
  return `GOV-${currentYear}-${seq}`;
};

// Submit Request
router.post('/submit', verifyToken, upload.array('documents'), async (req, res) => {
  const { title, description, type, medical_urgency, legal_urgency, citizen_category } = req.body;

  if (!title || !type) {
    return res.status(400).json({ error: 'Title and Type are required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Map type to department
    const deptMapping = {
      'Income Certificate': 'Revenue',
      'Caste Certificate': 'Revenue',
      'Residence Certificate': 'Revenue',
      'Complaint Registration': 'Complaints',
      'Business License': 'Commercial',
      'Land Approval': 'Land',
      'Scholarship Request': 'Social Welfare',
      'Pension Request': 'Social Welfare',
      'General Service Request': 'Revenue'
    };
    const deptName = deptMapping[type] || 'Revenue';
    
    // Find department ID
    const deptResult = await client.query('SELECT id FROM departments WHERE name = $1', [deptName]);
    const deptId = deptResult.rows[0] ? deptResult.rows[0].id : 1;

    // Find a Clerk in the department to assign
    const clerkResult = await client.query(
      "SELECT id FROM users WHERE role = 'Clerk' AND department_id = $1 ORDER BY RANDOM() LIMIT 1",
      [deptId]
    );
    const assigneeId = clerkResult.rows[0] ? clerkResult.rows[0].id : null;

    // Calculate SLA deadline
    const slaLimits = {
      'Income Certificate': 7, 'Caste Certificate': 10, 'Residence Certificate': 7,
      'Complaint Registration': 20, 'Business License': 25, 'Land Approval': 45,
      'Scholarship Request': 15, 'Pension Request': 21, 'General Service Request': 10
    };
    const limitDays = slaLimits[type] || 14;
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + limitDays);

    const refNum = await generateRefNumber();

    // 2. Predict Priority (Smart Prioritization)
    let priority = 'Medium';
    const isMedical = medical_urgency === 'true' || medical_urgency === true;
    const isLegal = legal_urgency === 'true' || legal_urgency === true;
    
    const priorityPrediction = await callMLService('/predict/priority', {
      medical_urgency: isMedical ? 1 : 0,
      legal_urgency: isLegal ? 1 : 0,
      citizen_category: citizen_category || 'General',
      delayed_risk: 0
    });

    if (priorityPrediction && priorityPrediction.recommended_priority) {
      priority = priorityPrediction.recommended_priority;
    } else if (isMedical || isLegal) {
      priority = 'Critical';
    }

    // Insert Request
    const requestResult = await client.query(
      `INSERT INTO requests 
      (reference_number, title, description, citizen_id, type, status, current_stage, current_assignee_id, priority, medical_urgency, legal_urgency, citizen_category, sla_deadline) 
      VALUES ($1, $2, $3, $4, $5, 'Submitted', 'Clerk', $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        refNum, title, description, req.user.id, type, assigneeId, priority,
        isMedical, isLegal, citizen_category || 'General', deadline
      ]
    );
    const newRequest = requestResult.rows[0];

    // Save uploaded documents
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        await client.query(
          'INSERT INTO documents (request_id, name, file_path, uploaded_by) VALUES ($1, $2, $3, $4)',
          [newRequest.id, file.originalname, file.path, req.user.id]
        );
      }
    }

    // Create assignments
    await client.query(
      'INSERT INTO assignments (request_id, assignee_id, status, remarks) VALUES ($1, $2, $3, $4)',
      [newRequest.id, assigneeId, 'Pending', 'Initial assignment to department clerk']
    );

    // Create Audit Log
    await client.query(
      "INSERT INTO audit_logs (request_id, user_id, action, from_status, to_status, remarks) VALUES ($1, $2, 'Submit Request', NULL, 'Submitted', $3)",
      [newRequest.id, req.user.id, 'Request registered by citizen']
    );

    // Create notification for citizen
    await client.query(
      "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'in_app')",
      [
        req.user.id, 
        'Application Submitted', 
        `Your application for ${type} has been submitted. Reference: ${refNum}`
      ]
    );

    // Fetch officer workload & queue size for ML Predictions
    let workload = 10;
    let queueSize = 35;
    if (assigneeId) {
      const wRes = await client.query("SELECT COUNT(*) FROM requests WHERE current_assignee_id = $1 AND status != 'Approved' AND status != 'Rejected'", [assigneeId]);
      workload = parseInt(wRes.rows[0].count, 10);
    }
    const qRes = await client.query("SELECT COUNT(*) FROM requests WHERE status != 'Approved' AND status != 'Rejected' AND type IN (SELECT type FROM requests WHERE id = $1)", [newRequest.id]);
    queueSize = parseInt(qRes.rows[0].count, 10);

    // Call ML Delay & SLA Prediction Service
    let predictions = await callMLService('/predict/delay', {
      request_type: type,
      department: deptName,
      officer_workload: workload,
      queue_size: queueSize,
      priority: priority,
      escalation_count: 0,
      created_at: newRequest.created_at
    });

    let slaPredictions = await callMLService('/predict/sla', {
      request_type: type,
      department: deptName,
      officer_workload: workload,
      queue_size: queueSize,
      priority: priority,
      escalation_count: 0
    });

    // If ML APIs are not available, simulate
    if (!predictions || !slaPredictions) {
      const simulated = simulateMLPredictions(type, deptName, workload, queueSize, priority, isMedical || isLegal);
      predictions = predictions || simulated;
      slaPredictions = slaPredictions || simulated;
    }

    // Save predictions to DB
    await client.query(
      `INSERT INTO predictions 
      (request_id, delay_probability, expected_completion_date, risk_level, confidence_score, sla_violation_probability, suggested_intervention) 
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newRequest.id, 
        predictions.delay_probability, 
        predictions.expected_completion_date, 
        predictions.risk_level,
        0.89, 
        slaPredictions.sla_violation_probability, 
        slaPredictions.suggested_intervention
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Request submitted successfully!', request: newRequest });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error while submitting request.' });
  } finally {
    client.release();
  }
});

// Get Requests (with filters and role checks)
router.get('/', verifyToken, async (req, res) => {
  const { role, id: userId, department_id: deptId } = req.user;
  const { status, type, priority, search } = req.query;

  let queryText = `
    SELECT r.*, p.delay_probability, p.expected_completion_date, p.risk_level, 
           u.username as citizen_name, u.email as citizen_email,
           d.name as department_name, ass.username as assignee_name
    FROM requests r
    LEFT JOIN predictions p ON r.id = p.request_id
    JOIN users u ON r.citizen_id = u.id
    LEFT JOIN users ass ON r.current_assignee_id = ass.id
    LEFT JOIN departments d ON ass.department_id = d.id
    WHERE 1=1
  `;
  const params = [];

  // Filter based on roles
  if (role === 'Citizen') {
    params.push(userId);
    queryText += ` AND r.citizen_id = $${params.length}`;
  } else if (role === 'Clerk' || role === 'Officer') {
    // Show requests assigned to them OR unassigned requests in their department
    params.push(userId);
    params.push(deptId);
    queryText += ` AND (r.current_assignee_id = $${params.length - 1} OR (r.current_assignee_id IS NULL AND r.status != 'Approved' AND r.status != 'Rejected'))`;
  } else if (role === 'Manager') {
    // Show all requests in their department
    params.push(deptId);
    queryText += ` AND (r.current_assignee_id IN (SELECT id FROM users WHERE department_id = $${params.length}) OR r.current_assignee_id IS NULL)`;
  } // Super Admin sees all

  // Additional optional filters
  if (status) {
    params.push(status);
    queryText += ` AND r.status = $${params.length}`;
  }
  if (type) {
    params.push(type);
    queryText += ` AND r.type = $${params.length}`;
  }
  if (priority) {
    params.push(priority);
    queryText += ` AND r.priority = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    queryText += ` AND (r.reference_number ILIKE $${params.length} OR r.title ILIKE $${params.length} OR u.username ILIKE $${params.length})`;
  }

  queryText += ` ORDER BY r.created_at DESC`;

  try {
    const result = await db.query(queryText, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching requests.' });
  }
});

// Get Request details (with docs, predictions, audit log, AI review)
router.get('/:id', verifyToken, async (req, res) => {
  const reqId = parseInt(req.params.id, 10);

  try {
    const requestRes = await db.query(
      `SELECT r.*, p.delay_probability, p.expected_completion_date, p.risk_level, p.sla_violation_probability, p.suggested_intervention,
              c.username as citizen_name, c.email as citizen_email, c.role as citizen_role,
              ass.username as assignee_name, ass.role as assignee_role,
              d.name as department_name
       FROM requests r
       LEFT JOIN predictions p ON r.id = p.request_id
       JOIN users c ON r.citizen_id = c.id
       LEFT JOIN users ass ON r.current_assignee_id = ass.id
       LEFT JOIN departments d ON ass.department_id = d.id
       WHERE r.id = $1`,
      [reqId]
    );

    if (requestRes.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const requestData = requestRes.rows[0];

    // Documents
    const docsRes = await db.query('SELECT * FROM documents WHERE request_id = $1', [reqId]);
    // Audit logs
    const auditRes = await db.query(
      `SELECT a.*, u.username, u.role 
       FROM audit_logs a 
       LEFT JOIN users u ON a.user_id = u.id 
       WHERE a.request_id = $1 
       ORDER BY a.created_at DESC`,
      [reqId]
    );

    // Call ML service to generate dynamic AI decision review summary
    let aiAssistantReview = null;
    const aiReview = await callMLService('/ai/assistant', {
      id: requestData.id,
      title: requestData.title,
      description: requestData.description,
      type: requestData.type,
      citizen_name: requestData.citizen_name,
      citizen_category: requestData.citizen_category,
      documents: docsRes.rows,
      delay_probability: requestData.delay_probability,
      priority: requestData.priority
    });

    if (aiReview) {
      aiAssistantReview = aiReview;
    } else {
      // Offline fallback simulator
      const missing = [];
      const required = ['ID Proof'];
      if (requestData.type === 'Income Certificate') required.push('Salary Slip', 'Tax Return');
      const docsNames = docsRes.rows.map(d => d.name);
      required.forEach(r => {
        if (!docsNames.some(d => d.toLowerCase().includes(r.toLowerCase()))) {
          missing.push(r);
        }
      });
      aiAssistantReview = {
        summary: `Application from ${requestData.citizen_name} requesting ${requestData.type}.`,
        checklist: required.map(r => ({ document: r, status: missing.includes(r) ? 'Missing' : 'Uploaded' })),
        missing_documents: missing,
        recommended_action: missing.length > 0 ? "Return for Correction" : "Approve",
        explanation: missing.length > 0 
          ? `Missing essential documents: ${missing.join(', ')}. Recommend return.` 
          : "Verification success. Recommending approval.",
        confidence_score: missing.length > 0 ? 0.90 : 0.95
      };
    }

    res.json({
      request: requestData,
      documents: docsRes.rows,
      auditLogs: auditRes.rows,
      aiReview: aiAssistantReview
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching request details.' });
  }
});

// Download Approved Certificate PDF
router.get('/:id/download', verifyToken, async (req, res) => {
  const reqId = parseInt(req.params.id, 10);

  try {
    const result = await db.query(
      `SELECT r.*, u.username as citizen_name, u.email as citizen_email
       FROM requests r
       JOIN users u ON r.citizen_id = u.id
       WHERE r.id = $1`,
      [reqId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const requestData = result.rows[0];

    if (requestData.status !== 'Approved') {
      return res.status(400).json({ error: 'Certificate can only be downloaded for Approved requests.' });
    }

    // Generate PDF document using pdfkit
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${requestData.reference_number}.pdf"`);

    doc.pipe(res);

    // Styling & Layout
    doc.rect(20, 20, 572, 752).stroke('#1e3a8a');
    doc.rect(25, 25, 562, 742).stroke('#b45309');

    doc.fontSize(26).fillColor('#1e3a8a').text('GOVERNMENT OF THE REPUBLIC', { align: 'center' });
    doc.fontSize(14).fillColor('#4b5563').text('OFFICIAL SERVICE CERTIFICATE', { align: 'center' });
    doc.moveDown(2);

    doc.fontSize(12).fillColor('#1f2937').text(`Certificate Reference: ${requestData.reference_number}`, { align: 'right' });
    doc.text(`Issue Date: ${new Date(requestData.updated_at).toLocaleDateString()}`, { align: 'right' });
    doc.moveDown(2);

    doc.fontSize(18).fillColor('#1e3a8a').text(`CERTIFICATE OF ${requestData.type.toUpperCase()}`, { align: 'center', underline: true });
    doc.moveDown(1.5);

    const bodyText = `This is to officially certify that the application filed by citizen ${requestData.citizen_name} for the issuance of a ${requestData.type} has been thoroughly reviewed and verified by the competent departmental authorities. All administrative criteria and documentation checklists have been met in full compliance with the statutory regulations.`;
    
    doc.fontSize(12).fillColor('#374151').text(bodyText, { align: 'justify', lineGap: 6 });
    doc.moveDown(2);

    // Certificate details
    doc.rect(40, doc.y, 512, 120).fill('#f3f4f6');
    doc.fillColor('#1e3a8a');
    doc.fontSize(12).text('OFFICIAL RECORD DETAILS', 50, doc.y + 10, { underline: true });
    
    doc.fillColor('#374151');
    doc.text(`Applicant Name: ${requestData.citizen_name}`, 50, doc.y + 15);
    doc.text(`Category: ${requestData.citizen_category}`, 50, doc.y + 5);
    doc.text(`Purpose / Details: ${requestData.title}`, 50, doc.y + 5);
    doc.text(`Assigned / Approved Under SLA Limit: Completed Successfully`, 50, doc.y + 5);
    
    doc.moveDown(4);

    doc.fontSize(12).fillColor('#1e3a8a').text('Authorized Seal & Signature', 400, doc.y, { align: 'center' });
    doc.fontSize(10).fillColor('#6b7280').text('GovFlow Workflow Automation Engine v2.0', 400, doc.y + 5, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error generating certificate.' });
  }
});

module.exports = router;
