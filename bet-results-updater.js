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
    
    // Fetch today's race results once and organize them for quick lookup
    const racingData = await fetchTodaysRaceResults();
    
    // If we couldn't get any race data, exit early
    if (!racingData || racingData.length === 0) {
      console.log('No race results found for today, nothing to update');
      return { success: true, updated: 0, total: pendingBets.length };
    }
    
    console.log(`Successfully retrieved data for ${racingData.length} horses`);
    
    // Process each pending bet
    let updatedCount = 0;
    let foundMatchCount = 0;
    let noMatchCount = 0;
    let errorCount = 0;
    
    for (const bet of pendingBets) {
      try {
        console.log(`\nProcessing bet ID: ${bet.id}`);
        console.log(`Horse: ${bet.horse_name || 'N/A'}, Track: ${bet.track_name || 'N/A'}`);
        
        // Check if this is a multiple bet (contains '/' in horse_name)
        if (bet.horse_name && bet.horse_name.includes('/')) {
          const matchFound = await processMultipleBet(bet, racingData);
          if (matchFound) {
            updatedCount++;
            foundMatchCount++;
          } else {
            noMatchCount++;
          }
        } else {
          const matchFound = await processSingleBet(bet, racingData);
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

// Fetch today's race results and flatten into searchable format
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
    
    // Check if we have the expected response structure
    if (!response.data) {
      console.log('Invalid API response: no data received');
      return [];
    }
    
    // Directly access all results (flatten the structure)
    const allHorseResults = [];
    
    // First log the structure we're dealing with
    console.log('API response structure:');
    console.log('Response has these top level keys:', Object.keys(response.data));
    
    if (response.data.results && Array.isArray(response.data.results)) {
      console.log(`Found ${response.data.results.length} items in results array`);
    } else {
      console.log('No results array found or it is not an array');
      return [];
    }
    
    // Process in a way that works regardless of exact structure
    for (const item of response.data.results) {
      // Try to extract races and course info
      const trackName = item.meeting_name || item.course || '';
      console.log(`Processing results for track: ${trackName}`);
      
      let races = [];
      
      // Extract races from wherever they might be in the structure
      if (item.races && Array.isArray(item.races)) {
        races = item.races;
      } else if (item.data && item.data.races && Array.isArray(item.data.races)) {
        races = item.data.races;
      }
      
      if (races.length === 0) {
        console.log(`No races found for ${trackName}`);
        continue;
      }
      
      console.log(`Found ${races.length} races at ${trackName}`);
      
      // Process each race at this track
      for (const race of races) {
        const raceId = race.race_id || race.id || '';
        const raceTime = race.time || '';
        const raceName = race.race_name || race.name || '';
        
        // Extract runners from wherever they might be
        let runners = [];
        if (race.runners && Array.isArray(race.runners)) {
          runners = race.runners;
        } else if (race.results && Array.isArray(race.results)) {
          runners = race.results;
        }
        
        if (runners.length === 0) {
          console.log(`No runners found for race at ${raceTime}`);
          continue;
        }
        
        // Create complete info for each horse including race and track details
        for (const runner of runners) {
          const horseName = runner.horse || runner.name || '';
          if (!horseName) continue;
          
          allHorseResults.push({
            horse_name: horseName,
            position: runner.position || '',
            bsp: runner.bsp || null,
            sp: runner.sp_dec || runner.sp || null,
            track_name: trackName,
            race_id: raceId,
            race_time: raceTime,
            race_name: raceName,
            total_runners: runners.length
          });
        }
      }
    }
    
    // Log the total number of horses processed
    console.log(`Processed a total of ${allHorseResults.length} horse results`);
    
    // Save processed data for debugging
    try {
      fs.writeFileSync('processed_horses.json', JSON.stringify(allHorseResults, null, 2));
      console.log('Saved processed horse data to processed_horses.json');
    } catch (writeError) {
      console.log('Could not save processed data to file:', writeError.message);
    }
    
    return allHorseResults;
  } catch (error) {
    console.error('Error fetching today\'s race results:', error.message);
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', JSON.stringify(error.response.data || {}).substring(0, 200) + '...');
    }
    return [];
  }
}

// Find a horse in the results data
function findHorseInResults(allHorses, horseName, trackName) {
  if (!horseName) return null;
  
  const cleanTrack = cleanHorseName(trackName || '');
  const cleanHorse = cleanHorseName(horseName);
  
  console.log(`Looking for horse: "${cleanHorse}" at track: "${cleanTrack}"`);
  
  // First try exact match with track and horse name
  const exactMatch = allHorses.find(horse => 
    cleanHorseName(horse.horse_name) === cleanHorse && 
    (!cleanTrack || cleanHorseName(horse.track_name).includes(cleanTrack) || cleanTrack.includes(cleanHorseName(horse.track_name)))
  );
  
  if (exactMatch) {
    console.log(`MATCH FOUND: Exact match for "${horseName}" at ${exactMatch.track_name}, position: ${exactMatch.position}`);
    return exactMatch;
  }
  
  // Try partial match with track and horse name
  const partialMatch = allHorses.find(horse => {
    const horseNameClean = cleanHorseName(horse.horse_name);
    const trackNameClean = cleanHorseName(horse.track_name);
    
    return (horseNameClean.includes(cleanHorse) || cleanHorse.includes(horseNameClean)) && 
           (!cleanTrack || trackNameClean.includes(cleanTrack) || cleanTrack.includes(trackNameClean));
  });
  
  if (partialMatch) {
    console.log(`MATCH FOUND: Partial match for "${horseName}" -> "${partialMatch.horse_name}" at ${partialMatch.track_name}, position: ${partialMatch.position}`);
    return partialMatch;
  }
  
  // If we have a track but couldn't find with it, try just by horse name as fallback
  if (cleanTrack) {
    const horseOnlyMatch = allHorses.find(horse => {
      const horseNameClean = cleanHorseName(horse.horse_name);
      return horseNameClean === cleanHorse || horseNameClean.includes(cleanHorse) || cleanHorse.includes(horseNameClean);
    });
    
    if (horseOnlyMatch) {
      console.log(`MATCH FOUND: Horse-only match for "${horseName}" at ${horseOnlyMatch.track_name} (not ${trackName}), position: ${horseOnlyMatch.position}`);
      return horseOnlyMatch;
    }
  }
  
  // Log the track names we have in the data to help with debugging
  const uniqueTracks = [...new Set(allHorses.map(h => h.track_name))];
  console.log(`Available tracks in results: ${uniqueTracks.join(', ')}`);
  
  // If track matches but no horse match, show all horses at that track
  if (cleanTrack) {
    const horsesAtTrack = allHorses.filter(horse => {
      const trackNameClean = cleanHorseName(horse.track_name);
      return trackNameClean.includes(cleanTrack) || cleanTrack.includes(trackNameClean);
    });
    
    if (horsesAtTrack.length > 0) {
      console.log(`Horses at ${trackName}:`);
      horsesAtTrack.forEach(h => {
        console.log(`- ${h.horse_name} (position: ${h.position})`);
      });
    } else {
      console.log(`No horses found at track: ${trackName}`);
    }
  }
  
  console.log(`NO MATCH: Horse "${horseName}" not found at track "${trackName}" or any similar track`);
  return null;
}

// Process a single horse bet
async function processSingleBet(bet, allHorses) {
  // Skip if missing essential data
  if (!bet.horse_name) {
    console.log(`Skipping bet ID ${bet.id} - missing horse name`);
    return false;
  }
  
  // Find the horse in the results
  const horseResult = findHorseInResults(allHorses, bet.horse_name, bet.track_name);
  
  if (!horseResult) {
    console.log(`No match found for bet ID ${bet.id}`);
    return false;
  }
  
  // Get number of runners in the race
  const numRunners = parseInt(horseResult.total_runners) || 0;
  console.log(`Race has ${numRunners} runners`);
  
  // Determine if this is an each-way bet
  const isEachWay = bet.each_way === true;
  
  // Determine bet result (win, place, loss)
  const betType = isEachWay ? 'each-way' : (bet.bet_type || 'win');
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
  
  console.log(`Successfully updated bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}, Position: ${horseResult.position}`);
  return true;
}

// Process a multiple bet (horses separated by '/')
async function processMultipleBet(bet, allHorses) {
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
    const trackName = trackNames[i] || trackNames[0] || '';
    
    const horseResult = findHorseInResults(allHorses, selection, trackName);
    if (!horseResult) {
      console.log(`No results found for ${selection} at ${trackName || 'any track'}`);
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
  
  // Determine if this is an each-way bet
  const isEachWay = bet.each_way === true;
  
  // Determine bet result - for multiple bets, all selections must win
  let status = 'Lost';
  if ((bet.bet_type === 'win' || !bet.bet_type) && allWon) {
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
  if (betType === 'win' || betType === 'single') {
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
  
  // Determine if this is an each-way bet
  const isEachWay = bet.each_way === true;
  
  // For win bets
  if ((bet.bet_type === 'win' || bet.bet_type === 'single' || !bet.bet_type) && result === 'win') {
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