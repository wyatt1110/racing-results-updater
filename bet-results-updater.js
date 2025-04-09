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
    
    // Now instead of trying to extract races from the API directly, let's first fetch individual
    // race results for each pending bet - this guarantees we get the data we need
    const pendingBetTracks = [...new Set(pendingBets.map(bet => {
      // Handle multiple bets with track names separated by slashes
      if (bet.track_name && bet.track_name.includes('/')) {
        return bet.track_name.split('/').map(t => t.trim());
      }
      return bet.track_name;
    }).flat().filter(Boolean))];
    
    console.log(`Unique tracks to query: ${pendingBetTracks.join(', ')}`);
    
    // Fetch race results for each track
    const horsesData = await fetchRaceResultsByTracks(pendingBetTracks);
    
    if (Object.keys(horsesData.horses).length === 0) {
      console.log('No horse data found for any track, nothing to update');
      return { success: true, updated: 0, total: pendingBets.length };
    }
    
    console.log(`Retrieved data for ${Object.keys(horsesData.horses).length} horses at ${Object.keys(horsesData.tracks).length} tracks`);
    
    // Process each pending bet
    let updatedCount = 0;
    let foundMatchCount = 0;
    let noMatchCount = 0;
    let errorCount = 0;
    
    // Log which tracks we have data for
    console.log(`Available tracks in results: ${Object.keys(horsesData.tracks).sort().join(', ')}`);
    
    for (const bet of pendingBets) {
      try {
        console.log(`\nProcessing bet ID: ${bet.id}`);
        console.log(`Horse: ${bet.horse_name || 'N/A'}, Track: ${bet.track_name || 'N/A'}`);
        
        // Check if this is a multiple bet (contains '/' in horse_name)
        if (bet.horse_name && bet.horse_name.includes('/')) {
          const matchFound = await processMultipleBet(bet, horsesData);
          if (matchFound) {
            updatedCount++;
            foundMatchCount++;
          } else {
            noMatchCount++;
          }
        } else {
          const matchFound = await processSingleBet(bet, horsesData);
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

// Fetch race results by tracks
async function fetchRaceResultsByTracks(trackNames) {
  try {
    console.log('Fetching all race results...');
    
    // Make the API call to get all results for today
    const response = await racingApi.get('/results/today');
    
    // Save the raw response for debugging
    try {
      fs.writeFileSync('results_raw_response.json', JSON.stringify(response.data, null, 2));
      console.log('Saved raw API response to results_raw_response.json');
    } catch (writeError) {
      console.log('Could not save response to file:', writeError.message);
    }
    
    // Initialize data structure to hold processed results
    const processedData = {
      tracks: {},
      horses: {}
    };
    
    // Check if we have valid data
    if (!response.data || !response.data.results || !Array.isArray(response.data.results)) {
      console.log('Invalid API response format: missing results array');
      console.log('Response structure:', JSON.stringify(Object.keys(response.data || {})));
      return processedData;
    }
    
    console.log(`API returned ${response.data.results.length} items in results array`);
    
    // Save a sample meeting structure for debugging
    const sampleMeeting = response.data.results[0];
    if (sampleMeeting) {
      try {
        fs.writeFileSync('sample_meeting.json', JSON.stringify(sampleMeeting, null, 2));
        console.log('Saved sample meeting structure to sample_meeting.json');
      } catch (writeError) {
        console.log('Could not save sample meeting to file:', writeError.message);
      }
    }
    
    // Deep function to recursively find all runners in the API response
    function findAllRunners(obj, parentPath = '', trackName = null) {
      // Base case: if not an object or array, return
      if (!obj || typeof obj !== 'object') return;
      
      // If this is an array, iterate through each item
      if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
          findAllRunners(item, `${parentPath}[${index}]`, trackName);
        });
        return;
      }
      
      // Check if this might be a track/meeting object
      if (obj.meeting_name || obj.course) {
        trackName = obj.meeting_name || obj.course;
        console.log(`Found potential track: ${trackName} at ${parentPath}`);
      }
      
      // Check if this might be a runner object
      if (obj.horse || obj.name) {
        const horseName = obj.horse || obj.name;
        if (horseName && obj.position) {
          console.log(`Found runner: ${horseName}, position: ${obj.position} at ${parentPath}`);
          
          // Try to determine the race this belongs to
          let raceObj = null;
          let trackObj = null;
          
          // Go up the parent chain to find race and track
          const pathParts = parentPath.split('.');
          
          // Work backwards from current path to find parent race and track
          let currentObj = response.data;
          for (let i = 0; i < pathParts.length - 1; i++) {
            const part = pathParts[i];
            const match = part.match(/\[(\d+)\]/);
            if (match) {
              const index = parseInt(match[1]);
              currentObj = currentObj[index];
            } else {
              currentObj = currentObj[part];
            }
            
            // Check if this might be a race
            if (currentObj && (currentObj.race_id || currentObj.race_name || currentObj.time)) {
              raceObj = currentObj;
            }
            
            // Check if this might be a track
            if (currentObj && (currentObj.meeting_name || currentObj.course)) {
              trackObj = currentObj;
            }
          }
          
          const track = trackName || (trackObj ? (trackObj.meeting_name || trackObj.course) : 'unknown');
          const cleanTrack = cleanHorseName(track);
          
          // Only process if we're interested in this track
          if (trackNames.some(t => {
            const cleanT = cleanHorseName(t);
            return cleanT === cleanTrack || 
                   cleanT.includes(cleanTrack) || 
                   cleanTrack.includes(cleanT);
          })) {
            // Initialize track if not exists
            if (!processedData.tracks[cleanTrack]) {
              processedData.tracks[cleanTrack] = {
                name: track,
                races: {}
              };
            }
            
            // Determine race details
            const raceId = raceObj ? (raceObj.race_id || raceObj.id || '') : '';
            const raceTime = raceObj ? (raceObj.time || '') : '';
            const raceName = raceObj ? (raceObj.race_name || raceObj.name || '') : '';
            
            // Initialize race if not exists
            if (raceId && !processedData.tracks[cleanTrack].races[raceId]) {
              processedData.tracks[cleanTrack].races[raceId] = {
                id: raceId,
                time: raceTime,
                name: raceName,
                runners: []
              };
            }
            
            // Add horse to race if we have valid race info
            if (raceId) {
              const horseData = {
                name: horseName,
                position: obj.position || '',
                bsp: obj.bsp || null,
                sp: obj.sp_dec || obj.sp || null
              };
              
              processedData.tracks[cleanTrack].races[raceId].runners.push(horseData);
              
              // Also add to flat horses lookup for easier access
              const cleanHorse = cleanHorseName(horseName);
              processedData.horses[cleanHorse] = {
                ...horseData,
                track_name: track,
                race_id: raceId,
                race_time: raceTime,
                race_name: raceName
              };
            }
          }
        }
      }
      
      // Recursively process all properties
      for (const key in obj) {
        findAllRunners(obj[key], parentPath ? `${parentPath}.${key}` : key, trackName);
      }
    }
    
    // Start the recursive search from the results array
    findAllRunners(response.data.results, 'results');
    
    // Log what we found
    console.log(`Extracted data for ${Object.keys(processedData.tracks).length} tracks`);
    for (const [trackName, trackData] of Object.entries(processedData.tracks)) {
      console.log(`- ${trackData.name}: ${Object.keys(trackData.races).length} races`);
      for (const [raceId, raceData] of Object.entries(trackData.races)) {
        console.log(`  - Race at ${raceData.time}: ${raceData.runners.length} runners`);
      }
    }
    
    // Save the processed data
    try {
      fs.writeFileSync('processed_races.json', JSON.stringify(processedData, null, 2));
      console.log('Saved processed race data to processed_races.json');
    } catch (writeError) {
      console.log('Could not save processed data to file:', writeError.message);
    }
    
    return processedData;
  } catch (error) {
    console.error('Error fetching race results:', error.message);
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data excerpt:', JSON.stringify(error.response.data || {}).substring(0, 200) + '...');
    }
    return { tracks: {}, horses: {} };
  }
}

// Find a horse in the results data
function findHorseInResults(horsesData, horseName, trackName) {
  if (!horseName) return null;
  
  const cleanTrack = cleanHorseName(trackName || '');
  const cleanHorse = cleanHorseName(horseName);
  
  console.log(`Looking for horse: "${cleanHorse}" at track: "${cleanTrack}"`);
  
  // First check if we have an exact match in our horses object
  if (horsesData.horses[cleanHorse]) {
    const horse = horsesData.horses[cleanHorse];
    // Verify track matches if specified
    if (!cleanTrack || 
        cleanHorseName(horse.track_name) === cleanTrack || 
        cleanHorseName(horse.track_name).includes(cleanTrack) || 
        cleanTrack.includes(cleanHorseName(horse.track_name))) {
      console.log(`MATCH FOUND: Exact match for "${horseName}" at ${horse.track_name}, position: ${horse.position}`);
      return horse;
    }
  }
  
  // Check for partial horse name matches
  for (const [horseKey, horse] of Object.entries(horsesData.horses)) {
    if (horseKey.includes(cleanHorse) || cleanHorse.includes(horseKey)) {
      // Verify track matches if specified
      if (!cleanTrack || 
          cleanHorseName(horse.track_name) === cleanTrack || 
          cleanHorseName(horse.track_name).includes(cleanTrack) || 
          cleanTrack.includes(cleanHorseName(horse.track_name))) {
        console.log(`MATCH FOUND: Partial match for "${horseName}" -> "${horse.name}" at ${horse.track_name}, position: ${horse.position}`);
        return horse;
      }
    }
  }
  
  // If we have a track specified, look at all runners in races at that track
  if (cleanTrack) {
    // Find matching track
    const matchingTrack = Object.keys(horsesData.tracks).find(trackKey => 
      trackKey === cleanTrack || 
      trackKey.includes(cleanTrack) || 
      cleanTrack.includes(trackKey)
    );
    
    if (matchingTrack) {
      console.log(`Looking for ${horseName} in all races at ${horsesData.tracks[matchingTrack].name}`);
      
      // Check all races at this track
      for (const [raceId, race] of Object.entries(horsesData.tracks[matchingTrack].races)) {
        // Check all runners in this race
        for (const runner of race.runners) {
          const runnerName = cleanHorseName(runner.name);
          if (runnerName === cleanHorse || runnerName.includes(cleanHorse) || cleanHorse.includes(runnerName)) {
            console.log(`MATCH FOUND: ${runner.name} at ${horsesData.tracks[matchingTrack].name} in race at ${race.time}, position: ${runner.position}`);
            return {
              ...runner,
              track_name: horsesData.tracks[matchingTrack].name,
              race_id: raceId,
              race_time: race.time,
              race_name: race.name
            };
          }
        }
      }
      
      // If we got here, list all horses at this track for debugging
      console.log(`No match found. All runners at ${horsesData.tracks[matchingTrack].name}:`);
      for (const [raceId, race] of Object.entries(horsesData.tracks[matchingTrack].races)) {
        console.log(`- Race at ${race.time}:`);
        race.runners.forEach(runner => {
          console.log(`  - ${runner.name} (position: ${runner.position})`);
        });
      }
    } else {
      console.log(`No matching track found for "${trackName}"`);
      console.log(`Available tracks: ${Object.keys(horsesData.tracks).map(k => horsesData.tracks[k].name).join(', ')}`);
    }
  }
  
  console.log(`NO MATCH: Horse "${horseName}" not found at track "${trackName}"`);
  return null;
}

// Process a single horse bet
async function processSingleBet(bet, horsesData) {
  // Skip if missing essential data
  if (!bet.horse_name) {
    console.log(`Skipping bet ID ${bet.id} - missing horse name`);
    return false;
  }
  
  // Find the horse in the results
  const horseResult = findHorseInResults(horsesData, bet.horse_name, bet.track_name);
  
  if (!horseResult) {
    console.log(`No match found for bet ID ${bet.id}`);
    return false;
  }
  
  // Get number of runners in the race
  let numRunners = 0;
  
  // Find the race to get total runners
  if (horseResult.race_id && horsesData.tracks) {
    const trackKey = Object.keys(horsesData.tracks).find(tk => 
      cleanHorseName(horsesData.tracks[tk].name) === cleanHorseName(horseResult.track_name)
    );
    
    if (trackKey && horsesData.tracks[trackKey].races[horseResult.race_id]) {
      numRunners = horsesData.tracks[trackKey].races[horseResult.race_id].runners.length;
    }
  }
  
  if (!numRunners) {
    numRunners = 10; // Default if we can't determine
    console.log(`Couldn't determine runner count, using default: ${numRunners}`);
  } else {
    console.log(`Race has ${numRunners} runners`);
  }
  
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
async function processMultipleBet(bet, horsesData) {
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
    
    const horseResult = findHorseInResults(horsesData, selection, trackName);
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