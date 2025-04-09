require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');

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
  auth: { username: racingApiUsername, password: racingApiPassword }
});

// Alternative approach: Use cards endpoint with specific dates
async function updatePendingBets() {
  try {
    console.log('Starting alternative bet results update process...');
    
    // Fetch pending bets
    let { data: pendingBets, error: betsError } = await supabase
      .from('racing_bets')
      .select('*')
      .or('status.ilike.%pending%,status.ilike.%open%,status.eq.new,status.eq.,status.eq.PENDING,status.eq.Pending');
    
    if (betsError) {
      throw new Error(`Error fetching pending bets: ${betsError.message}`);
    }
    
    console.log(`Found ${pendingBets?.length || 0} pending bets to process`);
    if (!pendingBets || pendingBets.length === 0) return;
    
    // Group bets by date to minimize API calls
    const betsByDate = {};
    pendingBets.forEach(bet => {
      if (!bet.race_date) return;
      if (!betsByDate[bet.race_date]) betsByDate[bet.race_date] = [];
      betsByDate[bet.race_date].push(bet);
    });
    
    // Process each date
    const processedBets = {
      updated: 0,
      noMatch: 0,
      total: pendingBets.length
    };
    
    for (const [date, bets] of Object.entries(betsByDate)) {
      console.log(`\nProcessing bets for date: ${date}`);
      
      // Try different API endpoints for this date
      const dateResults = await fetchResultsForDate(date);
      
      if (!dateResults || !dateResults.horses || dateResults.horses.length === 0) {
        console.log(`No results found for date ${date}, skipping ${bets.length} bets`);
        processedBets.noMatch += bets.length;
        continue;
      }
      
      console.log(`Found ${dateResults.horses.length} horses for date ${date}`);
      
      // Print a few sample horses
      const sampleHorses = dateResults.horses.slice(0, 5);
      console.log('Sample horses:');
      sampleHorses.forEach(horse => {
        console.log(`- ${horse.horse_name} at ${horse.track_name}, position: ${horse.position}`);
      });
      
      // Print all track names
      const trackNames = [...new Set(dateResults.horses.map(h => h.track_name))];
      console.log(`Tracks available: ${trackNames.join(', ')}`);
      
      // Process each bet for this date
      for (const bet of bets) {
        const success = await processIndividualBet(bet, dateResults.horses);
        if (success) processedBets.updated++;
        else processedBets.noMatch++;
      }
    }
    
    console.log('\nResults Summary:');
    console.log(`- Total bets processed: ${processedBets.total}`);
    console.log(`- Successfully updated: ${processedBets.updated}`);
    console.log(`- No match found: ${processedBets.noMatch}`);
    return processedBets;
    
  } catch (error) {
    console.error('Error in alternative approach:', error);
    return { success: false, error: error.message };
  }
}

// Fetch results for a specific date using multiple API endpoints
async function fetchResultsForDate(date) {
  console.log(`Fetching results for date: ${date}`);
  
  // Format date for API (YYYY-MM-DD)
  const formattedDate = date.split('T')[0];
  
  const results = {
    horses: [],
    rawData: null
  };
  
  try {
    // First try the cards endpoint (most likely to work)
    console.log(`Trying /cards?date=${formattedDate} endpoint...`);
    const cardsResponse = await racingApi.get(`/cards?date=${formattedDate}`);
    
    // Save raw response for debugging
    results.rawData = cardsResponse.data;
    fs.writeFileSync(`cards_response_${formattedDate}.json`, JSON.stringify(cardsResponse.data, null, 2));
    
    if (cardsResponse.data?.data?.length > 0) {
      console.log(`Found ${cardsResponse.data.data.length} cards`);
      
      // Extract horses from each card
      cardsResponse.data.data.forEach(card => {
        const trackName = card.course || card.venue || 'Unknown';
        console.log(`Processing card for ${trackName}`);
        
        if (card.races && Array.isArray(card.races)) {
          card.races.forEach(race => {
            console.log(`Race: ${race.time || ''} - ${race.runners?.length || 0} runners`);
            
            if (race.runners && Array.isArray(race.runners)) {
              race.runners.forEach(runner => {
                if (runner.horse) {
                  results.horses.push({
                    horse_name: runner.horse,
                    track_name: trackName,
                    race_time: race.time || '',
                    race_date: formattedDate,
                    position: runner.position || '',
                    sp: runner.sp || runner.sp_dec || null,
                    bsp: runner.bsp || null,
                    ovr_btn: runner.ovr_btn || runner.btn || '0',
                    btn: runner.btn || '0',
                    simplified_name: runner.horse.toLowerCase().replace(/[^a-z0-9]/g, ''),
                    total_runners: race.runners.length
                  });
                }
              });
            }
          });
        }
      });
    }
    
    // If we didn't find any horses, try the today endpoint (works for current date)
    if (results.horses.length === 0) {
      const currentDate = new Date().toISOString().split('T')[0];
      if (formattedDate === currentDate) {
        console.log('Trying /results/today endpoint...');
        const todayResponse = await racingApi.get('/results/today');
        
        // Save raw response for debugging
        fs.writeFileSync(`today_response_${formattedDate}.json`, JSON.stringify(todayResponse.data, null, 2));
        
        // Extract horse data using deep recursion
        results.horses = extractHorsesDeep(todayResponse.data);
      }
    }
    
    // If we still have no horses, try the racecards pro endpoint
    if (results.horses.length === 0) {
      console.log(`Trying /pro/racecards?date=${formattedDate} endpoint...`);
      try {
        const proResponse = await racingApi.get(`/pro/racecards?date=${formattedDate}`);
        
        // Save raw response for debugging
        fs.writeFileSync(`pro_response_${formattedDate}.json`, JSON.stringify(proResponse.data, null, 2));
        
        // Extract horse data
        results.horses = extractHorsesDeep(proResponse.data);
      } catch (proError) {
        console.log(`Pro endpoint failed: ${proError.message}`);
      }
    }
    
    console.log(`Total horses found: ${results.horses.length}`);
    
    // Save extracted horses
    if (results.horses.length > 0) {
      fs.writeFileSync(`horses_${formattedDate}.json`, JSON.stringify(results.horses, null, 2));
    }
    
    return results;
    
  } catch (error) {
    console.error(`Error fetching results for date ${formattedDate}:`, error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}, Data:`, error.response.data);
    }
    return results;
  }
}

// Extract horses from any API response structure using deep recursion
function extractHorsesDeep(apiResponse) {
  const allHorses = [];
  const tracks = new Set();
  
  // Recursive function to find horses
  const findHorses = (obj, context = {}) => {
    if (!obj || typeof obj !== 'object') return;
    
    // Update context with track/race info
    if (obj.meeting_name) context.track = obj.meeting_name;
    if (obj.course) context.track = obj.course;
    if (obj.venue) context.track = obj.venue;
    if (obj.time) context.time = obj.time;
    if (obj.race_time) context.time = obj.race_time;
    if (obj.race_id) context.race_id = obj.race_id;
    if (obj.race_name) context.race_name = obj.race_name;
    if (obj.runners?.length) context.total_runners = obj.runners.length;
    if (obj.results?.length) context.total_runners = obj.results.length;
    
    // Check if this object is a horse/runner
    if ((obj.horse || obj.name) && (obj.position || obj.finish_position)) {
      const trackName = context.track || 'Unknown';
      tracks.add(trackName);
      
      allHorses.push({
        horse_name: obj.horse || obj.name,
        track_name: trackName,
        position: obj.position || obj.finish_position,
        sp: obj.sp_dec || obj.sp || null,
        bsp: obj.bsp || null,
        ovr_btn: obj.ovr_btn || obj.btn || '0',
        btn: obj.btn || '0',
        race_time: context.time || '',
        race_id: context.race_id || '',
        race_name: context.race_name || '',
        total_runners: context.total_runners || 0,
        simplified_name: (obj.horse || obj.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      });
      return;
    }
    
    // Process arrays
    if (Array.isArray(obj)) {
      obj.forEach(item => findHorses(item, {...context}));
      return;
    }
    
    // Process object properties
    for (const [key, value] of Object.entries(obj)) {
      findHorses(value, {...context});
    }
  };
  
  findHorses(apiResponse);
  
  if (tracks.size > 0) {
    console.log(`Found horses at ${tracks.size} tracks: ${[...tracks].join(', ')}`);
  }
  
  return allHorses;
}

// Process an individual bet against horse results
async function processIndividualBet(bet, horses) {
  console.log(`\nProcessing bet ID: ${bet.id}`);
  console.log(`Horse: ${bet.horse_name}, Track: ${bet.track_name}, Date: ${bet.race_date}`);
  
  // Check if this is a multiple bet
  if (bet.horse_name && bet.horse_name.includes('/')) {
    return await processMultipleBet(bet, horses);
  } else {
    return await processSingleBet(bet, horses);
  }
}

// Process a single bet
async function processSingleBet(bet, horses) {
  if (!bet.horse_name) {
    console.log(`Skipping bet ID ${bet.id} - missing horse name`);
    return false;
  }
  
  // Find horse in results
  const horseResult = findBestMatch(bet.horse_name, bet.track_name, horses);
  
  if (!horseResult) {
    console.log(`No match found for ${bet.horse_name} at ${bet.track_name}`);
    return false;
  }
  
  console.log(`MATCH FOUND: ${bet.horse_name} → ${horseResult.horse_name} (Position: ${horseResult.position})`);
  
  // Calculate returns
  const numRunners = parseInt(horseResult.total_runners) || 0;
  const betType = bet.each_way === true ? 'each-way' : (bet.bet_type || 'win');
  const betResult = determineBetResult(horseResult, betType, numRunners);
  
  // Calculate bet returns
  const returns = calculateReturns(bet, betResult, horseResult, numRunners);
  
  // Map betResult to status
  let status = 'Pending';
  if (betResult === 'win' || betResult === 'win-place') status = 'Won';
  else if (betResult === 'place') status = 'Placed';
  else if (betResult === 'loss') status = 'Lost';
  else if (betResult === 'void') status = 'Void';
  
  // Calculate profit/loss
  const profitLoss = returns - bet.stake;
  
  // Convert ovr_btn to numeric
  const numericOvrBtn = extractNumericValue(horseResult.ovr_btn);
  
  // Update bet in Supabase
  const { error } = await supabase
    .from('racing_bets')
    .update({
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      sp_industry: horseResult.sp || null,
      ovr_btn: numericOvrBtn, // Store as numeric
      closing_line_value: calculateCLV(bet, horseResult),
      clv_stake: calculateCLVStake(bet, horseResult),
      fin_pos: horseResult.position || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (error) {
    console.error(`Error updating bet ID ${bet.id}:`, error.message);
    return false;
  }
  
  console.log(`Successfully updated bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
  return true;
}

// Process a multiple bet
async function processMultipleBet(bet, horses) {
  const selections = bet.horse_name.split('/').map(s => s.trim());
  const trackNames = bet.track_name ? bet.track_name.split('/').map(t => t.trim()) : [];
  
  console.log(`Processing multiple bet with ${selections.length} selections: ${selections.join(', ')}`);
  
  // Find all horses in results
  const horseResults = [];
  
  for (let i = 0; i < selections.length; i++) {
    const trackName = trackNames[i] || trackNames[0] || '';
    const horseResult = findBestMatch(selections[i], trackName, horses);
    
    if (!horseResult) {
      console.log(`No match found for ${selections[i]} at ${trackName || 'any track'}`);
      return false;
    }
    
    horseResults.push(horseResult);
  }
  
  console.log(`Found all ${selections.length} horses in multiple bet`);
  
  // Check if all horses won
  const allWon = horseResults.every(hr => parseInt(hr.position) === 1);
  
  // Format data for update
  const positionsFormatted = horseResults.map(hr => hr.position).join(' / ');
  const ovrBtnFormatted = horseResults.map(hr => extractNumericValue(hr.ovr_btn) || '0').join(' / ');
  const spFormatted = horseResults.map(hr => hr.sp || '0').join(' / ');
  
  // Calculate combined BSP
  let combinedBSP = 1;
  let allHaveBSP = true;
  
  for (const hr of horseResults) {
    if (!hr.bsp || hr.bsp <= 0) {
      allHaveBSP = false;
      break;
    }
    combinedBSP *= parseFloat(hr.bsp);
  }
  
  if (!allHaveBSP) combinedBSP = null;
  
  // Determine bet result
  let status = 'Lost';
  if ((bet.bet_type === 'win' || !bet.bet_type) && allWon) status = 'Won';
  
  // Calculate returns
  const returns = status === 'Won' ? bet.stake * bet.odds : 0;
  const profitLoss = returns - bet.stake;
  
  // Update bet in Supabase
  const { error } = await supabase
    .from('racing_bets')
    .update({
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      sp_industry: spFormatted,
      ovr_btn: ovrBtnFormatted,
      closing_line_value: allHaveBSP ? calculateCLVForMultiple(bet, combinedBSP) : null,
      clv_stake: allHaveBSP ? calculateCLVStakeForMultiple(bet, combinedBSP) : null,
      fin_pos: positionsFormatted,
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (error) {
    console.error(`Error updating multiple bet ID ${bet.id}:`, error.message);
    return false;
  }
  
  console.log(`Successfully updated multiple bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
  return true;
}

// Find the best match for a horse at a track
function findBestMatch(horseName, trackName, horses) {
  if (!horseName) return null;
  
  const cleanHorse = cleanHorseName(horseName);
  const cleanTrack = cleanHorseName(trackName || '');
  const simplifiedHorse = simplifyHorseName(horseName);
  
  console.log(`Looking for horse: "${cleanHorse}" at track: "${cleanTrack}"`);
  
  // Try exact match
  const exactMatch = horses.find(h => 
    cleanHorseName(h.horse_name) === cleanHorse && 
    (cleanTrack ? cleanHorseName(h.track_name) === cleanTrack : true)
  );
  
  if (exactMatch) return exactMatch;
  
  // Try track + similar name
  if (cleanTrack) {
    const trackMatches = horses.filter(h => 
      isSimilarTrack(h.track_name, trackName)
    );
    
    if (trackMatches.length > 0) {
      // Try simplified name
      const simplifiedMatch = trackMatches.find(h => 
        h.simplified_name === simplifiedHorse
      );
      
      if (simplifiedMatch) return simplifiedMatch;
      
      // Try partial name match
      const partialMatch = trackMatches.find(h => 
        cleanHorseName(h.horse_name).includes(cleanHorse) || 
        cleanHorse.includes(cleanHorseName(h.horse_name))
      );
      
      if (partialMatch) return partialMatch;
      
      // Try fuzzy match
      const fuzzyMatch = findFuzzyMatch(cleanHorse, trackMatches);
      if (fuzzyMatch) return fuzzyMatch;
      
      // Show horses at this track
      console.log(`Horses at track ${cleanTrack} (showing first 10):`);
      trackMatches.slice(0, 10).forEach(h => {
        console.log(`- ${h.horse_name} (position: ${h.position})`);
      });
    }
  }
  
  // Last resort - just try by horse name
  const nameMatch = horses.find(h => 
    cleanHorseName(h.horse_name) === cleanHorse || 
    h.simplified_name === simplifiedHorse
  );
  
  if (nameMatch) return nameMatch;
  
  console.log(`No match found for ${horseName}`);
  return null;
}

// Helper for finding fuzzy matches
function findFuzzyMatch(horseName, horses) {
  // Try matching on first 3 letters
  if (horseName.length >= 3) {
    const prefix = horseName.substring(0, 3);
    const prefixMatch = horses.find(h => 
      cleanHorseName(h.horse_name).startsWith(prefix)
    );
    if (prefixMatch) return prefixMatch;
  }
  
  // Levenshtein distance calculation for fuzzy matching
  function levenshtein(a, b) {
    const matrix = [];
    
    // Initialize matrix
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    
    // Fill matrix
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = a[j-1] === b[i-1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i-1][j] + 1,      // deletion
          matrix[i][j-1] + 1,      // insertion
          matrix[i-1][j-1] + cost  // substitution
        );
      }
    }
    
    return matrix[b.length][a.length];
  }
  
  // Find closest match using Levenshtein distance
  let bestMatch = null;
  let bestDistance = Infinity;
  
  for (const horse of horses) {
    const distance = levenshtein(horseName, cleanHorseName(horse.horse_name));
    
    // Consider good match if distance is less than 30% of name length
    const threshold = Math.max(3, Math.floor(horseName.length * 0.3));
    
    if (distance < threshold && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = horse;
    }
  }
  
  return bestMatch;
}

// Check if two track names are similar
function isSimilarTrack(track1, track2) {
  if (!track1 || !track2) return false;
  
  const clean1 = cleanHorseName(track1);
  const clean2 = cleanHorseName(track2);
  
  // Exact match
  if (clean1 === clean2) return true;
  
  // Partial match
  if (clean1.includes(clean2) || clean2.includes(clean1)) return true;
  
  // Split track names and check parts
  const parts1 = clean1.split(/[ -]/);
  const parts2 = clean2.split(/[ -]/);
  
  // Check if any part matches
  for (const part1 of parts1) {
    if (part1.length > 3) { // Only check significant parts
      for (const part2 of parts2) {
        if (part2.length > 3 && part1 === part2) return true;
      }
    }
  }
  
  return false;
}

// Helper functions
function cleanHorseName(name) {
  if (!name) return '';
  return name.replace(/\([A-Z]{2,3}\)$/g, '').toLowerCase().trim();
}

function simplifyHorseName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractNumericValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const numericStr = value.replace(/[^0-9.]/g, '');
    if (numericStr === '') return 0;
    return parseFloat(numericStr);
  }
  return null;
}

// Determine bet result (win, place, loss)
function determineBetResult(horseResult, betType, numRunners) {
  if (!horseResult || !horseResult.position) return null;
  
  const position = parseInt(horseResult.position, 10);
  if (isNaN(position)) return 'void';
  
  // Win bet logic
  if (betType === 'win' || betType === 'single') {
    return position === 1 ? 'win' : 'loss';
  }
  
  // Place bet logic
  if (betType === 'place') {
    if (numRunners <= 7) return position <= 2 ? 'place' : 'loss';
    if (numRunners <= 12) return position <= 3 ? 'place' : 'loss';
    if (numRunners <= 19) return position <= 4 ? 'place' : 'loss';
    return position <= 5 ? 'place' : 'loss';
  }
  
  // Each-way bet logic
  if (betType === 'each-way') {
    if (position === 1) return 'win-place';
    if ((numRunners <= 7 && position <= 2) ||
        (numRunners <= 12 && position <= 3) ||
        (numRunners <= 19 && position <= 4) ||
        (numRunners >= 20 && position <= 5)) {
      return 'place';
    }
    return 'loss';
  }
  
  return null;
}

// Calculate returns based on bet result
function calculateReturns(bet, result, horseResult, numRunners) {
  if (!result || result === 'loss' || result === 'void') return 0;
  
  const isEachWay = bet.each_way === true;
  
  // Win bets
  if ((bet.bet_type === 'win' || bet.bet_type === 'single' || !bet.bet_type) && result === 'win') {
    return bet.stake * bet.odds;
  }
  
  // Place bets
  if (bet.bet_type === 'place' && result === 'place') {
    let placeOdds;
    
    if (numRunners <= 7) placeOdds = (bet.odds - 1) / 4 + 1;
    else if (numRunners <= 12) placeOdds = (bet.odds - 1) / 5 + 1;
    else if (numRunners <= 19) placeOdds = (bet.odds - 1) / 5 + 1;
    else placeOdds = (bet.odds - 1) / 6 + 1;
    
    return bet.stake * placeOdds;
  }
  
  // Each-way bets
  if (isEachWay) {
    let returns = 0;
    let placeOdds;
    
    if (numRunners <= 7) placeOdds = (bet.odds - 1) / 4 + 1;
    else if (numRunners <= 12) placeOdds = (bet.odds - 1) / 5 + 1;
    else if (numRunners <= 19) placeOdds = (bet.odds - 1) / 5 + 1;
    else placeOdds = (bet.odds - 1) / 6 + 1;
    
    if (result === 'win-place') {
      returns += (bet.stake / 2) * bet.odds; // Win part
      returns += (bet.stake / 2) * placeOdds; // Place part
    } else if (result === 'place') {
      returns += (bet.stake / 2) * placeOdds; // Only place part wins
    }
    
    return returns;
  }
  
  return 0;
}

// Calculate CLV
function calculateCLV(bet, horseResult) {
  if (!horseResult.bsp || horseResult.bsp <= 0) return null;
  
  const bspOdds = parseFloat(horseResult.bsp);
  const betOdds = parseFloat(bet.odds);
  
  if (isNaN(bspOdds) || isNaN(betOdds)) return null;
  
  const clv = (betOdds / bspOdds - 1) * 100;
  return Math.round(clv * 100) / 100;
}

// Calculate CLV Stake
function calculateCLVStake(bet, horseResult) {
  const clv = calculateCLV(bet, horseResult);
  if (clv === null) return null;
  
  return Math.round((clv * bet.stake / 100) * 100) / 100;
}

// Multiple bet CLV
function calculateCLVForMultiple(bet, combinedBSP) {
  if (!combinedBSP || combinedBSP <= 0) return null;
  
  const betOdds = parseFloat(bet.odds);
  if (isNaN(betOdds)) return null;
  
  const clv = (betOdds / combinedBSP - 1) * 100;
  return Math.round(clv * 100) / 100;
}

// Multiple bet CLV Stake
function calculateCLVStakeForMultiple(bet, combinedBSP) {
  const clv = calculateCLVForMultiple(bet, combinedBSP);
  if (clv === null) return null;
  
  return Math.round((clv * bet.stake / 100) * 100) / 100;
}

// Run the main function
if (require.main === module) {
  updatePendingBets()
    .then(result => {
      console.log('Alternative approach completed:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('Error in alternative approach:', error);
      process.exit(1);
    });
}

module.exports = { updatePendingBets };