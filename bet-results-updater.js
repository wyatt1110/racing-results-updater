// bet-results-updater.js
require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// API credentials
const RACING_API_USERNAME = process.env.RACING_API_USERNAME || 'KQ9W7rQeAHWMUgxH93ie3yEc';
const RACING_API_PASSWORD = process.env.RACING_API_PASSWORD || 'T5BoPivL3Q2h6RhCdLv4EwZu';
const API_BASE_URL = 'https://api.theracingapi.com/v1';

// Supabase connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function updateBetResults() {
  try {
    console.log('Starting bet results update process...');
    const today = new Date().toISOString().split('T')[0];
    
    // Fetch today's race results from the API
    console.log(`Fetching race results for ${today}...`);
    const raceResults = await fetchRaceResults(today);
    
    if (!raceResults || !raceResults.results || raceResults.results.length === 0) {
      console.log('No race results found for today.');
      return;
    }
    
    console.log(`Found ${raceResults.results.length} races with results.`);
    
    // Get pending bets from Supabase
    const { data: pendingBets, error } = await supabase
      .from('racing_bets')
      .select('*')
      .eq('status', 'pending');
    
    if (error) {
      throw new Error(`Error fetching pending bets: ${error.message}`);
    }
    
    if (!pendingBets || pendingBets.length === 0) {
      console.log('No pending bets found to update.');
      return;
    }
    
    console.log(`Found ${pendingBets.length} pending bets to process.`);
    
    // Process each pending bet
    for (const bet of pendingBets) {
      await processBet(bet, raceResults.results);
    }
    
    console.log('Bet update process completed.');
  } catch (error) {
    console.error('Error updating bet results:', error);
  }
}

async function fetchRaceResults(date) {
  try {
    console.log(`Making API request to fetch results for date: ${date}`);
    
    const response = await axios({
      method: 'get',
      url: `${API_BASE_URL}/results`,
      params: {
        start_date: date,
        end_date: date
      },
      auth: {
        username: RACING_API_USERNAME,
        password: RACING_API_PASSWORD
      },
      timeout: 15000
    });
    
    console.log(`Successfully retrieved results API data with status: ${response.status}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching race results:', error.message);
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', error.response.data);
    }
    throw error;
  }
}

async function processBet(bet, races) {
  console.log(`Processing bet ID ${bet.id} for horse "${bet.horse_name}" at ${bet.track_name} on race date ${bet.race_date}`);
  
  // Find matching race and horse
  const matchResult = findHorseInRaces(bet, races);
  
  if (!matchResult) {
    console.log(`No match found for horse "${bet.horse_name}" at ${bet.track_name}`);
    return;
  }
  
  const { race, runner } = matchResult;
  console.log(`Match found! Horse "${runner.horse}" finished in position ${runner.position} in race: ${race.race_name}`);
  
  // Calculate new status and returns
  const updateData = calculateBetOutcome(bet, race, runner);
  
  // Update the bet in Supabase
  const { error } = await supabase
    .from('racing_bets')
    .update(updateData)
    .eq('id', bet.id);
  
  if (error) {
    console.error(`Error updating bet ID ${bet.id}:`, error);
    return;
  }
  
  console.log(`Successfully updated bet ID ${bet.id} to status: ${updateData.status}, fin_pos: ${updateData.fin_pos}, returns: ${updateData.returns}`);
}

function findHorseInRaces(bet, races) {
  // First try to match race by track name
  const potentialRaces = races.filter(race => {
    return race.course.toLowerCase().includes(bet.track_name.toLowerCase()) ||
           bet.track_name.toLowerCase().includes(race.course.toLowerCase());
  });
  
  if (potentialRaces.length === 0) {
    console.log(`No races found matching track name: ${bet.track_name}`);
    return null;
  }
  
  console.log(`Found ${potentialRaces.length} potential races at ${bet.track_name}`);
  
  // Now look for the horse within the matching races
  for (const race of potentialRaces) {
    const cleanBetHorseName = cleanHorseName(bet.horse_name);
    
    // Try exact match first (case-insensitive)
    for (const runner of race.runners) {
      const cleanRunnerHorseName = cleanHorseName(runner.horse);
      
      if (cleanRunnerHorseName === cleanBetHorseName) {
        console.log(`Exact match found for "${bet.horse_name}" as "${runner.horse}"`);
        return { race, runner };
      }
    }
    
    // If no exact match, try substring matching
    for (const runner of race.runners) {
      const cleanRunnerHorseName = cleanHorseName(runner.horse);
      
      if (cleanRunnerHorseName.includes(cleanBetHorseName) || 
          cleanBetHorseName.includes(cleanRunnerHorseName)) {
        console.log(`Partial match found for "${bet.horse_name}" as "${runner.horse}"`);
        return { race, runner };
      }
    }
  }
  
  console.log(`No matching horse found for "${bet.horse_name}" in any of the races`);
  return null;
}

function cleanHorseName(name) {
  if (!name) return '';
  
  return name.toLowerCase()
    .replace(/\([^)]*\)/g, '') // Remove anything in parentheses (like country codes)
    .replace(/[^\w\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

function calculateBetOutcome(bet, race, runner) {
  const position = parseInt(runner.position);
  const fieldSize = race.runners.length;
  const isEachWay = bet.e_w === true;
  const updateData = {
    fin_pos: position,
    ovr_btn: parseFloat(runner.ovr_btn) || 0,
    sp_industry: parseFloat(runner.sp_dec) || 0
  };
  
  // Calculate bet status
  if (position === 1) {
    updateData.status = 'won';
  } else if (!isEachWay) {
    updateData.status = 'lost';
  } else {
    // Check if it's a place - depends on field size
    if ((fieldSize <= 7 && position <= 2) || (fieldSize >= 8 && position <= 3)) {
      updateData.status = 'placed';
    } else {
      updateData.status = 'lost';
    }
  }
  
  // Calculate returns and profit/loss
  const odds = parseFloat(bet.odds);
  const stake = parseFloat(bet.stake);
  
  if (updateData.status === 'won') {
    if (isEachWay) {
      // Win part + place part
      const winHalf = stake / 2 * (odds + 1);
      const placeOdds = fieldSize <= 7 ? (odds / 4) + 1 : (odds / 5) + 1;
      const placeHalf = stake / 2 * placeOdds;
      updateData.returns = winHalf + placeHalf;
    } else {
      updateData.returns = stake * (odds + 1);
    }
  } else if (updateData.status === 'placed') {
    // Only place part pays
    const placeOdds = fieldSize <= 7 ? (odds / 4) + 1 : (odds / 5) + 1;
    updateData.returns = stake / 2 * placeOdds;
  } else {
    updateData.returns = 0;
  }
  
  updateData.profit_loss = updateData.returns - stake;
  
  console.log(`Calculated outcome for bet ID ${bet.id}:`, {
    position,
    fieldSize,
    isEachWay,
    status: updateData.status,
    returns: updateData.returns,
    profit_loss: updateData.profit_loss
  });
  
  return updateData;
}

// Run the script if executed directly
if (require.main === module) {
  updateBetResults()
    .then(() => console.log('Script execution completed successfully'))
    .catch(err => {
      console.error('Script execution failed:', err);
      process.exit(1);
    });
}

module.exports = { updateBetResults };