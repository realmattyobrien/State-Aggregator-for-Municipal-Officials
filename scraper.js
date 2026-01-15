// scraper.js - Smart daily bill scraper with municipal relevance filtering

import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { JSDOM } from 'jsdom';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import crypto from 'crypto';

const { Pool } = pg;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ANTHROPIC_API_KEY || !DATABASE_URL) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SESSION = '194'; // Current session

// Municipal relevance keywords - Stage 1 filter
const MUNICIPAL_KEYWORDS = [
  // Direct municipal references
  'municipality', 'municipal', 'municipalities',
  'city of', 'town of', 'village',
  'local government', 'local aid', 'unrestricted general government aid', 'ugga',
  'home rule', 'home rule petition',
  'chapter 90',
  'special act',
  
  // Elections & governance
  'election', 'elections', 'voter', 'voters', 'voting',
  'ballot', 'polling', 'poll worker',
  'town meeting', 'city council', 'board of selectmen', 'select board',
  'clerk', 'town clerk', 'city clerk', 'election officer',
  
  // Financial/tax
  'property tax', 'real estate tax', 'personal property tax',
  'tax levy', 'levy limit', 'proposition 2½', 'proposition two and one half',
  'local option tax', 'meals tax', 'room occupancy',
  'treasurer', 'collector', 'assessor',
  'municipal finance', 'municipal budget', 'cherry sheet',
  
  // Land use & development
  'zoning', 'zoning board', 'zoning bylaw',
  'planning board', 'conservation commission',
  'building inspector', 'building code', 'building permit',
  'affordable housing', 'housing production', '40b',
  'wetlands', 'open space',
  
  // Public services
  'police department', 'fire department', 'emergency services',
  'department of public works', 'dpw', 'highway department',
  'school district', 'regional school', 'education',
  'library', 'public library',
  'water', 'sewer', 'wastewater',
  'solid waste', 'recycling', 'trash',
  
  // Procurement & construction
  'procurement', 'public procurement', 'chapter 30b',
  'prevailing wage', 'public construction',
  'design-build', 'construction manager at risk',
  'mcppo',
  
  // Administrative
  'public records', 'open meeting law',
  'ethics', 'conflict of interest',
  'collective bargaining', 'labor relations', 'arbitration',
  'workers compensation', 'unemployment',
  'opeb', 'pension', 'retirement'
];

// Logger
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, data }));
}

// Generate all possible bill numbers
function generateBillNumbers() {
  const bills = [];
  
  // House bills H1 - H5000
  for (let i = 1; i <= 5000; i++) {
    bills.push(`H${i}`);
  }
  
  // Senate bills S1 - S3000
  for (let i = 1; i <= 3000; i++) {
    bills.push(`S${i}`);
  }
  
  log('info', 'Generated bill numbers', { count: bills.length });
  return bills;
}

// Fetch bill page
async function fetchBillPage(billNumber) {
  const url = `https://malegislature.gov/Bills/${SESSION}/${billNumber}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        return null; // Bill doesn't exist
      }
      throw new Error(`HTTP ${response.status}`);
    }
    return { html: await response.text(), url };
  } catch (error) {
    return null;
  }
}

// Parse bill page HTML
function parseBillPage(html, url) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  
  let title = 'Unknown Title';
  const h2 = document.querySelector('h2');
  if (h2) title = h2.textContent.trim();
  
  let billNumber = null;
  const h1 = document.querySelector('h1');
  if (h1) {
    const match = h1.textContent.match(/Bill\s+(H|S)\.(\d+)/);
    if (match) billNumber = match[1] + '.' + match[2];
  }
  
  if (!billNumber) throw new Error('Could not extract bill number');
  
  let currentStatus = 'Status unknown';
  const pinslip = document.querySelector('.pinslip');
  if (pinslip) currentStatus = pinslip.textContent.trim();
  
  const historyRows = [];
  const table = document.querySelector('table.table-dark');
  if (table) {
    const tbody = table.querySelector('tbody');
    if (tbody) {
      tbody.querySelectorAll('tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          historyRows.push({
            date: cells[0].textContent.trim(),
            branch: cells[1].textContent.trim(),
            action: cells[2].textContent.trim()
          });
        }
      });
    }
  }
  
  return { billNumber, title, currentStatus, historyRows, url };
}

// Stage 1: Fast keyword filter
function matchesMunicipalKeywords(text) {
  const lowerText = text.toLowerCase();
  return MUNICIPAL_KEYWORDS.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

// Stage 2: AI relevance check
async function checkRelevanceWithAI(billData) {
  const prompt = `You are screening Massachusetts legislation for municipal government relevance.

BILL: ${billData.billNumber}
TITLE: ${billData.title}
STATUS: ${billData.currentStatus}

Question: Does this bill operationally affect municipal government (cities, towns, local officials, municipal operations, local services)?

Respond with ONLY valid JSON:
{
  "relevant": true or false,
  "confidence": "low", "medium", or "high",
  "reason": "One sentence explaining why it is or isn't relevant"
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const responseText = message.content.find(b => b.type === 'text')?.text || '';
    const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(cleanJson);
    
    return result.relevant && (result.confidence === 'medium' || result.confidence === 'high');
  } catch (error) {
    log('error', 'AI relevance check failed', { error: error.message });
    return true; // If AI fails, err on side of including it
  }
}

// Fetch bill text from PDF
async function fetchBillText(billNumber) {
  const pdfUrl = `https://malegislature.gov/Bills/${SESSION}/${billNumber}.pdf`;
  
  try {
    const response = await fetch(pdfUrl);
    if (!response.ok) return null;
    
    const buffer = Buffer.from(await response.arrayBuffer());
    const data = await pdf(buffer);
    
    if (data && data.text) {
      let text = data.text.replace(/\s+/g, ' ').trim();
      text = text.replace(/The Commonwealth of Massachusetts/gi, '');
      text = text.replace(/HOUSE OF REPRESENTATIVES|SENATE/gi, '');
      return text.substring(0, 30000);
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Check if bill has changes
async function hasChanges(billData) {
  try {
    const result = await pool.query(
      'SELECT id FROM bills WHERE bill_number = $1',
      [billData.billNumber]
    );
    
    if (result.rows.length === 0) {
      return { isNew: true, billId: null };
    }
    
    const billId = result.rows[0].id;
    
    for (const row of billData.historyRows) {
      const historyCheck = await pool.query(
        'SELECT id FROM bill_history WHERE bill_id = $1 AND action_date = $2 AND action_text = $3',
        [billId, row.date, row.action]
      );
      
      if (historyCheck.rows.length === 0) {
        return { isNew: false, hasUpdate: true, billId };
      }
    }
    
    return { isNew: false, hasUpdate: false, billId };
  } catch (error) {
    return { isNew: true, billId: null };
  }
}

// Store bill in database
async function storeBill(billData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
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
    
    for (const row of billData.historyRows) {
      await client.query(
        `INSERT INTO bill_history (bill_id, action_date, branch, action_text)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bill_id, action_date, action_text) DO NOTHING`,
        [billId, row.date, row.branch, row.action]
      );
    }
    
    await client.query('COMMIT');
    return billId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Full bill analysis
async function analyzeBill(billData, billText) {
  const historyText = billData.historyRows.map(r => 
    `${r.date} - ${r.branch} - ${r.action}`
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

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });
  
  const responseText = message.content.find(b => b.type === 'text')?.text || '';
  const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
  return JSON.parse(cleanJson);
}

// Store brief
async function storeBrief(billId, billText, analysis) {
  const briefId = crypto.randomUUID();
  
  await pool.query(
    `INSERT INTO briefs (
      brief_id, bill_id, summary, why_it_matters, who_should_care,
      what_to_do, recommended_next_steps, urgency, action_types,
      confidence, model_notes, bill_text
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      briefId, billId, analysis.summary, analysis.why_it_matters,
      JSON.stringify(analysis.who_should_care), analysis.what_to_do,
      JSON.stringify(analysis.recommended_next_steps), analysis.urgency,
      JSON.stringify(analysis.action_types), analysis.confidence,
      analysis.model_notes, billText
    ]
  );
  
  return briefId;
}

// Main scraper function
async function runScraper() {
  const startTime = Date.now();
  log('info', '🚀 Starting smart municipal bill scraper');
  
  const runResult = await pool.query(
    'INSERT INTO scraper_runs (started_at, status) VALUES (NOW(), $1) RETURNING id',
    ['running']
  );
  const runId = runResult.rows[0].id;
  
  const stats = {
    billsChecked: 0,
    billsFound: 0,
    passedKeywordFilter: 0,
    passedAIFilter: 0,
    billsUpdated: 0,
    briefsCreated: 0,
    errors: []
  };
  
  const billNumbers = generateBillNumbers();
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < billNumbers.length; i += BATCH_SIZE) {
    const batch = billNumbers.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (billNum) => {
      try {
        stats.billsChecked++;
        
        // Fetch bill page
        const pageData = await fetchBillPage(billNum);
        if (!pageData) return; // 404 - bill doesn't exist
        
        stats.billsFound++;
        
        const billData = parseBillPage(pageData.html, pageData.url);
        
        // STAGE 1: Keyword filter
        const textToCheck = `${billData.title} ${billData.currentStatus}`.toLowerCase();
        if (!matchesMunicipalKeywords(textToCheck)) {
          return; // Not municipally relevant based on keywords
        }
        
        stats.passedKeywordFilter++;
        log('info', `✓ Keyword match: ${billNum} - ${billData.title.substring(0, 60)}...`);
        
        // Check if bill has changes
        const changeCheck = await hasChanges(billData);
        if (!changeCheck.isNew && !changeCheck.hasUpdate) {
          return; // No changes, skip
        }
        
        // STAGE 2: AI relevance filter
        const isRelevant = await checkRelevanceWithAI(billData);
        if (!isRelevant) {
          log('info', `✗ AI filtered out: ${billNum}`);
          return;
        }
        
        stats.passedAIFilter++;
        log('info', `✓✓ AI confirmed: ${billNum} - Processing...`);
        
        // STAGE 3: Full analysis
        const billText = await fetchBillText(billNum);
        const billId = await storeBill(billData);
        
        const analysis = await analyzeBill(billData, billText);
        await storeBrief(billId, billText, analysis);
        
        stats.billsUpdated++;
        stats.briefsCreated++;
        
        log('info', `📊 Brief created: ${billNum}`);
        
      } catch (error) {
        stats.errors.push({ bill: billNum, error: error.message });
        log('error', `Failed: ${billNum}`, { error: error.message });
      }
    }));
    
    // Progress update every 100 bills
    if (stats.billsChecked % 100 === 0) {
      log('info', `Progress: ${stats.billsChecked}/${billNumbers.length} | Found: ${stats.billsFound} | Keywords: ${stats.passedKeywordFilter} | AI: ${stats.passedAIFilter} | Briefs: ${stats.briefsCreated}`);
    }
    
    // Small delay between batches
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Update scraper run record
  await pool.query(
    `UPDATE scraper_runs 
     SET completed_at = NOW(), 
         bills_checked = $1, 
         bills_updated = $2, 
         briefs_created = $3,
         errors = $4,
         status = $5
     WHERE id = $6`,
    [
      stats.billsChecked,
      stats.billsUpdated,
      stats.briefsCreated,
      JSON.stringify(stats.errors),
      'completed',
      runId
    ]
  );
  
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  
  log('info', '✅ Scraper completed', {
    duration: `${duration} minutes`,
    ...stats
  });
  
  await pool.end();
  process.exit(0);
}

// Run the scraper
runScraper().catch(error => {
  log('error', 'Scraper failed', { error: error.message });
  process.exit(1);
});
