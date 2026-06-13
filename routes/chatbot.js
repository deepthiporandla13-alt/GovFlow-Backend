const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('./auth');

// Simple regex chatbot parser
const getRequiredDocs = (type) => {
  const docs = {
    'income': ['Salary Slip', 'Tax Return', 'ID Proof (Aadhar/Voter ID)'],
    'caste': ['Community Proof', 'Father Caste Certificate', 'Identity Card'],
    'residence': ['Aadhar Card', 'Electricity Bill', 'Rent Agreement'],
    'complaint': ['Evidence Photo/Document', 'Incident Report'],
    'business': ['Company Registration certificate', 'PAN Card', 'NOC Certificate'],
    'land': ['Land Deed', 'Survey Map', 'Tax Receipt', 'NOC Certificate'],
    'scholarship': ['Income Certificate', 'Academic Marksheet', 'College ID'],
    'pension': ['Age Proof', 'Income Proof', 'Bank Passbook Details'],
    'general': ['Application Form', 'ID Proof']
  };
  
  const key = Object.keys(docs).find(k => type.toLowerCase().includes(k));
  return docs[key || 'general'];
};

router.post('/query', verifyToken, async (req, res) => {
  const { message } = req.body;
  const userId = req.user.id;

  if (!message) {
    return res.status(400).json({ error: 'Message query is required.' });
  }

  try {
    const msg = message.toLowerCase();
    let responseText = "";

    // 1. Fetch User Requests for context
    const userRequestsRes = await db.query(
      `SELECT r.*, p.expected_completion_date, p.risk_level, p.delay_probability, d.name as department_name
       FROM requests r
       LEFT JOIN predictions p ON r.id = p.request_id
       LEFT JOIN users u ON r.current_assignee_id = u.id
       LEFT JOIN departments d ON u.department_id = d.id
       WHERE r.citizen_id = $1
       ORDER BY r.created_at DESC`,
      [userId]
    );
    const requests = userRequestsRes.rows;

    // Determine query intent
    if (msg.includes('where is my file') || msg.includes('status') || msg.includes('my application') || msg.includes('my request')) {
      if (requests.length === 0) {
        responseText = "You haven't submitted any applications yet. Go to 'Submit Request' in your dashboard to start!";
      } else {
        responseText = "Here is the status of your active application(s):\n\n";
        requests.forEach((r, idx) => {
          responseText += `${idx + 1}. **${r.type}** (${r.reference_number}):\n`;
          responseText += `   • **Current Stage**: ${r.current_stage}\n`;
          responseText += `   • **Status**: ${r.status.replace(/_/g, ' ')}\n`;
          responseText += `   • **Department**: ${r.department_name || 'Processing Desk'}\n`;
          if (r.status === 'Approved') {
            responseText += `   • **Action**: Certificate is approved! You can download the PDF from your history.\n`;
          } else if (r.status === 'Returned_For_Correction') {
            responseText += `   • **Action**: Action required! This file was returned to you. Please read the remarks in your dashboard.\n`;
          }
          responseText += '\n';
        });
      }
    } 
    
    else if (msg.includes('document') || msg.includes('what is required') || msg.includes('requirements')) {
      const certificates = [
        'Income Certificate', 'Caste Certificate', 'Residence Certificate',
        'Complaint Registration', 'Business License', 'Land Approval',
        'Scholarship Request', 'Pension Request'
      ];
      
      let matchedCert = certificates.find(c => msg.includes(c.toLowerCase().split(' ')[0]));
      
      if (matchedCert) {
        const docs = getRequiredDocs(matchedCert);
        responseText = `To apply for a **${matchedCert}**, you must upload the following documents:\n\n` + 
                       docs.map(d => `• ${d}`).join('\n') + 
                       `\n\nMake sure copies are scanned clearly in PDF or JPG format.`;
      } else {
        responseText = `Which application requirements are you looking for? I can help you with:\n` +
                       certificates.map(c => `• ${c}`).join('\n');
      }
    }
    
    else if (msg.includes('delay') || msg.includes('why is it taking long') || msg.includes('stuck')) {
      if (requests.length === 0) {
        responseText = "You don't have any applications under review. Delays only apply to submitted and pending files.";
      } else {
        const active = requests.find(r => r.status !== 'Approved' && r.status !== 'Rejected');
        if (!active) {
          responseText = "Your previous applications are already completed! If you submitted a new one, please wait a few moments for indexing.";
        } else {
          const delayProb = Math.round(active.delay_probability * 100);
          responseText = `Regarding your application **${active.type}** (${active.reference_number}):\n\n` +
                         `• **Current Delay Risk**: ${active.risk_level} (${delayProb}% probability of exceeding base SLA)\n` +
                         `• **Assigned Stage**: ${active.current_stage} Review\n` +
                         `• **Primary Cause**: Our AI model predicts backlog queues or officer workloads in the department are slightly elevated. `;
          
          if (active.status === 'Returned_For_Correction') {
            responseText += `Additionally, the clerk returned this file for corrections. Submitting updates will resume processing immediately.`;
          } else {
            responseText += `Rest assured, it is under active review. If it breaches SLA limits, it will be automatically escalated to a department manager.`;
          }
        }
      }
    }
    
    else if (msg.includes('completion') || msg.includes('when will') || msg.includes('how much time') || msg.includes('estimate')) {
      if (requests.length === 0) {
        responseText = "You have no active requests. Submit a request to view completion forecasts.";
      } else {
        const active = requests.find(r => r.status !== 'Approved' && r.status !== 'Rejected');
        if (!active) {
          responseText = "Your requests have already been processed and closed.";
        } else {
          const estDate = active.expected_completion_date 
            ? new Date(active.expected_completion_date).toLocaleDateString()
            : 'Evaluating...';
          responseText = `The AI forecasted completion date for your **${active.type}** (${active.reference_number}) is **${estDate}**.\n\n` +
                         `Please note that this is a dynamic prediction that updates based on department queue sizes and officer availability.`;
        }
      }
    }
    
    else {
      // Default general response
      responseText = `Hello! I am GovFlow's AI Citizen Assistant. How can I support you today?\n\n` +
                     `You can ask me questions like:\n` +
                     `• *Where is my file?* (Check status)\n` +
                     `• *What documents are required for Business License?*\n` +
                     `• *Why is my request delayed?*\n` +
                     `• *When will my application complete?*`;
    }

    res.json({ reply: responseText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error in chatbot query.' });
  }
});

module.exports = router;
