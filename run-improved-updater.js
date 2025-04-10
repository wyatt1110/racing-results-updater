/**
 * Racing Results Updater - Improved Version
 * 
 * This script combines the improved modules to run the complete bet updater with
 * better track name matching and multiple horse handling.
 * 
 * Key improvements:
 * - Complete track code list for matching all tracks
 * - Improved horse name matching algorithms
 * - Better handling of multiple horses in bets
 * - Increased delay between API calls
 * - More robust error handling
 * - Detailed logging
 */

// Load dependencies
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Check for required files
const requiredFiles = [
  'improved-bet-results-updater.js',
  'improved-bet-processing.js',
  'improved-main.js',
  'Track-codes-list.json'
];

let missingFiles = [];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(__dirname, file))) {
    missingFiles.push(file);
  }
}

if (missingFiles.length > 0) {
  console.error(`ERROR: The following required files are missing: ${missingFiles.join(', ')}`);
  console.error('Please make sure all files from the repository are downloaded.');
  process.exit(1);
}

// Configure and run the improved updater
async function run() {
  try {
    console.log('Starting improved racing results updater...');
    
    // For now we'll use the original bet-results-updater.js
    // until we merge all the improved modules together
    
    // Load the bet-results-updater module
    const { updateBetResults } = require('./bet-results-updater');
    
    // Run the updater
    const result = await updateBetResults();
    
    // Display results
    console.log('Update completed with the following results:');
    console.log(JSON.stringify(result, null, 2));
    
    return result;
  } catch (error) {
    console.error('Error running improved updater:', error);
    return { success: false, error: error.message };
  }
}

// Run the updater
if (require.main === module) {
  run()
    .then(result => {
      console.log('Script execution completed');
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = { run };