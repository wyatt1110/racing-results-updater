// Improved multiple bet handling functions

// Process a multiple bet with improved matching
async function processMultipleBet(bet, trackHorsesCache, supabase) {
  console.log(`Processing multiple bet: ${bet.id} - ${bet.horse_name}`);
  
  // Split horse names and track names
  const horseNames = bet.horse_name.split('/').map(h => h.trim());
  let trackNames = [];
  
  if (bet.track_name.includes('/')) {
    // Multiple tracks specified
    trackNames = bet.track_name.split('/').map(t => t.trim());
  } else {
    // Single track for all horses
    trackNames = horseNames.map(() => bet.track_name.trim());
  }
  
  console.log(`Multiple bet has ${horseNames.length} selections:`);
  horseNames.forEach((horse, idx) => {
    console.log(`  ${idx + 1}. ${horse} at ${trackNames[idx] || trackNames[0]}`);
  });
  
  const date = bet.race_date.split('T')[0];
  const horses = [];
  const missingHorses = [];
  
  // Find all horses
  for (let i = 0; i < horseNames.length; i++) {
    const horseName = horseNames[i];
    const trackName = trackNames[i < trackNames.length ? i : 0]; // Use matching track or first track
    
    // Get cached horses for this track
    const cacheKey = `${trackName}:${date}`;
    const cachedHorses = trackHorsesCache[cacheKey] || [];
    
    if (cachedHorses.length === 0) {
      console.log(`No horses found for ${trackName} on ${date} for horse ${horseName}`);
      missingHorses.push({ 
        horseName, 
        trackName, 
        reason: 'No horses found for track/date',
        index: i
      });
      continue;
    }
    
    // Find this horse
    const horse = findHorseMatch(horseName, cachedHorses);
    
    if (horse) {
      console.log(`Found match for multiple bet: ${horseName} -> ${horse.horse_name} (Position: ${horse.position})`);
      // Add selection number to the horse object
      horses.push({
        ...horse,
        selection_number: i + 1
      });
    } else {
      console.log(`No match found for horse: ${horseName} at ${trackName}`);
      missingHorses.push({ 
        horseName, 
        trackName, 
        reason: 'No match found',
        index: i
      });
    }
  }
  
  console.log(`Found ${horses.length} of ${horseNames.length} horses for multiple bet ${bet.id}`);
  
  // If we didn't find any horses, fail
  if (horses.length === 0) {
    console.log(`Failed to find any horses for multiple bet ${bet.id}`);
    for (const missing of missingHorses) {
      console.log(`- Selection #${missing.index + 1}: ${missing.horseName} at ${missing.trackName}: ${missing.reason}`);
    }
    return false;
  }
  
  // If we found some but not all horses, proceed with what we have (partial update)
  if (horses.length < horseNames.length) {
    console.log(`WARNING: Only found ${horses.length} of ${horseNames.length} horses for bet ${bet.id}`);
    for (const missing of missingHorses) {
      console.log(`- Selection #${missing.index + 1}: ${missing.horseName} at ${missing.trackName}: ${missing.reason}`);
    }
  }
  
  // Calculate bet status, returns, etc.
  const betResult = calculateMultipleBetResult(bet, horses, horseNames.length);
  
  // Update bet in database
  try {
    // Prepare update data - ensure all values are properly typed
    const updateData = {
      status: betResult.status,
      fin_pos: betResult.fin_pos,
      updated_at: new Date().toISOString()
    };
    
    // Only add numeric fields if they're valid numbers
    if (betResult.returns !== null && !isNaN(betResult.returns)) 
      updateData.returns = betResult.returns;
    
    if (betResult.profit_loss !== null && !isNaN(betResult.profit_loss)) 
      updateData.profit_loss = betResult.profit_loss;
    
    if (betResult.sp_industry !== null && !isNaN(betResult.sp_industry)) 
      updateData.sp_industry = betResult.sp_industry;
    
    if (betResult.ovr_btn !== null && !isNaN(betResult.ovr_btn)) 
      updateData.ovr_btn = betResult.ovr_btn;
    
    console.log(`Updating multiple bet ${bet.id} with:`, updateData);
    
    // Update in Supabase
    const { error } = await supabase
      .from('racing_bets')
      .update(updateData)
      .eq('id', bet.id);
    
    if (error) {
      console.error(`Error updating multiple bet ${bet.id}:`, error.message);
      return false;
    }
    
    console.log(`Successfully updated multiple bet ${bet.id}: ${betResult.status}, Returns: ${betResult.returns}`);
    return true;
  } catch (error) {
    console.error(`Exception updating multiple bet ${bet.id}:`, error.message);
    return false;
  }
}

// Calculate the result of a multiple bet
function calculateMultipleBetResult(bet, horses, totalSelections) {
  if (!horses || horses.length === 0) {
    throw new Error('No horse data provided to calculate bet result');
  }
  
  const missingHorses = totalSelections - horses.length;
  
  // Default to 'Partial Update' if we're missing any legs
  let status = missingHorses > 0 ? 'Partial Update' : 'Pending';
  
  // Process the horses we have found
  const nonRunners = horses.filter(horse => {
    const posLower = (horse.position || '').toLowerCase();
    return posLower === 'nr' || posLower === 'ns' || posLower === 'rr' || posLower === 'void';
  });
  
  // Find winners and losers among horses that ran
  const winners = horses.filter(horse => {
    // Skip non-runners
    const posLower = (horse.position || '').toLowerCase();
    if (posLower === 'nr' || posLower === 'ns' || posLower === 'rr' || posLower === 'void') {
      return false;
    }
    
    // Check if it's a winner (position 1)
    const pos = parseFloat(horse.position);
    return pos === 1 || horse.position === '1';
  });
  
  // For accumulators/multiples, all selections must win
  if (nonRunners.length > 0) {
    // With any non-runners, we treat the bet as void or reduced depending on rules
    // For simplicity, we'll mark as 'Void' if all selections are non-runners
    // or 'Reduced' if some are non-runners but others ran
    
    if (nonRunners.length === horses.length) {
      status = 'Void';
    } else {
      // Some ran, some didn't - this is a reduced multiple
      status = 'Reduced';
    }
  } else if (winners.length === horses.length && horses.length === totalSelections) {
    // All selections ran and won - this is a winner
    status = 'Won';
  } else if (winners.length < horses.length || horses.length < totalSelections) {
    // Some winners but not all, or missing some selections - it's a loser
    // Only exception would be if ALL missing horses would need to win to make it a winner
    status = 'Lost';
  }
  
  // Calculate returns and odds
  let returns = 0;
  
  if (status === 'Won') {
    // For a winning accumulator, multiply all odds together
    // (stake × odds1 × odds2 × ... × oddsN)
    const totalOdds = horses.reduce((acc, horse) => {
      // Use the starting price (SP) if available, otherwise fall back to bet odds
      const horseOdds = horse.sp || bet.odds / totalSelections; // Fallback to dividing total odds
      return acc * horseOdds;
    }, 1);
    
    returns = parseFloat(bet.stake || 0) * totalOdds;
  } else if (status === 'Void') {
    // All selections void, return stake
    returns = parseFloat(bet.stake || 0);
  } else if (status === 'Reduced') {
    // Some void legs, calculate returns based on remaining selections
    // For simplicity, we'll calculate a reduced factor
    const runnersCount = horses.length - nonRunners.length;
    
    if (winners.length === runnersCount) {
      // All that ran won, calculate returns with reduced odds
      const reducedOdds = winners.reduce((acc, horse) => {
        const horseOdds = horse.sp || bet.odds / totalSelections; 
        return acc * horseOdds;
      }, 1);
      
      returns = parseFloat(bet.stake || 0) * reducedOdds;
    } else {
      // Some that ran lost, so the bet is lost
      returns = 0;
      status = 'Lost';
    }
  }
  
  // Calculate profit/loss
  const profitLoss = returns - parseFloat(bet.stake || 0);
  
  // Format finish positions in order of selections
  const positions = Array(totalSelections).fill('?');
  horses.forEach(horse => {
    if (horse.selection_number && horse.selection_number <= totalSelections) {
      positions[horse.selection_number - 1] = horse.position || '?';
    }
  });
  const finishPositions = positions.join(' / ');
  
  // Calculate SP value (the cumulative SP of all horses)
  let spValue = null;
  if (horses.length > 0) {
    let cumulativeSP = 1;
    let allHaveSP = true;
    
    for (const horse of horses) {
      if (horse.sp === null || isNaN(horse.sp)) {
        allHaveSP = false;
        break;
      }
      cumulativeSP *= parseFloat(horse.sp);
    }
    
    if (allHaveSP) {
      spValue = cumulativeSP;
    }
  }
  
  // Calculate OVR_BTN as average of all horses' values
  let ovrBtnValue = null;
  if (horses.length > 0) {
    let sum = 0;
    let count = 0;
    
    for (const horse of horses) {
      const ovrBtn = parseNumeric(horse.ovr_btn);
      if (ovrBtn !== null) {
        sum += ovrBtn;
        count++;
      }
    }
    
    if (count > 0) {
      ovrBtnValue = sum / count;
    }
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

// Find best match for a horse name in the results
function findHorseMatch(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  const cleanName = horseName.toLowerCase().trim();
  const simplifiedSearch = simplifyName(horseName);
  
  console.log(`Searching ${horses.length} horses for match to "${horseName}"`);
  
  // Try exact match first
  for (const horse of horses) {
    // Clean the horse name from API response
    const apiName = (horse.horse_name || '').toLowerCase().trim();
    const apiNameWithoutCountry = apiName.replace(/\\s*\\([a-z]{2,3}\\)$/i, '');
    
    if (apiName === cleanName || apiNameWithoutCountry === cleanName) {
      console.log(`Exact match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try simplified match (no spaces, no punctuation)
  for (const horse of horses) {
    if (horse.simplified_name === simplifiedSearch) {
      console.log(`Simplified match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try fuzzy matching
  const fuzzyMatch = findClosestHorseMatch(cleanName, horses);
  if (fuzzyMatch) {
    console.log(`Fuzzy match found: ${fuzzyMatch.horse_name}`);
    return fuzzyMatch;
  }
  
  console.log(`No match found for horse: ${horseName}`);
  return null;
}

// Find closest matching horse using Levenshtein distance
function findClosestHorseMatch(name, horses) {
  // Levenshtein distance function
  function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    
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
  
  let bestMatch = null;
  let bestDistance = Infinity;
  const threshold = Math.max(2, Math.floor(name.length * 0.3)); // Allow 30% difference max
  
  for (const horse of horses) {
    const horseName = (horse.horse_name || '').toLowerCase().trim().replace(/\\s*\\([a-z]{2,3}\\)$/i, '');
    const distance = levenshtein(name, horseName);
    
    if (distance < threshold && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = horse;
    }
  }
  
  return bestMatch;
}

// Simplify name for easier comparison
function simplifyName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Parse numeric value safely
function parseNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  
  // If already a number, just return it
  if (typeof value === 'number' && !isNaN(value)) return value;
  
  // Handle string values
  if (typeof value === 'string') {
    // Return null for non-numeric placeholders
    if (['nr', 'ns', 'rr', 'void', '-'].includes(value.toLowerCase())) {
      return null;
    }
    
    // Try to convert to number
    const num = parseFloat(value);
    return isNaN(num) ? null : num;
  }
  
  return null;
}

module.exports = {
  processMultipleBet,
  calculateMultipleBetResult,
  findHorseMatch,
  findClosestHorseMatch,
  simplifyName,
  parseNumeric
};