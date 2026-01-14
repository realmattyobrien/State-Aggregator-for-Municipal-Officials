import pg from 'pg';

const { Client } = pg;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const schema = `
-- Bills table
CREATE TABLE IF NOT EXISTS bills (
    id SERIAL PRIMARY KEY,
    bill_number VARCHAR(20) UNIQUE NOT NULL,
    session VARCHAR(20) NOT NULL,
    title TEXT,
    url TEXT,
    current_status TEXT,
    last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bill history table
CREATE TABLE IF NOT EXISTS bill_history (
    id SERIAL PRIMARY KEY,
    bill_id INTEGER REFERENCES bills(id) ON DELETE CASCADE,
    action_date VARCHAR(50),
    branch VARCHAR(50),
    action_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bill_id, action_date, action_text)
);

-- Briefs table
CREATE TABLE IF NOT EXISTS briefs (
    id SERIAL PRIMARY KEY,
    brief_id UUID UNIQUE NOT NULL,
    bill_id INTEGER REFERENCES bills(id) ON DELETE CASCADE,
    summary TEXT,
    why_it_matters TEXT,
    who_should_care JSONB,
    what_to_do VARCHAR(50),
    recommended_next_steps JSONB,
    urgency VARCHAR(20),
    action_types JSONB,
    confidence VARCHAR(20),
    model_notes TEXT,
    bill_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Scraper runs table
CREATE TABLE IF NOT EXISTS scraper_runs (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    bills_checked INTEGER DEFAULT 0,
    bills_updated INTEGER DEFAULT 0,
    briefs_created INTEGER DEFAULT 0,
    errors JSONB,
    status VARCHAR(50)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bills_number ON bills(bill_number);
CREATE INDEX IF NOT EXISTS idx_bills_last_checked ON bills(last_checked);
CREATE INDEX IF NOT EXISTS idx_bill_history_bill_id ON bill_history(bill_id);
CREATE INDEX IF NOT EXISTS idx_briefs_bill_id ON briefs(bill_id);
CREATE INDEX IF NOT EXISTS idx_briefs_created ON briefs(created_at);
`;

async function setupDatabase() {
  try {
    await client.connect();
    console.log('Connected to database');
    
    await client.query(schema);
    console.log('Tables created successfully!');
    
    await client.end();
    process.exit(0);
  } catch (error) {
    console.error('Error setting up database:', error);
    process.exit(1);
  }
}

setupDatabase();
