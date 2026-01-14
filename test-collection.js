// test-collection.js - Test the State Aggregator API
// Usage: npm test

const API_URL = process.env.API_URL || 'http://localhost:3001';

async function testCollection() {
  console.log('===========================================');
  console.log('State Aggregator - Testing Collection');
  console.log('===========================================\n');
  
  // Test with real MA bills
  const testBills = ['H1', 'S1']; // Session laws, should always exist
  
  try {
    console.log(`API URL: ${API_URL}`);
    console.log(`Testing bills: ${testBills.join(', ')}\n`);
    console.log('Sending request...\n');
    
    const startTime = Date.now();
    
    const response = await fetch(`${API_URL}/api/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        billNumbers: testBills,
      }),
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }
    
    const results = await response.json();
    
    console.log('===========================================');
    console.log('COLLECTION RESULTS');
    console.log('===========================================\n');
    console.log(`Success: ${results.success ? '✓' : '✗'}`);
    console.log(`Duration: ${duration}s`);
    console.log(`Bills Processed: ${results.billsProcessed}`);
    console.log(`Items Identified: ${results.itemsIdentified}`);
    console.log(`Briefs Created: ${results.briefsCreated}`);
    console.log(`Errors: ${results.errors.length}\n`);
    
    if (results.errors.length > 0) {
      console.log('===========================================');
      console.log('ERRORS');
      console.log('===========================================\n');
      results.errors.forEach((err, idx) => {
        console.log(`${idx + 1}. ${err.message}`);
        if (err.data) {
          console.log(`   ${JSON.stringify(err.data)}`);
        }
      });
      console.log();
    }
    
    if (results.briefs.length > 0) {
      console.log('===========================================');
      console.log('BRIEFS CREATED');
      console.log('===========================================\n');
      results.briefs.forEach((brief, idx) => {
        console.log(`${idx + 1}. ${brief.item.title}`);
        console.log(`   Bill: ${brief.item.bill.bill_number}`);
        console.log(`   Action: ${brief.analysis.what_to_do.toUpperCase()}`);
        console.log(`   Urgency: ${brief.analysis.urgency.toUpperCase()}`);
        console.log(`   Roles: ${brief.analysis.who_should_care.join(', ')}`);
        console.log(`   Summary: ${brief.analysis.summary.substring(0, 100)}...`);
        console.log();
      });
    }
    
    console.log('===========================================');
    console.log('RECENT LOGS');
    console.log('===========================================\n');
    results.logs.slice(-8).forEach(log => {
      const icon = log.level === 'error' ? '✗' : log.level === 'info' ? 'ℹ' : '·';
      console.log(`${icon} [${log.level.toUpperCase()}] ${log.message}`);
      if (log.data) {
        console.log(`  ${JSON.stringify(log.data)}`);
      }
    });
    console.log();
    
    console.log('===========================================');
    console.log('TEST COMPLETE');
    console.log('===========================================\n');
    
    if (results.success) {
      console.log('✓ All tests passed!\n');
      process.exit(0);
    } else {
      console.log('⚠ Some operations failed. Check errors above.\n');
      process.exit(1);
    }
    
  } catch (error) {
    console.log('===========================================');
    console.log('TEST FAILED');
    console.log('===========================================\n');
    console.error('Error:', error.message);
    console.log();
    console.log('Troubleshooting:');
    console.log('1. Make sure the server is running (npm start)');
    console.log('2. Check that API_URL is correct');
    console.log('3. Verify your ANTHROPIC_API_KEY is set');
    console.log('4. Check server logs for details\n');
    process.exit(1);
  }
}

// Run test
testCollection();
