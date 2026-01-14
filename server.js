// server.js - State Aggregator for Municipal Officials
// Backend server for collecting and analyzing MA government data

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Environment validation
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable not set');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable not set');
  process.exit(1);
}

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully at:', res.rows[0].now);
  }
});

// Logger
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };
  if (data) logEntry.data = data;
  console.log(JSON.stringify(logEntry));
  return logEntry;
}

// Calculate SHA-256 hash
function calculateHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Fetch MA Legislature bill page
async function fetchBillPage(billNumber) {
  const session = '194'; // 2025-2026 session (current)
  const url = `https://malegislature.gov/Bills/${session}/${billNumber}`;
  
  log('info', `Fetching bill page: ${billNumber}`, { url });
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const html = await response.text();
    return { html, url };
  } catch (error) {
    log('error', `Failed to fetch bill page: ${billNumber}`, { error: error.message });
    throw error;
  }
}

// Fetch bill text from PDF
async function fetchBillText(billNumber, session) {
  const pdfUrl = `https://malegislature.gov/Bills/${session}/${billNumber}.pdf`;
  
  log('info', `Fetching bill PDF: ${billNumber}`, { pdfUrl });
  
  try {
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      log('warn', `Could not fetch bill PDF for ${billNumber}`, { status: response.status });
      return null;
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    log('info', `Downloaded PDF for ${billNumber}`, { size: buffer.length });
    
    const data = await pdf(buffer);
    
    if (data && data.text) {
      let text = data.text;
      text = text.replace(/\s+/g, ' ').trim();
      text = text.replace(/The Commonwealth of Massachusetts/gi, '');
      text = text.replace(/HOUSE OF REPRESENTATIVES|SENATE/gi, '');
      text = text.replace(/Page \d+ of \d+/gi, '');
      
      log('info', `Extracted text from PDF for ${billNumber}`, { 
        textLength: text.length,
        pages: data.numpages 
      });
      
      return text.substring(0, 30000);
    }
    
    log('warn', `No text extracted from PDF for ${billNumber}`);
    return null;
    
  } catch (error) {
    log('error', `Failed to fetch/parse bill PDF: ${billNumber}`, { error: error.message });
    return null;
  }
}

// Parse bill page HTML to extract bill history
function parseBillPage(html, url) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  
  let title = 'Unknown Title';
  const h2 = document.querySelector('h2');
  if (h2 && h2.textContent.trim()) {
    title = h2.textContent.trim();
  }
  
  let billNumber = null;
  const h1 = document.querySelector('h1');
  if (h1) {
    const match = h1.textContent.match(/Bill\s+(H|S)\.(\d+)/);
    if (match) {
      billNumber = match[1] + '.' + match[2];
    }
  }
  
  if (!billNumber) {
    log('error', 'Could not extract bill number', { url, title });
    throw new Error('Could not extract bill number from page');
  }
  
  log('info', `Extracted bill number: ${billNumber}`);
  
  let currentStatus = 'Status unknown';
  const pinslip = document.querySelector('.pinslip');
  if (pinslip && pinslip.textContent.trim()) {
    currentStatus = pinslip.textContent.trim();
  }
  
  const historyRows = [];
  const table = document.querySelector('table.table-dark');
  
  if (table) {
    const tbody = table.querySelector('tbody');
    if (tbody) {
      const rows = tbody.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          const date = cells[0].textContent.trim();
          const branch = cells[1].textContent.trim();
          const action = cells[2].textContent.trim();
          
          if (date && action) {
            historyRows.push({ date, branch, action });
          }
        }
      });
    }
  }
  
  log('info', `Parsed bill page: ${billNumber}`, { 
    title, 
    historyRowCount: historyRows.length 
  });
  
  return {
    billNumber,
    title,
    currentStatus,
    historyRows,
    url,
  };
}

// Store or update bill in database
async function storeBill(billData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Insert or update bill
    const billResult = await client.query(
      `INSERT INTO bills (bill_number, session, title, url, current_status, last_checked, last_updated)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (bill_number) 
       DO UPDATE SET 
         title = EXCLUDED.title,
         url = EXCLUDED.url,
         current_status = EXCLUDED.current_status,
         last_checked = NOW(),
         last_updated = NOW()
       RETURNING id`,
      [billData.billNumber, '2025-2026', billData.title, billData.url, billData.currentStatus]
    );
    
    const billId = billResult.rows[0].id;
    
    // Store history
    for (const row of billData.historyRows) {
      await client.query(
        `INSERT INTO bill_history (bill_id, action_date, branch, action_text)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bill_id, action_date, action_text) DO NOTHING`,
        [billId, row.date, row.branch, row.action]
      );
    }
    
    await client.query('COMMIT');
    log('info', `Stored bill in database: ${billData.billNumber}`);
    return billId;
    
  } catch (error) {
    await client.query('ROLLBACK');
    log('error', `Failed to store bill: ${billData.billNumber}`, { error: error.message });
    throw error;
  } finally {
    client.release();
  }
}

// Analyze bill with all its history
async function analyzeBill(billData, billText) {
  log('info', `Analyzing bill: ${billData.billNumber}`);
  
  const historyText = billData.historyRows.map(row => 
    `${row.date} - ${row.branch} - ${row.action}`
  ).join('\n');
  
  const prompt = `You are a municipal policy analyst for Massachusetts local government. Your role is to interpret state legislation for municipal officials, focusing exclusively on operational implications.

BILL INFORMATION:
Title: ${billData.title}
Bill Number: ${billData.billNumber}
Current Status: ${billData.currentStatus}
Source: ${billData.url}

FULL BILL TEXT:
${billText || billData.currentStatus}

COMPLETE BILL HISTORY:
${historyText}

ANALYSIS INSTRUCTIONS:
Analyze this bill comprehensively as a municipal operations analyst would. Read the full bill text and legislative history carefully and focus on:
1. What this bill specifically does (cite actual provisions and sections)
2. The bill's current stage in the legislative process based on its complete history
3. Concrete operational implications for municipal government
4. Which municipal roles need to know about this
5. What preparatory actions are warranted given the bill's current stage

CRITICAL REQUIREMENTS:
- Use neutral, professional language suitable for municipal administrators
- Cite specific provisions and sections from the bill text when explaining what it does
- Be concrete about operational impacts based on actual bill language
- Avoid political framing or policy commentary
- Assess urgency based on where the bill is in the legislative process (early stage = monitor, advancing = prepare, enacted = act)
- Be explicit about uncertainties (e.g., effective dates, implementation details)
- Reference the bill's legislative history to show progression

Respond with ONLY valid JSON (no markdown, no preamble):

{
  "summary": "2-3 sentence factual summary of what this bill specifically does based on the full text, citing key provisions, and where it currently stands in the legislative process based on its history",
  
  "why_it_matters": "1-2 paragraphs explaining concrete operational implications based on specific bill provisions. Reference actual sections or requirements from the bill text. Focus on what municipal officials need to prepare for given the bill's current stage.",
  
  "who_should_care": ["Array of 1-4 relevant municipal roles from: Town Administrator/Manager, Municipal Clerk, Election Administrator, Treasurer/Collector, Finance Director, Town Counsel, DPW Director, Chief Procurement Officer, School Business Manager, Board of Health Director, Police Chief, Planning Director"],
  
  "what_to_do": "One of: monitor (track legislative progress - early stage), prepare (bill is advancing through legislature - review full text and start planning), act (bill enacted or imminent - immediate compliance and implementation needed)",
  
  "recommended_next_steps": ["Array of 1-3 specific, actionable steps based on what the bill actually requires and its current legislative stage. For early stage: monitoring steps. For advancing: preparation and review steps. For enacted: specific compliance and implementation actions."],
  
  "urgency": "One of: low (early stage or unlikely to affect operations), medium (advancing through legislature and likely to affect operations), high (enacted, passed final stage, or imminent passage with significant impact)",
  
  "action_types": ["Array of 1-3 categories from: training, forms, procedure, budget, staffing, policy_update, legal_review, technology, communications"],
  
  "confidence": "One of: low (bill text unclear or incomplete), medium (can infer likely impact from provisions), high (clear requirements and implications)",
  
  "model_notes": "Note any limitations of this analysis - missing effective dates, unclear implementation details, need for legal review, incomplete bill text, etc.",
  
  "citations": [
    {
      "label": "Most recent legislative action",
      "supporting_text": "${billData.historyRows[0]?.action.substring(0, 50) || 'N/A'}",
      "location": "Bill history, ${billData.historyRows[0]?.date || 'N/A'}"
    }
  ]
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: prompt,
      }],
    });
    
    const responseText = message.content.find(block => block.type === 'text')?.text || '';
    const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
    const analysis = JSON.parse(cleanJson);
    
    log('info', `Analysis complete: ${billData.billNumber}`);
    
    return analysis;
    
  } catch (error) {
    log('error', `Analysis failed: ${billData.billNumber}`, { error: error.message });
    throw error;
  }
}

// Store brief in database
async function storeBrief(billId, billText, analysis) {
  try {
    const briefId = crypto.randomUUID();
    
    await pool.query(
      `INSERT INTO briefs (
        brief_id, bill_id, summary, why_it_matters, who_should_care,
        what_to_do, recommended_next_steps, urgency, action_types,
        confidence, model_notes, bill_text
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        briefId,
        billId,
        analysis.summary,
        analysis.why_it_matters,
        JSON.stringify(analysis.who_should_care),
        analysis.what_to_do,
        JSON.stringify(analysis.recommended_next_steps),
        analysis.urgency,
        JSON.stringify(analysis.action_types),
        analysis.confidence,
        analysis.model_notes,
        billText
      ]
    );
    
    log('info', `Brief stored in database: ${briefId}`);
    return briefId;
    
  } catch (error) {
    log('error', `Failed to store brief`, { error: error.message });
    throw error;
  }
}

// Create brief response object
function createBriefResponse(bill, history, brief) {
  return {
    schema_version: 'v1',
    brief_id: brief.brief_id,
    created_at: brief.created_at,
    item: {
      source: {
        name: 'Massachusetts Legislature',
        jurisdiction: 'MA',
        source_weight: 'binding',
      },
      item_type: 'bill',
      title: bill.title,
      url: bill.url,
      published_at: history[0]?.action_date || new Date().toISOString(),
      bill: {
        bill_number: bill.bill_number,
        session: bill.session,
        current_status: bill.current_status,
      },
      raw_text: brief.bill_text,
      raw_text_sha256: calculateHash(brief.bill_text || ''),
      history: history.map(h => ({
        date: h.action_date,
        branch: h.branch,
        action: h.action_text
      })),
    },
    analysis: {
      summary: brief.summary,
      why_it_matters: brief.why_it_matters,
      who_should_care: brief.who_should_care,
      what_to_do: brief.what_to_do,
      recommended_next_steps: brief.recommended_next_steps,
      urgency: brief.urgency,
      action_types: brief.action_types,
      confidence: brief.confidence,
      model_notes: brief.model_notes,
      citations: [],
    },
  };
}

// Main collection endpoint
app.post('/api/collect', async (req, res) => {
  const { billNumbers } = req.body;
  
  if (!billNumbers || !Array.isArray(billNumbers) || billNumbers.length === 0) {
    return res.status(400).json({
      error: 'Missing or invalid billNumbers array',
    });
  }
  
  log('info', 'Collection started', { billCount: billNumbers.length });
  
  const results = {
    success: true,
    billsProcessed: 0,
    briefsCreated: 0,
    errors: [],
    briefs: [],
    logs: [],
  };
  
  for (const billNumber of billNumbers) {
    try {
      const { html, url } = await fetchBillPage(billNumber);
      results.logs.push(log('info', `Fetched: ${billNumber}`));
      
      const billText = await fetchBillText(billNumber, '194');
      results.logs.push(log('info', `Fetched bill text: ${billNumber}`, { 
        hasText: !!billText,
        textLength: billText ? billText.length : 0
      }));
      
      const billData = parseBillPage(html, url);
      results.logs.push(log('info', `Parsed: ${billNumber}`, { 
        actionCount: billData.historyRows.length 
      }));
      
      const billId = await storeBill(billData);
      
      const analysis = await analyzeBill(billData, billText);
      await storeBrief(billId, billText, analysis);
      
      // Fetch stored data to return
      const billResult = await pool.query('SELECT * FROM bills WHERE id = $1', [billId]);
      const historyResult = await pool.query(
        'SELECT * FROM bill_history WHERE bill_id = $1 ORDER BY action_date DESC',
        [billId]
      );
      const briefResult = await pool.query(
        'SELECT * FROM briefs WHERE bill_id = $1 ORDER BY created_at DESC LIMIT 1',
        [billId]
      );
      
      const brief = createBriefResponse(
        billResult.rows[0],
        historyResult.rows,
        briefResult.rows[0]
      );
      
      results.briefs.push(brief);
      results.briefsCreated++;
      results.logs.push(log('info', `Brief created for ${billNumber}`));
      
      results.billsProcessed++;
      
    } catch (error) {
      const errorLog = log('error', `Failed to process bill: ${billNumber}`, { 
        error: error.message 
      });
      results.errors.push(errorLog);
      results.logs.push(errorLog);
    }
  }
  
  results.success = results.errors.length === 0;
  
  log('info', 'Collection completed', {
    billsProcessed: results.billsProcessed,
    briefsCreated: results.briefsCreated,
    errorCount: results.errors.length,
  });
  
  res.json(results);
});

// Get all briefs
app.get('/api/briefs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, bills.bill_number, bills.title, bills.url, bills.current_status, bills.session
      FROM briefs b
      JOIN bills ON b.bill_id = bills.id
      ORDER BY b.created_at DESC
    `);
    
    const briefs = await Promise.all(result.rows.map(async (brief) => {
      const historyResult = await pool.query(
        'SELECT * FROM bill_history WHERE bill_id = $1 ORDER BY action_date DESC',
        [brief.bill_id]
      );
      
      return createBriefResponse(
        {
          bill_number: brief.bill_number,
          title: brief.title,
          url: brief.url,
          current_status: brief.current_status,
          session: brief.session
        },
        historyResult.rows,
        brief
      );
    }));
    
    res.json({ briefs });
  } catch (error) {
    log('error', 'Failed to fetch briefs', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch briefs' });
  }
});

// Get single brief
app.get('/api/briefs/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, bills.bill_number, bills.title, bills.url, bills.current_status, bills.session
       FROM briefs b
       JOIN bills ON b.bill_id = bills.id
       WHERE b.brief_id = $1`,
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Brief not found' });
    }
    
    const brief = result.rows[0];
    const historyResult = await pool.query(
      'SELECT * FROM bill_history WHERE bill_id = $1 ORDER BY action_date DESC',
      [brief.bill_id]
    );
    
    const briefResponse = createBriefResponse(
      {
        bill_number: brief.bill_number,
        title: brief.title,
        url: brief.url,
        current_status: brief.current_status,
        session: brief.session
      },
      historyResult.rows,
      brief
    );
    
    res.json(briefResponse);
  } catch (error) {
    log('error', 'Failed to fetch brief', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch brief' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM bills');
    const billCount = parseInt(result.rows[0].count);
    
    res.json({ 
      status: 'ok',
      timestamp: new Date().toISOString(),
      billCount: billCount,
      database: 'connected'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// Serve HTML file at root
app.get('/', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'app.html'), 'utf8');
    res.send(html);
  } catch (error) {
    res.json({
      name: 'State Aggregator for Municipal Officials',
      version: '1.0.0',
      status: 'running',
      endpoints: {
        health: '/health',
        collect: 'POST /api/collect',
        briefs: '/api/briefs',
        brief: '/api/briefs/:id',
      },
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  log('info', `State Aggregator API started on port ${PORT}`);
  console.log(`\n===========================================`);
  console.log(`State Aggregator for Municipal Officials`);
  console.log(`Running on: http://localhost:${PORT}`);
  console.log(`===========================================\n`);
});
