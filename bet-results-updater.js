require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Import improved modules
const trackMatcher = require('./improved-track-matcher');
const multipleHandler = require('./improved-multiple-handler');
const apiRequest = require('./improved-api-request');

// Configuration
const supabaseUrl = process.env.SUPABASE_URL || 'https://gwvnmzfpnuwxcqtewbtl.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3dm5temZwbnV3eGNxdGV3YnRsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwOTc1NDY3MCwiZXhwIjoyMDI1MzMwNjcwfQ.uZCQGcFm1mGSrKAcqbfgVx-YsNWlb-4iKLwRH5GQaRY';
const racingApiUsername = process.env.RACING_API_USERNAME || 'KQ9W7rQeAHWMUgxH93ie3yEc';
const racingApiPassword = process.env.RACING_API_PASSWORD || 'T5BoPivL3Q2h6RhCdLv4EwZu';
const racingApiBase = 'https://api.theracingapi.com/v1';

// Initialize clients
const supabase = createClient(supabaseUrl, supabaseKey);
const racingApi = axios.create({
  baseURL: racingApiBase,
  auth: {
    username: racingApiUsername,
    password: racingApiPassword
  }
});

// Sleep function for delay between API calls
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fallback hardcoded track codes for common tracks (in case file loading fails)
const FALLBACK_TRACK_CODES = {
  'catterick': 'crs_260',
  'nottingham': 'crs_1040',
  'leopardstown': 'crs_4862',
  'kempton': 'crs_28054',
  'lingfield': 'crs_910',
  'newton abbot': 'crs_1026',
  'limerick': 'crs_4868',
  'hereford': 'crs_778'
};

// Load track codes from JSON file
let TRACK_CODES = {};
try {
  // Try to load the track codes file
  const trackCodesPath = path.resolve(__dirname, 'Track-codes-list.json');
  console.log(`Loading track codes from: ${trackCodesPath}`);
  
  if (fs.existsSync(trackCodesPath)) {
    const fileContent = fs.readFileSync(trackCodesPath, 'utf8');
    const parsedData = JSON.parse(fileContent);
    
    // Check for expected structure (new or old format)
    if (parsedData.courses && Array.isArray(parsedData.courses)) {
      console.log(`Found ${parsedData.courses.length} tracks in Track-codes-list.json (courses format)`);
      
      // Convert to name->id mapping for lookups
      parsedData.courses.forEach(course => {
        if (course.course && course.id) {
          TRACK_CODES[course.course.toLowerCase()] = course.id;
        }
      });
    } else if (parsedData.course_list && Array.isArray(parsedData.course_list)) {
      console.log(`Found ${parsedData.course_list.length} tracks in Track-codes-list.json (course_list format)`);
      
      // Convert to name->id mapping for lookups
      parsedData.course_list.forEach(course => {
        if (course.name && course.id) {
          TRACK_CODES[course.name.toLowerCase()] = course.id;
        }
      });
    } else {
      // Try to read the structure exactly as it is in the file
      console.log('Attempting to parse track codes directly from JSON structure');
      if (typeof parsedData === 'object') {
        // Parse the structure directly
        Object.entries(parsedData).forEach(([key, value]) => {
          if (typeof value === 'string' && value.startsWith('crs_')) {
            TRACK_CODES[key.toLowerCase()] = value;
          }
        });
      }
      
      if (Object.keys(TRACK_CODES).length === 0) {
        throw new Error('Track-codes-list.json does not contain expected structure');
      }
    }
    
    console.log(`Successfully loaded ${Object.keys(TRACK_CODES).length} track codes`);
    
    // Add fallbacks for any missing common tracks
    for (const [track, id] of Object.entries(FALLBACK_TRACK_CODES)) {
      if (!TRACK_CODES[track]) {
        TRACK_CODES[track] = id;
        console.log(`Added fallback track code for ${track}: ${id}`);
      }
    }
  } else {
    throw new Error(`Track-codes-list.json not found at: ${trackCodesPath}`);
  }
} catch (err) {
  console.error(`Error loading track codes: ${err.message}`);
  console.log('Falling back to hardcoded track codes');
  TRACK_CODES = { ...FALLBACK_TRACK_CODES };
}

// Log first 10 track codes for debugging
console.log('Sample track codes:');
let count = 0;
for (const [track, id] of Object.entries(TRACK_CODES)) {
  if (count < 10) {
    console.log(`  - ${track}: ${id}`);
    count++;
  } else {
    break;
  }
}
console.log(`...and ${Object.keys(TRACK_CODES).length - 10} more track codes available`);

// Track cache to avoid repeated API calls for the same track
const trackHorsesCache = {};

// Main function to update bet results
async function updateBetResults() {
  console.log('Starting bet results update process...');
  
  try {
    // Fetch pending bets
    let { data: pendingBets, error: betsError } = await supabase
      .from('racing_bets')
      .select('*')
      .or('status.ilike.%pending%,status.ilike.%open%,status.eq.new,status.eq.,status.eq.PENDING,status.eq.Pending');
    
    if (betsError) {
      throw new Error(`Error fetching pending bets: ${betsError.message}`);
    }
    
    console.log(`Found ${pendingBets?.length || 0} pending bets to process`);
    
    if (!pendingBets || pendingBets.length === 0) {
      console.log('No pending bets found to update.');
      return { success: true, updated: 0, total: 0 };
    }
    
    // Sample pending bet for debugging (only log one)
    console.log(`Sample pending bet: ${JSON.stringify(pendingBets[0], null, 2)}`);
    
    // Extract all unique track+date combinations from bets
    const uniqueTracks = new Set();
    const trackDateCombos = new Map();
    
    pendingBets.forEach(bet => {
      if (!bet.track_name || !bet.race_date) return;
      
      const date = bet.race_date.split('T')[0];
      
      // Handle multiple tracks (for multiple bets)
      let trackNames = [];
      if (bet.track_name.includes('/')) {
        trackNames = bet.track_name.split('/').map(t => t.trim());
      } else {
        trackNames = [bet.track_name.trim()];
      }
      
      // Add each track to our sets and maps
      trackNames.forEach(track => {
        uniqueTracks.add(track);
        const key = `${track}:${date}`;
        trackDateCombos.set(key, { track, date });
      });
    });
    
    console.log(`Found ${uniqueTracks.size} unique tracks: ${Array.from(uniqueTracks).join(', ')}`);
    console.log(`Need to fetch ${trackDateCombos.size} track/date combinations`);
    
    // Results tracking
    const results = {
      total: pendingBets.length,
      updated: 0,
      noMatches: 0,
      errors: 0
    };
    
    // First pass: Fetch all the track data we need
    let index = 0;
    const totalCombos = trackDateCombos.size;
    
    for (const [key, { track, date }] of trackDateCombos.entries()) {
      index++;
      console.log(`\\n[${index}/${totalCombos}] Processing track: ${track}, date: ${date}`);
      
      // Skip if we already have this data cached
      if (trackHorsesCache[key] && trackHorsesCache[key].length > 0) {
        console.log(`Using cached data for ${track} (${trackHorsesCache[key].length} horses)`);
        continue;
      }
      
      try {
        // Find the course ID using our improved matcher
        const courseId = trackMatcher.findCourseId(track, TRACK_CODES);
        
        if (courseId) {
          console.log(`Found course ID for ${track}: ${courseId}`);
          
          // Fetch the data from the racing API using our improved module
          const horses = await apiRequest.fetchRaceResults(track, date, courseId, racingApi, sleep);
          trackHorsesCache[key] = horses;
          
          console.log(`Fetched ${horses.length} horses for ${track} on ${date}`);
          if (horses.length === 0) {
            console.log(`WARNING: No horses found for ${track} on ${date} with ID ${courseId}`);
          }
        } else {
          console.error(`ERROR: No course ID found for ${track} in track codes list`);
          trackHorsesCache[key] = [];
        }
        
        // Longer wait between API calls to avoid rate limiting
        console.log(`Waiting 15 seconds before next API call...`);
        await sleep(15000);
      } catch (error) {
        console.error(`Error fetching data for ${track} on ${date}:`, error.message);
        trackHorsesCache[key] = [];
        await sleep(5000); // Brief wait even on error
      }
    }
    
    // Second pass: Process all bets
    console.log('\\nProcessing all pending bets...');
    for (const bet of pendingBets) {
      try {
        if (!bet.horse_name || !bet.track_name || !bet.race_date) {
          console.log(`Skipping bet ID ${bet.id} - missing required fields`);
          results.noMatches++;
          continue;
        }
        
        const success = await processBet(bet);
        
        if (success) {
          results.updated++;
        } else {
          results.noMatches++;
        }
      } catch (error) {
        console.error(`Error processing bet ID ${bet.id}:`, error.message);
        results.errors++;
      }
    }
    
    // Print results summary
    console.log('\\nResults Summary:');
    console.log(`- Total bets processed: ${results.total}`);
    console.log(`- Matches found and updated: ${results.updated}`);
    console.log(`- No matches found: ${results.noMatches}`);
    console.log(`- Errors encountered: ${results.errors}`);
    
    return {
      success: true,
      updated: results.updated,
      total: results.total,
      noMatches: results.noMatches,
      errors: results.errors
    };
    
  } catch (error) {
    console.error('Error in updateBetResults:', error.message);
    return { success: false, error: error.message };
  }
}

// Process a bet (single or multiple)
async function processBet(bet) {
  // Determine if this is a multiple bet
  const isMultiple = bet.horse_name.includes('/');
  
  if (isMultiple) {
    return await multipleHandler.processMultipleBet(bet, trackHorsesCache, supabase);
  } else {
    return await processSingleBet(bet);
  }
}

// Process a single bet
async function processSingleBet(bet) {
  console.log(`Processing single bet: ${bet.id} - ${bet.horse_name}`);
  
  const date = bet.race_date.split('T')[0];
  const trackName = bet.track_name.trim();
  const horseName = bet.horse_name.trim();
  
  // Get cached horses for this track/date
  const cacheKey = `${trackName}:${date}`;
  const cachedHorses = trackHorsesCache[cacheKey] || [];
  
  if (cachedHorses.length === 0) {
    console.log(`No horses found for ${trackName} on ${date}`);
    return false;
  }
  
  // Find the matching horse
  const horse = multipleHandler.findHorseMatch(horseName, cachedHorses);
  
  if (!horse) {
    console.log(`No match found for horse: ${horseName} at ${trackName}`);
    return false;
  }
  
  console.log(`Found match: ${horseName} -> ${horse.horse_name} (Position: ${horse.position})`);
  
  // Calculate bet status and returns
  const { status, returns, profit_loss, sp_industry, ovr_btn, fin_pos } = calculateBetResult(bet, [horse]);
  
  // Update bet in database
  try {
    // Prepare update data - ensure all values are properly typed
    const updateData = {
      status: status,
      fin_pos: fin_pos,
      updated_at: new Date().toISOString()
    };
    
    // Only add numeric fields if they're valid numbers
    if (returns !== null && !isNaN(returns)) updateData.returns = returns;
    if (profit_loss !== null && !isNaN(profit_loss)) updateData.profit_loss = profit_loss;
    if (sp_industry !== null && !isNaN(sp_industry)) updateData.sp_industry = sp_industry;
    if (ovr_btn !== null && !isNaN(ovr_btn)) updateData.ovr_btn = ovr_btn;
    
    console.log(`Updating bet ${bet.id} with: ${JSON.stringify(updateData)}`);
    
    // Update in Supabase
    const { error } = await supabase
      .from('racing_bets')
      .update(updateData)
      .eq('id', bet.id);
    
    if (error) {
      console.error(`Error updating bet ${bet.id}:`, error.message);
      return false;
    }
    
    console.log(`Successfully updated bet ${bet.id}: ${status}, Returns: ${returns}`);
    return true;
  } catch (error) {
    console.error(`Exception updating bet ${bet.id}:`, error.message);
    return false;
  }
}

// Calculate the outcome of a bet
function calculateBetResult(bet, horses) {
  if (!horses || horses.length === 0) {
    throw new Error('No horse data provided to calculate bet result');
  }
  
  const isMultiple = horses.length > 1;
  const originalHorseCount = (bet.horse_name || '').split('/').length;
  const missingHorses = originalHorseCount - horses.length;
  
  // For multi-selection bets where not all horses were found
  let status = 'Pending';
  
  if (isMultiple && missingHorses > 0) {
    console.log(`Multiple bet has ${missingHorses} missing horses, marking as 'Partial Update'`);
    status = 'Partial Update';
  } else if (isMultiple) {
    // For complete multiples, check if all horses won
    const allWon = horses.every(horse => {
      const pos = parseFloat(horse.position);
      return pos === 1 || horse.position === '1';
    });
    
    // Check for void legs (non-runners)
    const hasVoidLeg = horses.some(horse => {
      const posLower = (horse.position || '').toLowerCase();
      return posLower === 'rr' || posLower === 'nr' || posLower === 'ns' || posLower === 'void';
    });
    
    if (hasVoidLeg) {
      status = 'Void';
    } else if (allWon) {
      status = 'Won';
    } else {
      status = 'Lost';
    }
  } else {
    // Single bet
    const horse = horses[0];
    const positionStr = String(horse.position || '').trim().toLowerCase();
    
    // Check for non-numeric positions (void races)
    if (positionStr === 'nr' || positionStr === 'ns' || positionStr === 'rr' || positionStr === 'void') {
      status = 'Void';
    } else {
      // Try to get numeric position
      const position = parseFloat(positionStr);
      
      if (isNaN(position)) {
        // If position can't be parsed as a number
        status = 'Pending'; // Keep as pending if we can't determine position
      } else if (position === 1) {
        status = 'Won';
      } else if (bet.each_way === true) {
        // Check place for each-way bets
        const numRunners = horse.total_runners || 0;
        let placePaid = 0;
        
        if (numRunners >= 16) placePaid = 4;
        else if (numRunners >= 8) placePaid = 3;
        else if (numRunners >= 5) placePaid = 2;
        
        if (placePaid > 0 && position <= placePaid) {
          status = 'Placed';
        } else {
          status = 'Lost';
        }
      } else {
        status = 'Lost';
      }
    }
  }
  
  // Calculate returns
  let returns = 0;
  
  if (status === 'Won') {
    // Winning bet gets full odds
    returns = parseFloat(bet.stake || 0) * parseFloat(bet.odds || 0);
  } else if (status === 'Placed' && bet.each_way === true) {
    // Each-way place pays a fraction
    const placeOdds = (parseFloat(bet.odds || 0) - 1) * 0.2 + 1; // 1/5 odds typically
    returns = (parseFloat(bet.stake || 0) / 2) * placeOdds; // Half stake on place
  } else if (status === 'Void') {
    // Void bets return the stake
    returns = parseFloat(bet.stake || 0);
  }
  
  // Calculate profit/loss
  const profitLoss = returns - parseFloat(bet.stake || 0);
  
  // Format finish positions
  const finishPositions = horses.map(h => h.position || '?').join(' / ');
  
  // Calculate SP value
  let spValue = null;
  if (isMultiple) {
    // For multiples, SP is the product of individual SPs
    let hasAllSPs = true;
    let cumulativeSP = 1;
    
    for (const horse of horses) {
      if (horse.sp === null || isNaN(horse.sp)) {
        hasAllSPs = false;
        break;
      }
      cumulativeSP *= parseFloat(horse.sp);
    }
    
    spValue = hasAllSPs ? cumulativeSP : null;
  } else {
    // For singles, use the horse's SP
    spValue = multipleHandler.parseNumeric(horses[0].sp);
  }
  
  // Calculate OVR_BTN value
  let ovrBtnValue = null;
  if (isMultiple) {
    // For multiples, use average of all horses' values
    let sum = 0;
    let count = 0;
    
    for (const horse of horses) {
      if (horse.ovr_btn !== null && !isNaN(horse.ovr_btn)) {
        sum += parseFloat(horse.ovr_btn);
        count++;
      }
    }
    
    ovrBtnValue = count > 0 ? sum / count : null;
  } else {
    // For singles, use the horse's value
    ovrBtnValue = multipleHandler.parseNumeric(horses[0].ovr_btn);
  }
  
  return {
    status,
    returns,
    profit_loss: profitLoss,
    sp_industry: spValue,
    ovr_btn: ovrBtnValue,
    fin_pos: finishPositions
  };
}

// Run the script
if (require.main === module) {
  updateBetResults()
    .then(result => {
      console.log('Script execution completed:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Unhandled error in script execution:', error);
      process.exit(1);
    });
}

module.exports = { updateBetResults };