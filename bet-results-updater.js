require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const racingApiUsername = process.env.RACING_API_USERNAME;
const racingApiPassword = process.env.RACING_API_PASSWORD;
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

// Main function to update bet results
async function updateBetResults() {
  console.log('Starting bet results update process...');
  
  try {
    // Fetch unprocessed bets from Supabase
    const { data: pendingBets, error: betsError } = await supabase
      .from('bets')
      .select('*')
      .is('result', null)
      .eq('settled', true);
    
    if (betsError) {
      throw new Error(`Error fetching pending bets: ${betsError.message}`);
    }
    
    console.log(`Found ${pendingBets.length} pending bets to process`);
    
    // Process each pending bet
    let updatedCount = 0;
    
    for (const bet of pendingBets) {
      try {
        console.log(`Processing bet ID: ${bet.id} for horse: ${bet.selection}`);
        
        // Fetch race results for the bet's date and track
        const results = await fetchRaceResults(bet.date, bet.track);
        
        if (!results || !results.length) {
          console.log(`No results found for ${bet.track} on ${bet.date}`);
          continue;
        }
        
        // Find the horse in the results
        const horseResult = findHorseInResults(results, bet.selection);
        
        if (!horseResult) {
          console.log(`Horse ${bet.selection} not found in results for ${bet.track} on ${bet.date}`);
          continue;
        }
        
        // Determine bet result (win, place, loss)
        const betResult = determineBetResult(horseResult, bet.bet_type);
        
        // Calculate bet returns based on result
        const returns = calculateReturns(bet, betResult, horseResult);
        
        // Update the bet in Supabase
        const { error: updateError } = await supabase
          .from('bets')
          .update({
            result: betResult,
            returns: returns,
            bsp: horseResult.bsp || null,
            clv: calculateCLV(bet, horseResult),
            clv_stake: calculateCLVStake(bet, horseResult),
            finishing_position: horseResult.position || null,
            updated_at: new Date().toISOString()
          })
          .eq('id', bet.id);
        
        if (updateError) {
          throw new Error(`Error updating bet ID ${bet.id}: ${updateError.message}`);
        }
        
        console.log(`Successfully updated bet ID: ${bet.id}, Result: ${betResult}, Returns: ${returns}`);
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

// Fetch race results from Racing API
async function fetchRaceResults(date, track) {
  try {
    console.log(`Fetching results for ${track} on ${date}`);
    
    // Format date for API request
    const formattedDate = standardizeDate(date);
    
    // Get racecards for the date range
    const cardsResponse = await racingApi.get('/racecards', {
      params: { 
        start_date: formattedDate,
        end_date: formattedDate
      }
    });
    
    if (!cardsResponse.data || !cardsResponse.data.data) {
      console.log(`No race cards found for ${formattedDate}`);
      return null;
    }
    
    // Find the specific track
    const trackCard = cardsResponse.data.data.find(card => 
      card.meeting && card.meeting.name && 
      card.meeting.name.toLowerCase() === track.toLowerCase()
    );
    
    if (!trackCard) {
      console.log(`No card found for ${track} on ${formattedDate}`);
      return null;
    }
    
    // Get detailed race results
    const races = [];
    
    for (const race of trackCard.races) {
      try {
        const raceResponse = await racingApi.get(`/race/${race.id}/result`);
        
        if (raceResponse.data && raceResponse.data.data) {
          races.push({
            race_id: race.id,
            race_name: race.name,
            time: race.time,
            results: raceResponse.data.data.runners.map(runner => ({
              horse_name: runner.name,
              position: runner.position,
              bsp: runner.bsp || null,
              sp: runner.sp || null
            }))
          });
        }
      } catch (raceError) {
        console.error(`Error fetching results for race ${race.id}:`, raceError.message);
      }
    }
    
    return races;
  } catch (error) {
    console.error(`Error fetching race results:`, error.message);
    return null;
  }
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
          race_name: race.race_name
        };
      }
      
      // Check if result horse name contains the bet horse name
      if (cleanedResultHorse.includes(cleanedHorseName) || 
          cleanedHorseName.includes(cleanedResultHorse)) {
        console.log(`Found partial match for ${horseName} -> ${horse.horse_name} at position ${horse.position}`);
        return {
          ...horse,
          race_id: race.race_id,
          race_name: race.race_name
        };
      }
    }
  }
  
  console.log(`No match found for horse: ${horseName}`);
  return null;
}

// Determine bet result (win, place, loss)
function determineBetResult(horseResult, betType) {
  if (!horseResult || !horseResult.position) {
    return null;
  }
  
  const position = parseInt(horseResult.position, 10);
  
  if (isNaN(position)) {
    return 'void'; // Non-runner or void race
  }
  
  if (betType === 'win') {
    return position === 1 ? 'win' : 'loss';
  } else if (betType === 'place') {
    // Typically places are 1-2-3, but can be adjusted based on field size
    return position <= 3 ? 'place' : 'loss';
  } else if (betType === 'each-way') {
    if (position === 1) {
      return 'win-place';
    } else if (position <= 3) {
      return 'place';
    } else {
      return 'loss';
    }
  }
  
  return null;
}

// Calculate returns based on bet result
function calculateReturns(bet, result, horseResult) {
  if (!result || result === 'loss' || result === 'void') {
    return 0;
  }
  
  // For win bets
  if (bet.bet_type === 'win' && result === 'win') {
    return bet.stake * bet.odds;
  }
  
  // For place bets
  if (bet.bet_type === 'place' && result === 'place') {
    // Typically place odds are 1/4 or 1/5 of win odds for 3 places
    const placeOdds = (bet.odds - 1) / 4 + 1;
    return bet.stake * placeOdds;
  }
  
  // For each-way bets
  if (bet.bet_type === 'each-way') {
    let returns = 0;
    const placeOdds = (bet.odds - 1) / 4 + 1;
    
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