require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');

// Configuration with fallback values and multiple environment variable checks
const supabaseUrl = process.env.SUPABASE_URL || 
                   process.env.NEXT_PUBLIC_SUPABASE_URL || 
                   'https://gwvnmzfpnuwxcqtewbtl.supabase.co';

const supabaseKey = process.env.SUPABASE_KEY || 
                   process.env.SUPABASE_SERVICE_ROLE_KEY || 
                   process.env.SUPABASE_ANON_KEY ||
                   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3dm5temZwbnV3eGNxdGV3YnRsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwOTc1NDY3MCwiZXhwIjoyMDI1MzMwNjcwfQ.uZCQGcFm1mGSrKAcqbfgVx-YsNWlb-4iKLwRH5GQaRY';

const racingApiUsername = process.env.RACING_API_USERNAME || 'KQ9W7rQeAHWMUgxH93ie3yEc';
const racingApiPassword = process.env.RACING_API_PASSWORD || 'T5BoPivL3Q2h6RhCdLv4EwZu';
const racingApiBase = 'https://api.theracingapi.com/v1';

// Initialize Supabase client
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  }
});

// Create axios instance with authentication
const racingApi = axios.create({
  baseURL: racingApiBase,
  auth: {
    username: racingApiUsername,
    password: racingApiPassword
  }
});

// Helper functions
const standardizeDate = (dateString) => {
  const date = new Date(dateString);
  return date.toISOString().split('T')[0];
};

const cleanHorseName = (name) => {
  if (!name) return '';
  return name.toLowerCase().trim();
};

// Main function to update bet results
async function updateBetResults() {
  console.log('Starting bet results update process...');
  console.log(`Using Supabase URL: ${supabaseUrl.substring(0, 20)}...`);
  
  try {
    // First, let's check all status values to debug
    const { data: statusCheck, error: statusError } = await supabase
      .from('racing_bets')
      .select('status')
      .limit(50);
    
    if (statusError) {
      console.log(`Error checking status values: ${statusError.message}`);
    } else {
      const uniqueStatuses = [...new Set(statusCheck.map(b => b.status))];
      console.log(`Found these status values in the database: ${JSON.stringify(uniqueStatuses)}`);
    }
    
    // Fetch pending bets using case-insensitive matching for greater flexibility
    let { data: pendingBets, error: betsError } = await supabase
      .from('racing_bets')
      .select('*')
      .or('status.ilike.%pending%,status.ilike.%open%,status.eq.new,status.eq.,status.eq.PENDING,status.eq.Pending');
    
    if (betsError) {
      throw new Error(`Error fetching pending bets: ${betsError.message}`);
    }
    
    console.log(`Found ${pendingBets ? pendingBets.length : 0} pending bets to process`);
    
    if (!pendingBets || pendingBets.length === 0) {
      console.log('No pending bets found to update.');
      return { success: true, updated: 0, total: 0 };
    }
    
    // Debug: Log the first bet to see field structure
    console.log(`Sample pending bet: ${JSON.stringify(pendingBets[0], null, 2)}`);
    
    // Fetch today's race results once
    const racesData = await fetchTodaysRaceResults();
    
    if (!racesData || racesData.length === 0) {
      console.log('No race results found for today, nothing to update');
      return { success: true, updated: 0, total: pendingBets.length };
    }
    
    console.log(`Successfully processed ${racesData.length} races with results`);
    
    // Process each pending bet
    let updatedCount = 0;
    let foundMatchCount = 0;
    let noMatchCount = 0;
    let errorCount = 0;
    
    // Create a map for faster horse name lookups
    const trackHorsesMap = createTrackHorsesMap(racesData);
    
    // Log all available tracks from the results
    const availableTracks = Object.keys(trackHorsesMap);
    console.log(`Available tracks in results: ${availableTracks.join(', ')}`);
    
    for (const bet of pendingBets) {
      try {
        console.log(`\nProcessing bet ID: ${bet.id}`);
        console.log(`Horse: ${bet.horse_name}, Track: ${bet.track_name}`);
        
        // Check if this is a multiple bet (contains '/' in horse_name)
        if (bet.horse_name && bet.horse_name.includes('/')) {
          const matchFound = await processMultipleBet(bet, racesData, trackHorsesMap);
          if (matchFound) {
            updatedCount++;
            foundMatchCount++;
          } else {
            noMatchCount++;
          }
        } else {
          const matchFound = await processSingleBet(bet, racesData, trackHorsesMap);
          if (matchFound) {
            updatedCount++;
            foundMatchCount++;
          } else {
            noMatchCount++;
          }
        }
      } catch (betError) {
        console.error(`Error processing bet ID ${bet.id}:`, betError);
        errorCount++;
      }
    }
    
    console.log(`\nResults Summary:`);
    console.log(`- Total bets processed: ${pendingBets.length}`);
    console.log(`- Matches found and updated: ${foundMatchCount}`);
    console.log(`- No matches found: ${noMatchCount}`);
    console.log(`- Errors encountered: ${errorCount}`);
    
    return { 
      success: true, 
      updated: updatedCount, 
      total: pendingBets.length,
      matches: foundMatchCount,
      noMatches: noMatchCount,
      errors: errorCount
    };
    
  } catch (error) {
    console.error('Error in updateBetResults:', error);
    return { success: false, error: error.message };
  }
}

// Create a normalized map of tracks and horses for easier lookup
function createTrackHorsesMap(raceResults) {
  const trackMap = {};
  
  for (const race of raceResults) {
    const trackName = cleanHorseName(race.track_name);
    
    if (!trackMap[trackName]) {
      trackMap[trackName] = [];
    }
    
    // Add all horses from this race to the track
    for (const horse of race.runners) {
      trackMap[trackName].push({
        name: cleanHorseName(horse.horse || horse.name),
        position: horse.position,
        bsp: horse.bsp,
        sp: horse.sp_dec || horse.sp,
        race_id: race.race_id || race.id,
        race_name: race.race_name || race.name,
        total_runners: race.runners.length
      });
    }
  }
  
  return trackMap;
}

// Find a horse in the track map
function findHorseInResults(trackMap, horseName, trackName) {
  const cleanTrackName = cleanHorseName(trackName);
  const cleanHorse = cleanHorseName(horseName);
  
  console.log(`Looking for horse: "${cleanHorse}" at track: "${cleanTrackName}"`);
  
  // Check if we have results for this track
  if (trackMap[cleanTrackName]) {
    console.log(`Found track "${cleanTrackName}" in results`);
    
    // First try exact match
    const exactMatch = trackMap[cleanTrackName].find(h => h.name === cleanHorse);
    if (exactMatch) {
      console.log(`MATCH FOUND: Exact match for "${horseName}" at position ${exactMatch.position}`);
      return exactMatch;
    }
    
    // Try partial matches
    const partialMatch = trackMap[cleanTrackName].find(h => 
      h.name.includes(cleanHorse) || 
      cleanHorse.includes(h.name)
    );
    
    if (partialMatch) {
      console.log(`MATCH FOUND: Partial match for "${horseName}" → "${partialMatch.name}" at position ${partialMatch.position}`);
      return partialMatch;
    }
    
    // Log all horses at this track for debugging
    console.log(`All horses at ${cleanTrackName}:`);
    trackMap[cleanTrackName].forEach(h => {
      console.log(`- "${h.name}" (position: ${h.position})`);
    });
  } else {
    console.log(`Track "${cleanTrackName}" not found in results`);
    
    // Try alternate track name matches
    for (const track in trackMap) {
      if (track.includes(cleanTrackName) || cleanTrackName.includes(track)) {
        console.log(`Found similar track "${track}" that might match "${cleanTrackName}"`);
        
        // Try to find the horse in this track
        const exactMatch = trackMap[track].find(h => h.name === cleanHorse);
        if (exactMatch) {
          console.log(`MATCH FOUND: Exact match for "${horseName}" at similar track "${track}" at position ${exactMatch.position}`);
          return exactMatch;
        }
        
        // Try partial matches
        const partialMatch = trackMap[track].find(h => 
          h.name.includes(cleanHorse) || 
          cleanHorse.includes(h.name)
        );
        
        if (partialMatch) {
          console.log(`MATCH FOUND: Partial match for "${horseName}" → "${partialMatch.name}" at similar track "${track}" at position ${partialMatch.position}`);
          return partialMatch;
        }
      }
    }
    
    // Log all available tracks for debugging
    console.log(`Available tracks in results: ${Object.keys(trackMap).join(', ')}`);
  }
  
  console.log(`NO MATCH: Horse "${horseName}" not found at track "${trackName}" or any similar tracks`);
  return null;
}

// Process a single horse bet
async function processSingleBet(bet, raceResults, trackHorsesMap) {
  // Skip if missing essential data
  if (!bet.horse_name || !bet.track_name) {
    console.log(`Skipping bet ID ${bet.id} - missing horse name or track name`);
    return false;
  }
  
  // Find the horse in the results
  const horseResult = findHorseInResults(trackHorsesMap, bet.horse_name, bet.track_name);
  
  if (!horseResult) {
    console.log(`No match found for bet ID ${bet.id}`);
    return false;
  }
  
  // Get number of runners in the race
  const numRunners = horseResult.total_runners || 0;
  console.log(`Race has ${numRunners} runners`);
  
  // Determine if this is an each-way bet (check both field names)
  const isEachWay = bet.each_way === true || bet.e_w === true;
  
  // Determine bet result (win, place, loss)
  const betType = isEachWay ? 'each-way' : bet.bet_type;
  const betResult = determineBetResult(horseResult, betType, numRunners);
  
  // Calculate bet returns based on result
  const returns = calculateReturns(bet, betResult, horseResult, numRunners);
  
  // Map betResult to status field value
  let status = 'Pending';
  if (betResult === 'win' || betResult === 'win-place') {
    status = 'Won';
  } else if (betResult === 'place') {
    status = 'Placed';
  } else if (betResult === 'loss') {
    status = 'Lost';
  } else if (betResult === 'void') {
    status = 'Void';
  }
  
  // Calculate profit/loss
  const profitLoss = returns - bet.stake;
  
  // Update the bet in Supabase
  const { error: updateError } = await supabase
    .from('racing_bets')
    .update({
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      sp_industry: horseResult.sp || null,
      ovr_btn: horseResult.bsp || null,
      closing_line_value: calculateCLV(bet, horseResult),
      clv_stake: calculateCLVStake(bet, horseResult),
      fin_pos: horseResult.position || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (updateError) {
    throw new Error(`Error updating bet ID ${bet.id}: ${updateError.message}`);
  }
  
  console.log(`Successfully updated bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
  return true;
}

// Process a multiple bet (horses separated by '/')
async function processMultipleBet(bet, raceResults, trackHorsesMap) {
  // Split selection by '/'
  const selections = bet.horse_name.split('/').map(s => s.trim());
  console.log(`Processing multiple bet with ${selections.length} selections: ${selections.join(', ')}`);
  
  // Split track names if multiple tracks
  const trackNames = bet.track_name ? bet.track_name.split('/').map(t => t.trim()) : [];
  
  // Find all horses in the results
  const horseResults = [];
  
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i];
    // Get track name (use the corresponding track if available, otherwise use the first one)
    const trackName = trackNames[i] || trackNames[0];
    
    if (!trackName) {
      console.log(`No track name found for selection ${selection}`);
      return false;
    }
    
    const horseResult = findHorseInResults(trackHorsesMap, selection, trackName);
    if (!horseResult) {
      console.log(`No results found for ${selection} at ${trackName}`);
      return false; // Exit if any horse is not found
    }
    horseResults.push(horseResult);
  }
  
  console.log(`Found all ${selections.length} horses in the multiple bet`);
  
  // Check if all horses won (for win bets)
  const allWon = horseResults.every(hr => parseInt(hr.position) === 1);
  
  // Format positions for fin_pos field
  const positionsFormatted = horseResults.map(hr => hr.position).join(' / ');
  
  // Format BSP values for ovr_btn field
  const bspFormatted = horseResults.map(hr => hr.bsp || '0').join(' / ');
  
  // Calculate combined BSP (multiply all BSPs together)
  let combinedBSP = 1;
  let allHaveBSP = true;
  
  for (const hr of horseResults) {
    if (!hr.bsp || hr.bsp <= 0) {
      allHaveBSP = false;
      break;
    }
    combinedBSP *= parseFloat(hr.bsp);
  }
  
  if (!allHaveBSP) {
    combinedBSP = null;
  }
  
  // Format SP values for sp_industry field
  const spFormatted = horseResults.map(hr => hr.sp || '0').join(' / ');
  
  // Determine if this is an each-way bet (check both field names)
  const isEachWay = bet.each_way === true || bet.e_w === true;
  
  // Determine bet result - for multiple bets, all selections must win
  let status = 'Lost';
  if (bet.bet_type === 'win' && allWon) {
    status = 'Won';
  }
  
  // Calculate returns
  let returns = 0;
  if (status === 'Won') {
    returns = bet.stake * bet.odds;
  }
  
  // Calculate profit/loss
  const profitLoss = returns - bet.stake;
  
  // Update the bet in Supabase
  const { error: updateError } = await supabase
    .from('racing_bets')
    .update({
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      sp_industry: spFormatted,
      ovr_btn: bspFormatted,
      closing_line_value: allHaveBSP ? calculateCLVForMultiple(bet, combinedBSP) : null,
      clv_stake: allHaveBSP ? calculateCLVStakeForMultiple(bet, combinedBSP) : null,
      fin_pos: positionsFormatted,
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (updateError) {
    throw new Error(`Error updating multiple bet ID ${bet.id}: ${updateError.message}`);
  }
  
  console.log(`Successfully updated multiple bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}, Positions: ${positionsFormatted}`);
  return true;
}

// Fetch today's race results
async function fetchTodaysRaceResults() {
  try {
    console.log('Fetching today\'s race results...');
    
    // Make the API call
    const response = await racingApi.get('/results/today');
    
    // Save the raw response for debugging
    try {
      fs.writeFileSync('results_raw_response.json', JSON.stringify(response.data, null, 2));
      console.log('Saved raw API response to results_raw_response.json');
    } catch (writeError) {
      console.log('Could not save response to file:', writeError.message);
    }
    
    // Direct top-level access to the results array
    if (response.data && response.data.results) {
      console.log(`API returned ${response.data.results.length} meetings`);
      
      // Process each meeting's races
      const allRaces = [];
      
      for (const meeting of response.data.results) {
        console.log(`Processing meeting: ${meeting.meeting_name || meeting.course || 'Unknown'}`);
        
        if (!meeting.races || !Array.isArray(meeting.races)) {
          console.log(`No races found for meeting ${meeting.meeting_name || meeting.course || 'Unknown'}`);
          continue;
        }
        
        for (const race of meeting.races) {
          // Ensure we have runners data
          if (!race.runners || !Array.isArray(race.runners)) {
            console.log(`No runners found for race ${race.race_name || race.name || 'Unknown'}`);
            continue;
          }
          
          // Add normalized race data to our results
          allRaces.push({
            track_name: meeting.meeting_name || meeting.course || 'Unknown',
            race_id: race.race_id || race.id,
            race_name: race.race_name || race.name || '',
            time: race.time || '',
            runners: race.runners.map(runner => ({
              horse: runner.horse || runner.name || '',
              position: runner.position || '',
              bsp: runner.bsp || null,
              sp_dec: runner.sp_dec || runner.sp || null
            }))
          });
        }
      }
      
      // Save processed results
      try {
        fs.writeFileSync('processed_results.json', JSON.stringify(allRaces, null, 2));
        console.log(`Saved ${allRaces.length} processed races to processed_results.json`);
      } catch (writeError) {
        console.log('Could not save processed results to file:', writeError.message);
      }
      
      return allRaces;
    } else {
      // Log the whole response structure for debugging
      console.log('Unexpected API response structure:');
      console.log('Response status:', response.status);
      console.log('Response data keys:', Object.keys(response.data || {}));
      
      // Try to access different API response structures
      if (response.data && response.data.data && response.data.data.results) {
        return response.data.data.results;
      }
      
      return [];
    }
  } catch (error) {
    console.error('Error fetching today\'s race results:', error.message);
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', JSON.stringify(error.response.data));
    }
    return [];
  }
}

// Determine bet result (win, place, loss) based on number of runners
function determineBetResult(horseResult, betType, numRunners) {
  if (!horseResult || !horseResult.position) {
    return null;
  }
  
  const position = parseInt(horseResult.position, 10);
  
  if (isNaN(position)) {
    return 'void'; // Non-runner or void race
  }
  
  // Win bet logic
  if (betType === 'win') {
    return position === 1 ? 'win' : 'loss';
  }
  
  // Place bet logic based on number of runners
  if (betType === 'place') {
    // Apply place rules based on number of runners
    if (numRunners <= 7) {
      return position <= 2 ? 'place' : 'loss';
    } else if (numRunners <= 12) { 
      return position <= 3 ? 'place' : 'loss';
    } else if (numRunners <= 19) {
      return position <= 4 ? 'place' : 'loss';
    } else {
      return position <= 5 ? 'place' : 'loss';
    }
  }
  
  // Each-way bet logic
  if (betType === 'each-way') {
    // Win part
    if (position === 1) {
      // Check place part based on number of runners
      if (numRunners <= 7) {
        return 'win-place'; // Win and place (top 2)
      } else if (numRunners <= 12) {
        return 'win-place'; // Win and place (top 3)
      } else if (numRunners <= 19) {
        return 'win-place'; // Win and place (top 4)
      } else {
        return 'win-place'; // Win and place (top 5)
      }
    } 
    // Place part only (no win)
    else if ((numRunners <= 7 && position <= 2) ||
             (numRunners <= 12 && position <= 3) ||
             (numRunners <= 19 && position <= 4) ||
             (numRunners >= 20 && position <= 5)) {
      return 'place';
    } else {
      return 'loss';
    }
  }
  
  return null;
}

// Calculate returns based on bet result and number of runners
function calculateReturns(bet, result, horseResult, numRunners) {
  if (!result || result === 'loss' || result === 'void') {
    return 0;
  }
  
  // Determine if this is an each-way bet (check both field names)
  const isEachWay = bet.each_way === true || bet.e_w === true;
  
  // For win bets
  if (bet.bet_type === 'win' && result === 'win') {
    return bet.stake * bet.odds;
  }
  
  // For place bets - apply different place terms based on runner count
  if (bet.bet_type === 'place' && result === 'place') {
    let placeOdds;
    
    if (numRunners <= 7) {
      // 1/4 odds for 2 places
      placeOdds = (bet.odds - 1) / 4 + 1;
    } else if (numRunners <= 12) {
      // 1/5 odds for 3 places
      placeOdds = (bet.odds - 1) / 5 + 1;
    } else if (numRunners <= 19) {
      // 1/5 odds for 4 places
      placeOdds = (bet.odds - 1) / 5 + 1;
    } else {
      // 1/6 odds for 5 places
      placeOdds = (bet.odds - 1) / 6 + 1;
    }
    
    return bet.stake * placeOdds;
  }
  
  // For each-way bets
  if (isEachWay) {
    let returns = 0;
    let placeOdds;
    
    // Calculate place odds based on number of runners
    if (numRunners <= 7) {
      // 1/4 odds for 2 places
      placeOdds = (bet.odds - 1) / 4 + 1;
    } else if (numRunners <= 12) {
      // 1/5 odds for 3 places
      placeOdds = (bet.odds - 1) / 5 + 1;
    } else if (numRunners <= 19) {
      // 1/5 odds for 4 places
      placeOdds = (bet.odds - 1) / 5 + 1;
    } else {
      // 1/6 odds for 5 places
      placeOdds = (bet.odds - 1) / 6 + 1;
    }
    
    if (result === 'win-place') {
      // Win part
      returns += (bet.stake / 2) * bet.odds;
      // Place part
      returns += (bet.stake / 2) * placeOdds;
    } else if (result === 'place') {
      // Only place part wins
      returns += (bet.stake / 2) * placeOdds;
    }
    
    return returns;
  }
  
  return 0;
}

// Calculate CLV (Closing Line Value)
function calculateCLV(bet, horseResult) {
  if (!horseResult.bsp || horseResult.bsp <= 0) {
    return null;
  }
  
  const bspOdds = parseFloat(horseResult.bsp);
  const betOdds = parseFloat(bet.odds);
  
  if (isNaN(bspOdds) || isNaN(betOdds)) {
    return null;
  }
  
  // CLV formula: (bet_odds / bsp_odds - 1) * 100
  const clv = (betOdds / bspOdds - 1) * 100;
  return Math.round(clv * 100) / 100; // Round to 2 decimal places
}

// Calculate CLV Stake (value captured by stake)
function calculateCLVStake(bet, horseResult) {
  const clv = calculateCLV(bet, horseResult);
  
  if (clv === null) {
    return null;
  }
  
  // CLV Stake = CLV * Stake / 100
  return Math.round((clv * bet.stake / 100) * 100) / 100; // Round to 2 decimal places
}

// Calculate CLV for multiple bets
function calculateCLVForMultiple(bet, combinedBSP) {
  if (!combinedBSP || combinedBSP <= 0) {
    return null;
  }
  
  const betOdds = parseFloat(bet.odds);
  
  if (isNaN(betOdds)) {
    return null;
  }
  
  // CLV formula: (bet_odds / bsp_odds - 1) * 100
  const clv = (betOdds / combinedBSP - 1) * 100;
  return Math.round(clv * 100) / 100; // Round to 2 decimal places
}

// Calculate CLV Stake for multiple bets
function calculateCLVStakeForMultiple(bet, combinedBSP) {
  const clv = calculateCLVForMultiple(bet, combinedBSP);
  
  if (clv === null) {
    return null;
  }
  
  // CLV Stake = CLV * Stake / 100
  return Math.round((clv * bet.stake / 100) * 100) / 100; // Round to 2 decimal places
}

// Run the main function if invoked directly
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