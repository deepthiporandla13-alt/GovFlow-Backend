const db = require('./db');
const bcrypt = require('bcryptjs');

const seed = async () => {
  const client = await db.pool.connect();
  try {
    console.log('Seeding GovFlow AI 2.0 Database...');
    await client.query('BEGIN');

    // 1. Clear existing data
    await client.query('TRUNCATE officer_metrics, anomaly_reports, predictions, audit_logs, notifications, assignments, documents, requests, users, departments RESTART IDENTITY CASCADE');
    console.log('Cleared existing tables.');

    // 2. Seed Departments
    const depts = [
      { name: 'Revenue Department', code: 'REV', description: 'Handles Income, Caste, and Residence certificates.' },
      { name: 'Land Administration', code: 'LND', description: 'Deals with land records, deed approvals, and surveying.' },
      { name: 'Social Welfare', code: 'SWD', description: 'Administers scholarships and pensions.' },
      { name: 'Complaints Portal', code: 'CMP', description: 'Grievance registration and feedback systems.' },
      { name: 'Commercial & Licensing', code: 'COM', description: 'Handles business registration and trading licenses.' }
    ];
    
    const deptIds = {};
    for (const d of depts) {
      const res = await client.query(
        'INSERT INTO departments (name, code, description) VALUES ($1, $2, $3) RETURNING id',
        [d.name, d.code, d.description]
      );
      deptIds[d.name] = res.rows[0].id;
    }
    console.log('Seeded departments.');

    // 3. Seed Users
    const salt = await bcrypt.genSalt(10);
    const passHash = await bcrypt.hash('password123', salt);
    
    const users = [
      { username: 'superadmin', email: 'admin@govflow.gov', role: 'Super Admin', dept: null },
      
      { username: 'revenue_clerk', email: 'clerk.rev@govflow.gov', role: 'Clerk', dept: 'Revenue Department' },
      { username: 'land_clerk', email: 'clerk.lnd@govflow.gov', role: 'Clerk', dept: 'Land Administration' },
      { username: 'welfare_clerk', email: 'clerk.swd@govflow.gov', role: 'Clerk', dept: 'Social Welfare' },
      
      { username: 'officer_rev1', email: 'officer.rev1@govflow.gov', role: 'Officer', dept: 'Revenue Department' },
      { username: 'officer_rev2', email: 'officer.rev2@govflow.gov', role: 'Officer', dept: 'Revenue Department' },
      { username: 'officer_lnd1', email: 'officer.lnd1@govflow.gov', role: 'Officer', dept: 'Land Administration' },
      { username: 'officer_swd1', email: 'officer.swd1@govflow.gov', role: 'Officer', dept: 'Social Welfare' },
      
      { username: 'manager_rev', email: 'manager.rev@govflow.gov', role: 'Manager', dept: 'Revenue Department' },
      { username: 'manager_lnd', email: 'manager.lnd@govflow.gov', role: 'Manager', dept: 'Land Administration' },
      { username: 'manager_swd', email: 'manager.swd@govflow.gov', role: 'Manager', dept: 'Social Welfare' },
      
      { username: 'citizen_raj', email: 'raj@gmail.com', role: 'Citizen', dept: null },
      { username: 'citizen_priya', email: 'priya@gmail.com', role: 'Citizen', dept: null },
      { username: 'citizen_amit', email: 'amit@gmail.com', role: 'Citizen', dept: null }
    ];

    const userMap = {};
    for (const u of users) {
      const deptId = u.dept ? deptIds[u.dept] : null;
      const res = await client.query(
        'INSERT INTO users (username, email, password_hash, role, department_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role',
        [u.username, u.email, passHash, u.role, deptId]
      );
      userMap[u.username] = res.rows[0];
      
      // Seed Officer metrics
      if (u.role === 'Officer') {
        const processed = Math.floor(Math.random() * 80) + 20;
        const pending = Math.floor(Math.random() * 10) + 2;
        const avgSec = Math.floor(Math.random() * 200000) + 50000; // ~15-60 hours avg
        const escCount = Math.floor(Math.random() * 6);
        const rejRate = Math.random() * 0.15;
        
        await client.query(
          'INSERT INTO officer_metrics (officer_id, pending_count, processed_count, average_time_seconds, escalation_count, rejection_rate) VALUES ($1, $2, $3, $4, $5, $6)',
          [res.rows[0].id, pending, processed, avgSec, escCount, rejRate]
        );
      }
    }
    console.log('Seeded users and officer metrics.');

    // 4. Seed Requests
    const requestData = [
      {
        ref: 'GOV-2026-00001',
        title: 'Income Certificate for College Admission',
        desc: 'Need certificate for state scholarship application before end of month.',
        citizen: 'citizen_raj',
        type: 'Income Certificate',
        status: 'Approved',
        stage: 'Completed',
        assignee: null,
        priority: 'High',
        med: false,
        leg: false,
        daysOffset: -12,
        daysDeadline: 7
      },
      {
        ref: 'GOV-2026-00002',
        title: 'Caste Certificate Re-issue',
        desc: 'Requesting correction in community spelling from prior records.',
        citizen: 'citizen_priya',
        type: 'Caste Certificate',
        status: 'In_Review_Officer',
        stage: 'Officer',
        assignee: 'officer_rev1',
        priority: 'Medium',
        med: false,
        leg: false,
        daysOffset: -3,
        daysDeadline: 10
      },
      {
        ref: 'GOV-2026-00003',
        title: 'Urgent Medical Expense Pension Advance',
        desc: 'Applying for critical health coverage reimbursement under senior scheme.',
        citizen: 'citizen_amit',
        type: 'Pension Request',
        status: 'In_Review_Manager',
        stage: 'Manager',
        assignee: 'manager_swd',
        priority: 'Critical',
        med: true,
        leg: false,
        daysOffset: -1,
        daysDeadline: 5
      },
      {
        ref: 'GOV-2026-00004',
        title: 'Residence Proof for Bank Account',
        desc: 'Newly shifted resident seeking local residency registration.',
        citizen: 'citizen_raj',
        type: 'Residence Certificate',
        status: 'Returned_For_Correction',
        stage: 'Citizen',
        assignee: 'citizen_raj',
        priority: 'Low',
        med: false,
        leg: false,
        daysOffset: -8,
        daysDeadline: 7
      },
      {
        ref: 'GOV-2026-00005',
        title: 'Business License for Retail Pharmacy',
        desc: 'Applying for commercial trading permissions in market block.',
        citizen: 'citizen_priya',
        type: 'Business License',
        status: 'Submitted',
        stage: 'Clerk',
        assignee: 'revenue_clerk', // Assumed assigned
        priority: 'High',
        med: true,
        leg: false,
        daysOffset: -1,
        daysDeadline: 25
      },
      {
        ref: 'GOV-2026-00006',
        title: 'Agricultural Land Title Transfer',
        desc: 'Transferring plot reference 204B to legal heirs.',
        citizen: 'citizen_amit',
        type: 'Land Approval',
        status: 'In_Review_Officer',
        stage: 'Officer',
        assignee: 'officer_lnd1',
        priority: 'Medium',
        med: false,
        leg: true,
        daysOffset: -46, // Past SLA (45 days)
        daysDeadline: 45
      }
    ];

    for (const r of requestData) {
      const cit = userMap[r.citizen];
      const ass = r.assignee ? userMap[r.assignee] : null;
      
      const created = new Date();
      created.setDate(created.getDate() + r.daysOffset);
      
      const deadline = new Date(created);
      deadline.setDate(deadline.getDate() + r.daysDeadline);

      const reqRes = await client.query(
        `INSERT INTO requests 
         (reference_number, title, description, citizen_id, type, status, current_stage, current_assignee_id, priority, medical_urgency, legal_urgency, citizen_category, sla_deadline, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'General', $12, $13, $14) RETURNING id`,
        [
          r.ref, r.title, r.desc, cit.id, r.type, r.status, r.stage, 
          ass ? ass.id : null, r.priority, r.med, r.leg, deadline, created, created
        ]
      );
      const reqId = reqRes.rows[0].id;

      // Seed Documents
      await client.query(
        'INSERT INTO documents (request_id, name, file_path, uploaded_by) VALUES ($1, $2, $3, $4)',
        [reqId, 'Identity_Card_Proof.pdf', '/uploads/mock-id.pdf', cit.id]
      );
      if (r.type === 'Income Certificate') {
        await client.query(
          'INSERT INTO documents (request_id, name, file_path, uploaded_by) VALUES ($1, $2, $3, $4)',
          [reqId, 'Salary_Slip_Record.pdf', '/uploads/mock-salary.pdf', cit.id]
        );
      }

      // Seed Assignments
      await client.query(
        "INSERT INTO assignments (request_id, assigner_id, assignee_id, status, remarks) VALUES ($1, NULL, $2, $3, 'Seeded application stage')",
        [reqId, ass ? ass.id : null, r.status === 'Approved' || r.status === 'Rejected' ? 'Completed' : 'Pending']
      );

      // Seed Audit Logs
      await client.query(
        "INSERT INTO audit_logs (request_id, user_id, action, from_status, to_status, remarks, created_at) VALUES ($1, $2, 'Submit Application', NULL, 'Submitted', 'Initial request submitted.', $3)",
        [reqId, cit.id, created]
      );

      // Seed Predictions
      const delayProb = r.ref === 'GOV-2026-00006' ? 0.92 : (r.priority === 'High' ? 0.35 : 0.18);
      const expectedDays = r.ref === 'GOV-2026-00006' ? 52 : 12;
      const expectedDate = new Date(created);
      expectedDate.setDate(expectedDate.getDate() + expectedDays);

      await client.query(
        `INSERT INTO predictions 
         (request_id, delay_probability, expected_completion_date, risk_level, confidence_score, sla_violation_probability, suggested_intervention) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          reqId, 
          delayProb, 
          expectedDate, 
          delayProb > 0.8 ? 'Critical' : (delayProb > 0.3 ? 'High' : 'Low'),
          0.91, 
          delayProb * 1.1,
          delayProb > 0.8 ? 'CRITICAL: Reassign immediately to relieve backlog.' : 'On track.'
        ]
      );
    }
    console.log('Seeded requests, docs, assignments, audit logs, and predictions.');

    // 5. Seed Anomaly / Corruption Reports
    // Let's create an anomaly for officer_rev2: very quick approvals
    // And officer_lnd1: excessive delay on inheritance deed
    const suspectOfficer1 = userMap['officer_rev2'];
    const suspectOfficer2 = userMap['officer_lnd1'];
    
    // Find land request ID
    const landReq = await client.query("SELECT id FROM requests WHERE reference_number = 'GOV-2026-00006'");
    const landReqId = landReq.rows[0].id;
    
    await client.query(
      `INSERT INTO anomaly_reports (request_id, suspect_officer_id, department_id, risk_score, reasons) 
       VALUES ($1, $2, $3, $4, $5)`,
      [
        landReqId, 
        suspectOfficer2.id, 
        deptIds['Land Administration'], 
        0.86, 
        'Request is delayed by 46 days (SLA limit 45 days) despite critical urgency flags and low officer workload. Potential deliberate delay or request bottleneck.'
      ]
    );

    // Create a generic anomaly report for quick revenue approval
    const revReq = await client.query("SELECT id FROM requests WHERE reference_number = 'GOV-2026-00001'");
    const revReqId = revReq.rows[0].id;
    await client.query(
      `INSERT INTO anomaly_reports (request_id, suspect_officer_id, department_id, risk_score, reasons) 
       VALUES ($1, $2, $3, $4, $5)`,
      [
        revReqId, 
        suspectOfficer1.id, 
        deptIds['Revenue Department'], 
        0.75, 
        'Approved in less than 2.5 hours by the officer. Historical mean processing time for Income Certificates is 5.2 days. High speed outlier detected.'
      ]
    );

    console.log('Seeded anomalies.');

    await client.query('COMMIT');
    console.log('Database Seeding Completed Successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error seeding database:', err);
  } finally {
    client.release();
    process.exit(0);
  }
};

seed();
