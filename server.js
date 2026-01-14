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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Environment validation
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable not set');
  process.exit(1);
}

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

// In-memory storage (replace with database in production)
const storage = {
  briefs: new Map(),
  seenItems: new Map(), // key: item_id, value: { sha256, last_seen }
};

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
    
    // Get PDF as buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    log('info', `Downloaded PDF for ${billNumber}`, { size: buffer.length });
    
    // Parse PDF
    const data = await pdf(buffer);
    
    if (data && data.text) {
      let text = data.text;
      
      // Clean up the text
      text = text.replace(/\s+/g, ' ').trim();
      
      // Remove common headers/footers
      text = text.replace(/The Commonwealth of Massachusetts/gi, '');
      text = text.replace(/HOUSE OF REPRESENTATIVES|SENATE/gi, '');
      text = text.replace(/Page \d+ of \d+/gi, '');
      
      log('info', `Extracted text from PDF for ${billNumber}`, { 
        textLength: text.length,
        pages: data.numpages 
      });
      
      // Limit to 30000 chars (~20-30 pages) to stay within token limits
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
  
  // Extract bill title from h2
  let title = 'Unknown Title';
  const h2 = document.querySelector('h2');
  if (h2 && h2.textContent.trim()) {
    title = h2.textContent.trim();
  }
  
  // Extract bill number from h1
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
  
  // Extract current status from pinslip (petition description)
  let currentStatus = 'Status unknown';
  const pinslip = document.querySelector('.pinslip');
  if (pinslip && pinslip.textContent.trim()) {
    currentStatus = pinslip.textContent.trim();
  }
  
  // Extract bill history from table
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

// Analyze bill with all its history
async function analyzeBill(billData, billText) {
  log('info', `Analyzing bill: ${billData.billNumber}`);
  
  // Format history for the prompt
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

// Create impact brief from bill data and analysis
function createBrief(billData, billText, analysis) {
  const brief = {
    schema_version: 'v1',
    brief_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    item: {
      source: {
        name: 'Massachusetts Legislature',
        jurisdiction: 'MA',
        source_weight: 'binding',
      },
      item_type: 'bill',
      title: billData.title,
      url: billData.url,
      published_at: billData.historyRows[0]?.date || new Date().toISOString(),
      bill: {
        bill_number: billData.billNumber,
        session: '2025-2026',
        current_status: billData.currentStatus,
      },
      raw_text: billText || billData.currentStatus,
      raw_text_sha256: calculateHash(billText || billData.currentStatus),
      history: billData.historyRows,
    },
    analysis: {
      summary: analysis.summary,
      why_it_matters: analysis.why_it_matters,
      who_should_care: analysis.who_should_care,
      what_to_do: analysis.what_to_do,
      recommended_next_steps: analysis.recommended_next_steps || [],
      urgency: analysis.urgency,
      action_types: analysis.action_types,
      confidence: analysis.confidence,
      model_notes: analysis.model_notes || '',
      citations: analysis.citations || [],
    },
  };
  
  storage.briefs.set(brief.brief_id, brief);
  log('info', `Brief created: ${brief.brief_id}`);
  
  return brief;
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
  
  // Process each bill
  for (const billNumber of billNumbers) {
    try {
      // Fetch bill page
      const { html, url } = await fetchBillPage(billNumber);
      results.logs.push(log('info', `Fetched: ${billNumber}`));
      
      // Fetch bill text from PDF
      const billText = await fetchBillText(billNumber, '194');
      results.logs.push(log('info', `Fetched bill text: ${billNumber}`, { 
        hasText: !!billText,
        textLength: billText ? billText.length : 0
      }));
      
      // Parse bill data
      const billData = parseBillPage(html, url);
      results.logs.push(log('info', `Parsed: ${billNumber}`, { 
        actionCount: billData.historyRows.length 
      }));
      
      // Analyze the entire bill with all its history
      const analysis = await analyzeBill(billData, billText);
      const brief = createBrief(billData, billText, analysis);
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
app.get('/api/briefs', (req, res) => {
  const briefs = Array.from(storage.briefs.values()).sort((a, b) => 
    new Date(b.created_at) - new Date(a.created_at)
  );
  res.json({ briefs });
});

// Get single brief
app.get('/api/briefs/:id', (req, res) => {
  const brief = storage.briefs.get(req.params.id);
  if (!brief) {
    return res.status(404).json({ error: 'Brief not found' });
  }
  res.json(brief);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    briefCount: storage.briefs.size,
  });
});

// Serve HTML file at root
app.get('/', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
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
