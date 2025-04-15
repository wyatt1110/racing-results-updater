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
    
    // Add hardcoded Newmarket if not present
    if (!TRACK_CODES['newmarket']) {
      TRACK_CODES['newmarket'] = 'crs_1016';
      console.log('Added hardcoded Newmarket track code: crs_1016');
    }
  } else {
    throw new Error(`Track-codes-list.json not found at: ${trackCodesPath}`);
  }
} catch (err) {
  console.error(`Error loading track codes: ${err.message}`);
  console.log('Falling back to hardcoded track codes with key UK/IRE tracks');
  
  // Essential tracks hardcoded
  TRACK_CODES = {
    'newmarket': 'crs_1016',
    'kempton': 'crs_28054',
    'kempton (aw)': 'crs_28054',
    'lingfield': 'crs_910',
    'lingfield (aw)': 'crs_910',
    'ascot': 'crs_26',
    'catterick': 'crs_260',
    'nottingham': 'crs_1040',
    'chelmsford': 'crs_286',
    'chelmsford city': 'crs_286',
    'doncaster': 'crs_390',
    'epsom': 'crs_572',
    'epsom downs': 'crs_572',
    'goodwood': 'crs_702',
    'haydock': 'crs_776',
    'haydock park': 'crs_776',
    'newbury': 'crs_988',
    'sandown': 'crs_1222',
    'sandown park': 'crs_1222',
    'wolverhampton': 'crs_1638',
    'wolverhampton (aw)': 'crs_1638',
    'york': 'crs_1690',
    'leopardstown': 'crs_4862',
    'dundalk': 'crs_4368',
    'dundalk (aw)': 'crs_4368',
    'fairyhouse': 'crs_4374'
  };
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
    
    // Extract all unique track+date combinations from bets (process by track)
    const trackDateCombos = new Map();
    
    // Group bets by track and date for efficiency
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
      
      // Add each track to our tracking
      trackNames.forEach(track => {
        const key = `${track}:${date}`;
        if (!trackDateCombos.has(key)) {
          trackDateCombos.set(key, { track, date, bets: [] });
        }
        
        // Add this bet to the track's list
        trackDateCombos.get(key).bets.push(bet);
      });
    });
    
    console.log(`Need to fetch ${trackDateCombos.size} track/date combinations`);
    
    // Summary of tracks to be processed
    for (const [key, { track, date, bets }] of trackDateCombos.entries()) {
      console.log(`- ${track} on ${date}: ${bets.length} bets`);
    }
    
    // Results tracking
    const results = {
      total: pendingBets.length,
      updated: 0,
      noMatches: 0,
      errors: 0
    };
    
    // First phase: Process each track and fetch its data
    let index = 0;
    const totalCombos = trackDateCombos.size;
    
    for (const [key, { track, date, bets }] of trackDateCombos.entries()) {
      index++;
      console.log(`\n[${index}/${totalCombos}] Processing track: ${track}, date: ${date} (${bets.length} bets)`);
      
      try {
        // Find the course ID using our improved matcher
        const courseId = trackMatcher.findCourseId(track, TRACK_CODES);
        
        if (courseId) {
          console.log(`Found course ID for ${track}: ${courseId}`);
          
          // Fetch the data from the racing API using our improved module
          const horses = await apiRequest.fetchRaceResults(track, date, courseId, racingApi, sleep);
          
          // Store in the cache
          trackHorsesCache[key] = horses;
          
          console.log(`Fetched ${horses.length} horses for ${track} on ${date}`);
          
          // Process the bets for this track immediately
          for (const bet of bets) {
            try {
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
        } else {
          console.error(`ERROR: No course ID found for ${track} in track codes list`);
          trackHorsesCache[key] = [];
          
          // Mark all bets for this track as failures
          for (const bet of bets) {
            console.log(`Cannot process bet ID ${bet.id} - no course ID for track ${track}`);
            results.noMatches++;
          }
        }
        
        // Longer wait between API calls to avoid rate limiting
        console.log(`Waiting 20 seconds before next API call...`);
        await sleep(20000);
      } catch (error) {
        console.error(`Error processing track ${track} on ${date}:`, error.message);
        trackHorsesCache[key] = [];
        
        // Mark all bets for this track as errors
        for (const bet of bets) {
          console.log(`Error processing bet ID ${bet.id} due to track API error`);
          results.errors++;
        }
        
        await sleep(5000); // Brief wait even on error
      }
    }
    
    // Print results summary
    console.log('\nResults Summary:');
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
  
  // Find the matching horse using enhanced matching
  const horse = multipleHandler.findHorseMatchEnhanced(horseName, cachedHorses);
  
  if (!horse) {
    console.log(`No match found for horse: ${horseName} at ${trackName}`);
    return false;
  }
  
  console.log(`Found match: ${horseName} -> ${horse.horse_name} (Position: ${horse.position})`);
  
  // Check if horse_id is available
  if (horse.horse_id) {
    console.log(`Horse ID for ${horse.horse_name}: ${horse.horse_id}`);
  } else {
    console.log(`No horse ID found for ${horse.horse_name}`);
  }
  
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
    
    // Add horse_id if available
    if (horse.horse_id) {
      updateData.horse_id = horse.horse_id;
    }
    
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
    if (bet.each_way === true) {
      // FIXED: For a winning each-way bet, calculate both win and place parts
      const totalStake = parseFloat(bet.stake || 0);
      const winStake = totalStake / 2;  // Half stake on win
      const placeStake = totalStake / 2; // Half stake on place
      
      // Calculate place terms based on number of runners
      const numRunners = horses[0].total_runners || 0;
      let placeFraction = 0.2; // Default to 1/5 odds
      
      if (numRunners >= 16) {
        placeFraction = 0.25; // 1/4 odds for handicaps with 16+ runners
      } else if (numRunners < 5) {
        placeFraction = 0.25; // 1/4 odds for small fields
      }
      
      // Calculate place odds
      const regularOdds = parseFloat(bet.odds || 0);
      const placeOdds = (regularOdds - 1) * placeFraction + 1; 
      
      // Win part pays at full odds
      const winReturns = winStake * regularOdds;
      
      // Place part pays at place terms
      const placeReturns = placeStake * placeOdds;
      
      // Total returns is sum of win and place parts
      returns = winReturns + placeReturns;
      
      console.log(`E/W bet won: Win part: ${winStake} @ ${regularOdds} = ${winReturns}, Place part: ${placeStake} @ ${placeOdds} = ${placeReturns}, Total: ${returns}`);
    } else {
      // Regular win bet
      returns = parseFloat(bet.stake || 0) * parseFloat(bet.odds || 0);
    }
  } else if (status === 'Placed' && bet.each_way === true) {
    // Each-way place pays place part only
    const totalStake = parseFloat(bet.stake || 0);
    const placeStake = totalStake / 2; // Half stake on place
    
    // Calculate place terms based on number of runners
    const numRunners = horses[0].total_runners || 0;
    let placeFraction = 0.2; // Default to 1/5 odds
    
    if (numRunners >= 16) {
      placeFraction = 0.25; // 1/4 odds for handicaps with 16+ runners
    } else if (numRunners < 5) {
      placeFraction = 0.25; // 1/4 odds for small fields
    }
    
    // Calculate place odds
    const regularOdds = parseFloat(bet.odds || 0);
    const placeOdds = (regularOdds - 1) * placeFraction + 1;
    
    // Only place part pays out, win part loses
    returns = placeStake * placeOdds;
    
    console.log(`E/W bet placed: Win part lost, Place part: ${placeStake} @ ${placeOdds} = ${returns}`);
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
  
  // Calculate OVR_BTN value - Modified to SUM for multiples, not average
  let ovrBtnValue = null;
  if (isMultiple) {
    // For multiples, sum all horses' values
    let sum = 0;
    let allHaveOvrBtn = true;
    
    for (const horse of horses) {
      if (horse.ovr_btn !== null && !isNaN(horse.ovr_btn)) {
        sum += parseFloat(horse.ovr_btn);
      } else {
        allHaveOvrBtn = false;
      }
    }
    
    // Only set the value if we could calculate it for at least one horse
    if (allHaveOvrBtn || horses.some(h => h.ovr_btn !== null && !isNaN(h.ovr_btn))) {
      ovrBtnValue = sum;
    }
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