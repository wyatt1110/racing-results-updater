require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

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

// Cache for today's race results
let todaysRaceResults = null;

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
      // If we didn't find anything, try a broader query as a fallback
      const { data: allBets, error: allError } = await supabase
        .from('racing_bets')
        .select('id, status, horse_name, race_date')
        .limit(10);
      
      if (!allError && allBets && allBets.length > 0) {
        console.log(`Found some bets with these details (sample): ${JSON.stringify(allBets.slice(0, 3))}`);
      }
      
      console.log('No pending bets found to update.');
      return { success: true, updated: 0, total: 0 };
    }
    
    // Fetch today's race results once
    todaysRaceResults = await fetchTodaysRaceResults();
    
    if (!todaysRaceResults || todaysRaceResults.length === 0) {
      console.log('No race results found for today, nothing to update');
      return { success: true, updated: 0, total: pendingBets.length };
    }
    
    // Create a map for faster horse name lookups
    const horseMap = createHorseNameMap(todaysRaceResults);
    
    // Process each pending bet
    let updatedCount = 0;
    
    for (const bet of pendingBets) {
      try {
        console.log(`Processing bet ID: ${bet.id} for horse: ${bet.horse_name}`);
        
        // Check if this is a multiple bet (contains '/' in horse_name)
        if (bet.horse_name && bet.horse_name.includes('/')) {
          await processMultipleBet(bet, todaysRaceResults, horseMap);
        } else {
          await processSingleBet(bet, todaysRaceResults, horseMap);
        }
        
        updatedCount++;
        
      } catch (betError) {
        console.error(`Error processing bet ID ${bet.id}:`, betError);
      }
    }
    
    console.log(`Successfully updated ${updatedCount} out of ${pendingBets.length} pending bets`);
    return { success: true, updated: updatedCount, total: pendingBets.length };
    
  } catch (error) {
    console.error('Error in updateBetResults:', error);
    return { success: false, error: error.message };
  }
}

// Create a map of horse names for faster lookups
function createHorseNameMap(raceResults) {
  const map = new Map();
  
  for (const race of raceResults) {
    const trackName = race.track_name.toLowerCase().trim();
    
    if (!map.has(trackName)) {
      map.set(trackName, []);
    }
    
    for (const horse of race.results) {
      const horseName = horse.horse_name.toLowerCase().trim();
      
      // Store the horse info with the track
      map.get(trackName).push({
        horseName,
        fullInfo: {
          ...horse,
          race_id: race.race_id,
          race_name: race.race_name,
          total_runners: race.total_runners
        }
      });
    }
  }
  
  return map;
}

// Find a horse in the map
function findHorseInMap(horseMap, horseName, trackName) {
  if (!horseName || !trackName) return null;
  
  const cleanedHorseName = cleanHorseName(horseName);
  const cleanedTrackName = cleanHorseName(trackName);
  
  console.log(`Looking for horse: ${cleanedHorseName} at track: ${cleanedTrackName}`);
  
  // First try exact track name match
  if (horseMap.has(cleanedTrackName)) {
    const trackHorses = horseMap.get(cleanedTrackName);
    
    // Try exact horse name match first
    const exactMatch = trackHorses.find(h => h.horseName === cleanedHorseName);
    if (exactMatch) {
      console.log(`Found exact match for ${horseName} at position ${exactMatch.fullInfo.position}`);
      return exactMatch.fullInfo;
    }
    
    // Try partial matches
    const partialMatch = trackHorses.find(h => 
      h.horseName.includes(cleanedHorseName) || 
      cleanedHorseName.includes(h.horseName)
    );
    
    if (partialMatch) {
      console.log(`Found partial match for ${horseName} -> ${partialMatch.fullInfo.horse_name} at position ${partialMatch.fullInfo.position}`);
      return partialMatch.fullInfo;
    }
    
    // Try prefix match (for horses with apostrophes, etc.)
    const prefixMatch = trackHorses.find(h => 
      h.horseName.startsWith(cleanedHorseName.substring(0, 5)) ||
      cleanedHorseName.startsWith(h.horseName.substring(0, 5))
    );
    
    if (prefixMatch) {
      console.log(`Found prefix match for ${horseName} -> ${prefixMatch.fullInfo.horse_name} at position ${prefixMatch.fullInfo.position}`);
      return prefixMatch.fullInfo;
    }
  }
  
  // If we couldn't find by exact track, try to find similar track names
  for (const [mapTrack, horses] of horseMap.entries()) {
    // Skip if we already tried this track exactly
    if (mapTrack === cleanedTrackName) continue;
    
    // Check if track names are similar
    if (mapTrack.includes(cleanedTrackName) || cleanedTrackName.includes(mapTrack)) {
      // Try to find the horse in this similar track
      const match = horses.find(h => 
        h.horseName === cleanedHorseName ||
        h.horseName.includes(cleanedHorseName) || 
        cleanedHorseName.includes(h.horseName) ||
        h.horseName.startsWith(cleanedHorseName.substring(0, 5)) ||
        cleanedHorseName.startsWith(h.horseName.substring(0, 5))
      );
      
      if (match) {
        console.log(`Found match for ${horseName} at similar track ${mapTrack} at position ${match.fullInfo.position}`);
        return match.fullInfo;
      }
    }
  }
  
  console.log(`No match found for horse: ${horseName} at track: ${trackName}`);
  return null;
}

// Process a single horse bet
async function processSingleBet(bet, raceResults, horseMap) {
  // Find the horse in the results using the map
  const horseResult = findHorseInMap(horseMap, bet.horse_name, bet.track_name);
  
  if (!horseResult) {
    console.log(`No results found for ${bet.track_name} today`);
    return;
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
  let status = 'pending';
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
}

// Process a multiple bet (horses separated by '/')
async function processMultipleBet(bet, raceResults, horseMap) {
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
      return;
    }
    
    const horseResult = findHorseInMap(horseMap, selection, trackName);
    if (!horseResult) {
      console.log(`No results found for ${trackName} today`);
      return; // Exit if any horse is not found
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
}

// Fetch today's race results directly from the Racing API
async function fetchTodaysRaceResults() {
  try {
    console.log('Fetching today\'s race results...');
    
    // Use the exact endpoint that worked with curl
    const response = await racingApi.get('/results/today');
    
    // Save the raw response for debugging
    try {
      const fs = require('fs');
      fs.writeFileSync('results_raw_response.json', JSON.stringify(response.data, null, 2));
      console.log('Saved raw API response to results_raw_response.json');
    } catch (writeError) {
      console.log('Could not save response to file:', writeError.message);
    }
    
    // Check if we have valid data
    if (!response.data || response.data.status !== 'success' || !response.data.data || !response.data.data.results) {
      console.log('No race results found for today or invalid response structure');
      console.log('Response status:', response.status);
      console.log('Response data structure:', JSON.stringify(Object.keys(response.data || {})));
      return [];
    }
    
    const meetings = response.data.data.results;
    console.log(`Successfully retrieved results for ${meetings.length} meetings`);
    
    // Save formatted results for debugging
    try {
      const fs = require('fs');
      fs.writeFileSync('results_today.json', JSON.stringify(meetings, null, 2));
      console.log('Saved formatted race results to results_today.json');
    } catch (writeError) {
      console.log('Could not save results to file:', writeError.message);
    }
    
    // Process and format the results
    const formattedRaces = [];
    
    for (const meeting of meetings) {
      const track = meeting.meeting_name || meeting.course;
      console.log(`Processing results for track: ${track}`);
      
      // Process each race at this track
      for (const race of meeting.races || []) {
        // Get runners
        const runners = race.runners || [];
        
        formattedRaces.push({
          track_name: track,
          race_id: race.race_id || race.id,
          race_name: race.race_name || race.name,
          time: race.time,
          total_runners: runners.length,
          results: runners.map(runner => ({
            horse_name: runner.horse || runner.name,
            position: runner.position,
            bsp: runner.bsp || null,
            sp: runner.sp_dec || runner.sp || null,
            total_runners: runners.length
          }))
        });
      }
    }
    
    console.log(`Processed ${formattedRaces.length} races with results`);
    return formattedRaces;
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