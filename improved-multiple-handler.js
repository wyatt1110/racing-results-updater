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
    
    // Find this horse using enhanced matching
    const horse = findHorseMatchEnhanced(horseName, cachedHorses);
    
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
    
    // Add the horse_id field if available
    if (betResult.horse_ids) {
      updateData.horse_id = betResult.horse_ids;
    }
    
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
  
  // Calculate OVR_BTN by summing all horses' values (changed from average to sum)
  let ovrBtnValue = null;
  if (horses.length > 0) {
    let sum = 0;
    let allHaveOvrBtn = true;
    
    for (const horse of horses) {
      const ovrBtn = parseNumeric(horse.ovr_btn);
      if (ovrBtn !== null) {
        sum += ovrBtn; // Sum the values instead of calculating an average
      } else {
        allHaveOvrBtn = false;
      }
    }
    
    // Only set the value if we could calculate it for at least one horse
    if (allHaveOvrBtn || horses.some(h => parseNumeric(h.ovr_btn) !== null)) {
      ovrBtnValue = sum;
    }
  }
  
  // Collect horse IDs in the same order as the bet selections
  const horseIds = Array(totalSelections).fill('');
  horses.forEach(horse => {
    if (horse.selection_number && horse.selection_number <= totalSelections && horse.horse_id) {
      horseIds[horse.selection_number - 1] = horse.horse_id;
    }
  });
  const horseIdsString = horseIds.filter(id => id).join(' / ');
  
  return {
    status,
    returns,
    profit_loss: profitLoss,
    sp_industry: spValue,
    ovr_btn: ovrBtnValue,
    fin_pos: finishPositions,
    horse_ids: horseIdsString // Add the horse IDs field
  };
}

// Enhanced horse matching function that tries multiple matching strategies
function findHorseMatchEnhanced(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  const cleanHorseName = horseName.toLowerCase().trim();
  const simplifiedHorseName = simplifyName(horseName);
  
  console.log(`Searching ${horses.length} horses for match to "${horseName}"`);
  
  // Try name variants if available
  for (const horse of horses) {
    if (horse.name_variants && Array.isArray(horse.name_variants)) {
      // Check if any of the name variants match
      if (horse.name_variants.includes(cleanHorseName) || 
          horse.name_variants.includes(simplifiedHorseName)) {
        console.log(`Name variant match found: ${horse.horse_name}`);
        return horse;
      }
    }
  }
  
  // Try exact match
  for (const horse of horses) {
    const apiHorseName = (horse.horse_name || '').toLowerCase().trim();
    const apiHorseNameWithoutCountry = apiHorseName.replace(/\s*\([a-z]{2,3}\)$/i, '');
    
    if (apiHorseName === cleanHorseName || apiHorseNameWithoutCountry === cleanHorseName) {
      console.log(`Exact match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try simplified match (no spaces, no punctuation)
  for (const horse of horses) {
    const simplifiedApiName = simplifyName(horse.horse_name);
    if (simplifiedApiName === simplifiedHorseName) {
      console.log(`Simplified match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try with "The" removed or added
  const withoutThe = cleanHorseName.startsWith('the ') ? cleanHorseName.substring(4) : cleanHorseName;
  const withThe = !cleanHorseName.startsWith('the ') ? 'the ' + cleanHorseName : cleanHorseName;
  
  for (const horse of horses) {
    const apiName = (horse.horse_name || '').toLowerCase().trim();
    const apiNameWithoutThe = apiName.startsWith('the ') ? apiName.substring(4) : apiName;
    
    if (apiName === withoutThe || apiName === withThe || 
        apiNameWithoutThe === cleanHorseName) {
      console.log(`'The' prefix match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try with parentheses content removed
  const withoutParentheses = cleanHorseName.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  
  for (const horse of horses) {
    const apiName = (horse.horse_name || '').toLowerCase().trim();
    const apiNameWithoutParentheses = apiName.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    
    if (apiNameWithoutParentheses === withoutParentheses) {
      console.log(`Parentheses-removed match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try matching based on simplified substring
  for (const horse of horses) {
    const apiName = (horse.horse_name || '').toLowerCase();
    const simplifiedApiName = simplifyName(horse.horse_name);
    
    // If one contains the other
    if ((simplifiedApiName.includes(simplifiedHorseName) && simplifiedHorseName.length > 3) ||
        (simplifiedHorseName.includes(simplifiedApiName) && simplifiedApiName.length > 3)) {
      console.log(`Substring match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try fuzzy matching (Levenshtein distance)
  const fuzzyMatch = findClosestHorseMatch(cleanHorseName, horses);
  if (fuzzyMatch) {
    console.log(`Fuzzy match found: ${fuzzyMatch.horse_name}`);
    return fuzzyMatch;
  }
  
  // Try Jockey + Trainer validation
  if (bet && bet.jockey && bet.trainer) {
    for (const horse of horses) {
      const apiJockey = (horse.jockey || '').toLowerCase();
      const apiTrainer = (horse.trainer || '').toLowerCase();
      const betJockey = bet.jockey.toLowerCase();
      const betTrainer = bet.trainer.toLowerCase();
      
      // If both jockey and trainer match, this is likely our horse
      if ((apiJockey.includes(betJockey) || betJockey.includes(apiJockey)) &&
          (apiTrainer.includes(betTrainer) || betTrainer.includes(apiTrainer))) {
        console.log(`Jockey+Trainer match found: ${horse.horse_name}`);
        return horse;
      }
    }
  }
  
  console.log(`No match found for horse: ${horseName}`);
  return null;
}

// Find best match for a horse name in the results using standard matching
function findHorseMatch(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  const cleanName = horseName.toLowerCase().trim();
  const simplifiedSearch = simplifyName(horseName);
  
  console.log(`Searching ${horses.length} horses for match to "${horseName}"`);
  
  // Try exact match first
  for (const horse of horses) {
    // Clean the horse name from API response
    const apiName = (horse.horse_name || '').toLowerCase().trim();
    const apiNameWithoutCountry = apiName.replace(/\s*\([a-z]{2,3}\)$/i, '');
    
    if (apiName === cleanName || apiNameWithoutCountry === cleanName) {
      console.log(`Exact match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try simplified match (no spaces, no punctuation)
  for (const horse of horses) {
    const simplifiedApiName = simplifyName(horse.horse_name);
    if (simplifiedApiName === simplifiedSearch) {
      console.log(`Simplified match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try name variants if available
  for (const horse of horses) {
    if (horse.name_variants && Array.isArray(horse.name_variants)) {
      // Check if any of the name variants match
      if (horse.name_variants.includes(cleanName) || 
          horse.name_variants.includes(simplifiedSearch)) {
        console.log(`Name variant match found: ${horse.horse_name}`);
        return horse;
      }
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
  if (!horses || horses.length === 0 || !name) return null;
  
  let bestMatch = null;
  let bestDistance = Infinity;
  
  // Higher threshold for longer names
  const threshold = Math.max(2, Math.min(4, Math.floor(name.length * 0.3))); 
  
  for (const horse of horses) {
    const horseName = (horse.horse_name || '').toLowerCase().trim().replace(/\s*\([a-z]{2,3}\)$/i, '');
    const distance = levenshteinDistance(name, horseName);
    
    if (distance < threshold && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = horse;
    }
  }
  
  // Only return a match if it's a good match
  if (bestMatch && bestDistance <= Math.min(3, name.length / 4)) {
    return bestMatch;
  }
  
  return null;
}

// Levenshtein distance for fuzzy matching
function levenshteinDistance(a, b) {
  if (!a || !b) return Infinity;
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

// Simplify name for easier comparison
function simplifyName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
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

// Generate name variants for better matching
function generateNameVariants(name) {
  if (!name) return [];
  
  const variants = [
    name.toLowerCase(),
    simplifyName(name),
    name.toLowerCase().replace(/[^\w\s]/g, ''), // Remove punctuation
    name.toLowerCase().replace(/\s+/g, ''),     // Remove spaces
    name.toLowerCase().replace(/the/gi, '')     // Remove "the"
  ];
  
  // Remove (FR), (IRE), etc. country codes
  const withoutCountry = name.toLowerCase().replace(/\s*\([a-z]{2,3}\)$/i, '');
  if (withoutCountry !== name.toLowerCase()) {
    variants.push(withoutCountry);
    variants.push(simplifyName(withoutCountry));
  }
  
  // Handle common prefixes
  if (name.toLowerCase().startsWith('the ')) {
    const withoutThe = name.substring(4);
    variants.push(withoutThe.toLowerCase());
    variants.push(simplifyName(withoutThe));
  }
  
  return [...new Set(variants)]; // Remove duplicates
}

module.exports = {
  processMultipleBet,
  calculateMultipleBetResult,
  findHorseMatch,
  findHorseMatchEnhanced,
  findClosestHorseMatch,
  simplifyName,
  parseNumeric,
  generateNameVariants,
  levenshteinDistance
};