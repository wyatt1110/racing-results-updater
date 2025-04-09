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
    
    // Process each pending bet
    let updatedCount = 0;
    
    for (const bet of pendingBets) {
      try {
        console.log(`Processing bet ID: ${bet.id} for horse: ${bet.horse_name}`);
        
        // Only process bets for today's date
        const today = new Date().toISOString().split('T')[0];
        const betDate = standardizeDate(bet.race_date);
        
        if (betDate !== today) {
          console.log(`Skipping bet ID ${bet.id} - race date ${betDate} is not today (${today})`);
          continue;
        }
        
        // Check if this is a multiple bet (contains '/' in horse_name)
        if (bet.horse_name.includes('/')) {
          await processMultipleBet(bet);
        } else {
          await processSingleBet(bet);
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

// Process a single horse bet
async function processSingleBet(bet) {
  // Get the results for this track from today's cache
  const results = findTrackResults(bet.track_name);
  
  if (!results || !results.length) {
    console.log(`No results found for ${bet.track_name} today`);
    return;
  }
  
  // Find the horse in the results
  const horseResult = findHorseInResults(results, bet.horse_name);
  
  if (!horseResult) {
    console.log(`Horse ${bet.horse_name} not found in results for ${bet.track_name}`);
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
    status = 'won';
  } else if (betResult === 'place') {
    status = 'placed';
  } else if (betResult === 'loss') {
    status = 'lost';
  } else if (betResult === 'void') {
    status = 'void';
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
async function processMultipleBet(bet) {
  // Split selection by '/'
  const selections = bet.horse_name.split('/').map(s => s.trim());
  console.log(`Processing multiple bet with ${selections.length} selections: ${selections.join(', ')}`);
  
  // Split track names if multiple tracks
  const trackNames = bet.track_name.split('/').map(t => t.trim());
  
  // Find all horses in the results
  const horseResults = [];
  
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i];
    // Get track name (use the corresponding track if available, otherwise use the first one)
    const trackName = trackNames[i] || trackNames[0];
    
    // Get results for this track
    const results = findTrackResults(trackName);
    
    if (!results || !results.length) {
      console.log(`No results found for ${trackName} today`);
      return;
    }
    
    const horseResult = findHorseInResults(results, selection);
    if (!horseResult) {
      console.log(`Horse ${selection} not found in results for ${trackName}`);
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
  let status = 'lost';
  if (bet.bet_type === 'win' && allWon) {
    status = 'won';
  }
  
  // Calculate returns
  let returns = 0;
  if (status === 'won') {
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

// Fetch today's race results using the simpler API call
async function fetchTodaysRaceResults() {
  try {
    console.log('Fetching today\'s race results...');
    
    const response = await racingApi.get('/results/today');
    
    if (!response.data || !response.data.data || !response.data.data.results) {
      console.log('No race results found for today');
      return [];
    }
    
    console.log(`Successfully retrieved results for ${response.data.data.results.length} races`);
    
    // Process and format the results
    const formattedRaces = [];
    
    for (const meeting of response.data.data.results) {
      const track = meeting.meeting_name || meeting.course;
      
      // Process each race at this track
      for (const race of meeting.races) {
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

// Find race results for a specific track
function findTrackResults(trackName) {
  if (!todaysRaceResults || !todaysRaceResults.length) {
    return null;
  }
  
  // Clean the track name for comparison
  const cleanedTrackName = trackName.toLowerCase().trim();
  
  // Find all races for this track
  return todaysRaceResults.filter(race => {
    const raceTrackName = (race.track_name || '').toLowerCase().trim();
    return raceTrackName === cleanedTrackName || 
           raceTrackName.includes(cleanedTrackName) || 
           cleanedTrackName.includes(raceTrackName);
  });
}

// Find a horse in race results
function findHorseInResults(races, horseName) {
  console.log(`Looking for horse: ${horseName} in ${races.length} races`);
  
  const cleanedHorseName = cleanHorseName(horseName);
  
  for (const race of races) {
    for (const horse of race.results) {
      const cleanedResultHorse = cleanHorseName(horse.horse_name);
      
      // Check for exact match first
      if (cleanedResultHorse === cleanedHorseName) {
        console.log(`Found exact match for ${horseName} at position ${horse.position}`);
        return {
          ...horse,
          race_id: race.race_id,
          race_name: race.race_name,
          total_runners: race.total_runners
        };
      }
      
      // Check if result horse name contains the bet horse name
      if (cleanedResultHorse.includes(cleanedHorseName) || 
          cleanedHorseName.includes(cleanedResultHorse)) {
        console.log(`Found partial match for ${horseName} -> ${horse.horse_name} at position ${horse.position}`);
        return {
          ...horse,
          race_id: race.race_id,
          race_name: race.race_name,
          total_runners: race.total_runners
        };
      }
    }
  }
  
  console.log(`No match found for horse: ${horseName}`);
  return null;
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