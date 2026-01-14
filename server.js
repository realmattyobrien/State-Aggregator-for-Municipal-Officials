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

// Trigger words that indicate significant bill actions worth analyzing
const BILL_ACTION_TRIGGERS = [
  'referred to',
  'committee recommends',
  'reported favorably',
  'public hearing',
  'passed to be engrossed',
  'enacted',
  'emergency preamble adopted',
  'returned',
  'governor signed',
];

// Logger
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };
  if (data) logEntry.data = data;
  console.log(JSON.stringify(logEntry));
  return logEntry;
}

// Check if action text matches trigger words
function shouldAnalyzeAction(actionText) {
  const lowerAction = actionText.toLowerCase();
  return BILL_ACTION_TRIGGERS.some(trigger => lowerAction.includes(trigger));
}

// Generate stable item ID
function generateItemId(billNumber, actionDate, actionText) {
  const normalized = `${billNumber}:${actionDate}:${actionText}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
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

// Fetch bill text
async function fetchBillText(billNumber, session) {
  const textUrl = `https://malegislature.gov/Bills/${session}/${billNumber}`;
  
  log('info', `Fetching bill text: ${billNumber}`, { textUrl });
  
  try {
    const response = await fetch(textUrl);
    if (!response.ok) {
      log('warn', `Could not fetch bill page for ${billNumber}`);
      return null;
    }
    const html = await response.text();
    
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Try to get bill text from pinslip (the petition description)
    const pinslip = document.querySelector('.pinslip');
    if (pinslip && pinslip.textContent.trim()) {
      let text = pinslip.textContent.trim();
      
      // If it's substantial, use it
      if (text.length > 100) {
        log('info', `Using pinslip text for ${billNumber}`, { length: text.length });
        return text;
      }
    }
    
    // Try to find the actual bill document link
    const billTextLink = document.querySelector('a[href*="/Bill/Text"]');
    if (billTextLink) {
      const billTextHref = billTextLink.getAttribute('href');
      const fullUrl = `https://malegislature.gov${billTextHref}`;
      
      log('info', `Found bill text link: ${fullUrl}`);
      
      const textResponse = await fetch(fullUrl);
      if (textResponse.ok) {
        const textHtml = await textResponse.text();
        const textDom = new JSDOM(textHtml);
        const textDoc = textDom.window.document;
        
        // Get all text content from the modal body
        const modalBody = textDoc.querySelector('.modal-body');
        if (modalBody) {
          let billText = modalBody.textContent;
          billText = billText.replace(/\s+/g, ' ').trim();
          // Remove common navigation/UI text
          billText = billText.replace(/Close\s+Print\s+Preview/gi, '');
          billText = billText.replace(/The\s+Commonwealth\s+of\s+Massachusetts/gi, '');
          
          if (billText.length > 200) {
            log('info', `Extracted bill text from document`, { length: billText.length });
            // Limit to 5000 chars to stay within token limits
            return billText.substring(0, 5000);
          }
        }
      }
    }
    
    log('warn', `Could not extract meaningful bill text for ${billNumber}`);
    return null;
    
  } catch (error) {
    log('error', `Failed to fetch bill text: ${billNumber}`, { error: error.message });
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

// Process bill history and identify new items
function processBillHistory(billData) {
  const newItems = [];
  
  for (const historyRow of billData.historyRows) {
    const itemId = generateItemId(billData.billNumber, historyRow.date, historyRow.action);
    const contentHash = calculateHash(historyRow.action);
    
    // Check if we've seen this exact item before
    const seenItem = storage.seenItems.get(itemId);
    
    if (seenItem && seenItem.sha256 === contentHash) {
      // Already processed this exact action
      continue;
    }
    
    // Check if this action should be analyzed
    if (!shouldAnalyzeAction(historyRow.action)) {
      log('debug', `Skipping non-trigger action: ${itemId}`, { action: historyRow.action });
      continue;
    }
    
    // This is a new or updated action that should be analyzed
    const item = {
      item_id: itemId,
      source: {
        name: 'Massachusetts Legislature',
        jurisdiction: 'MA',
        source_weight: 'binding',
      },
      item_type: 'bill',
      title: billData.title,
      url: billData.url,
      published_at: historyRow.date,
      bill: {
        bill_number: billData.billNumber,
        session: '2025-2026',
        current_status: billData.currentStatus,
      },
      raw_text: billData.billText || `Bill: ${billData.title}\nBill Number: ${billData.billNumber}\nDate: ${historyRow.date}\nBranch: ${historyRow.branch}\nAction: ${historyRow.action}\nCurrent Status: ${billData.currentStatus}`,
      raw_text_sha256: contentHash,
      action_text: historyRow.action,
      action_date: historyRow.date,
      action_branch: historyRow.branch,
    };
    
    newItems.push(item);
    
    // Mark as seen
    storage.seenItems.set(itemId, {
      sha256: contentHash,
      last_seen: new Date().toISOString(),
    });
    
    log('info', `New item identified: ${itemId}`, { 
      billNumber: billData.billNumber,
      action: historyRow.action.substring(0, 50) + '...',
    });
  }
  
  return newItems;
}

// Analyze item with Anthropic API
async function analyzeItem(item) {
  log('info', `Analyzing item: ${item.item_id}`);
  
  const prompt = `You are a municipal policy analyst for Massachusetts local government. Your role is to interpret state legislation for municipal officials, focusing exclusively on operational implications.

BILL INFORMATION:
Title: ${item.title}
Bill Number: ${item.bill.bill_number}
Recent Action (${item.action_date}): ${item.action_text}
Current Status: ${item.bill.current_status}
Source: ${item.url}

FULL BILL TEXT:
${item.raw_text}

CONTEXT:
This is a legislative action record. The action "${item.action_text}" has occurred on ${item.action_date}.

ANALYSIS INSTRUCTIONS:
Analyze this bill as a municipal operations analyst would. Read the full bill text carefully and focus on:
1. What this bill specifically does (cite actual provisions)
2. What this recent legislative action means for the bill's progress
3. Concrete operational implications for municipal government
4. Which municipal roles need to know about this
5. What preparatory actions are warranted at this stage

CRITICAL REQUIREMENTS:
- Use neutral, professional language suitable for municipal administrators
- Cite specific provisions and sections from the bill text when explaining what it does
- Be concrete about operational impacts based on actual bill language
- Avoid political framing or policy commentary
- If this is an early-stage action (e.g., committee referral), indicate monitoring is appropriate
- If this is a late-stage action (e.g., enacted), indicate immediate review and compliance actions
- Be explicit about uncertainties (e.g., effective dates, implementation details)

Respond with ONLY valid JSON (no markdown, no preamble):

{
  "summary": "2-3 sentence factual summary of what this bill specifically does based on the full text provided, citing key provisions, and what this legislative action means for the bill's progress",
  
  "why_it_matters": "1-2 paragraphs explaining concrete operational implications based on specific bill provisions. Reference actual sections or requirements from the bill text. Focus on what municipal officials need to prepare for.",
  
  "who_should_care": ["Array of 1-4 relevant municipal roles from: Town Administrator/Manager, Municipal Clerk, Election Administrator, Treasurer/Collector, Finance Director, Town Counsel, DPW Director, Chief Procurement Officer, School Business Manager, Board of Health Director, Police Chief, Planning Director"],
  
  "what_to_do": "One of: monitor (track legislative progress), prepare (bill is advancing, review full text), act (bill enacted, immediate compliance needed)",
  
  "recommended_next_steps": ["Array of 1-3 specific, actionable steps based on what the bill actually requires. For early stage: monitoring and preparation steps. For late stage: specific compliance and implementation actions."],
  
  "urgency": "One of: low (early stage or unlikely to affect operations), medium (advancing and may affect operations), high (enacted or imminent passage with significant impact)",
  
  "action_types": ["Array of 1-3 categories from: training, forms, procedure, budget, staffing, policy_update, legal_review, technology, communications"],
  
  "confidence": "One of: low (bill text unclear or incomplete), medium (can infer likely impact from provisions), high (clear requirements and implications)",
  
  "model_notes": "Note any limitations of this analysis - missing effective dates, unclear implementation details, need for legal review, etc.",
  
  "citations": [
    {
      "label": "Legislative action",
      "supporting_text": "${item.action_text.substring(0, 50)}",
      "location": "Bill history, ${item.action_date}"
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
    
    log('info', `Analysis complete: ${item.item_id}`);
    
    return analysis;
    
  } catch (error) {
    log('error', `Analysis failed: ${item.item_id}`, { error: error.message });
    throw error;
  }
}

// Create impact brief from item and analysis
function createBrief(item, analysis) {
  const brief = {
    schema_version: 'v1',
    brief_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    item: {
      item_id: item.item_id,
      source: item.source,
      item_type: item.item_type,
      title: item.title,
      url: item.url,
      published_at: item.published_at,
      bill: item.bill,
      raw_text: item.raw_text,
      raw_text_sha256: item.raw_text_sha256,
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
    itemsIdentified: 0,
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
      
      // Fetch bill text
      const billText = await fetchBillText(billNumber, '194');
      results.logs.push(log('info', `Fetched bill text: ${billNumber}`, { 
        hasText: !!billText,
        textLength: billText ? billText.length : 0
      }));
      
      // Parse bill data
      const billData = parseBillPage(html, url);
      billData.billText = billText;
      results.logs.push(log('info', `Parsed: ${billNumber}`, { 
        actionCount: billData.historyRows.length 
      }));
      
      // Process history to find new items
      const newItems = processBillHistory(billData);
      results.itemsIdentified += newItems.length;
      results.logs.push(log('info', `New items: ${newItems.length} for ${billNumber}`));
      
      // Analyze each new item
      for (const item of newItems) {
        try {
          const analysis = await analyzeItem(item);
          const brief = createBrief(item, analysis);
          results.briefs.push(brief);
          results.briefsCreated++;
          results.logs.push(log('info', `Brief created for ${item.item_id}`));
        } catch (error) {
          const errorLog = log('error', `Failed to analyze item: ${item.item_id}`, { 
            error: error.message 
          });
          results.errors.push(errorLog);
          results.logs.push(errorLog);
        }
      }
      
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
    itemsIdentified: results.itemsIdentified,
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
    seenItemCount: storage.seenItems.size,
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
