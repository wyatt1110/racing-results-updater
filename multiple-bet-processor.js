// Process a multiple bet
async function processMultipleBet(bet, trackHorsesCache, findHorseMatch, calculateBetResult, supabase) {
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
  
  console.log(`Multiple bet has ${horseNames.length} selections: ${horseNames.join(', ')}`);
  console.log(`Tracks: ${trackNames.join(', ')}`);
  
  const date = bet.race_date.split('T')[0];
  const horses = [];
  const missingHorses = [];
  
  // Find all horses
  for (let i = 0; i < horseNames.length; i++) {
    const horseName = horseNames[i];
    const trackName = trackNames[i] || trackNames[0]; // Use first track if not enough tracks specified
    
    // Get cached horses for this track
    const cacheKey = `${trackName}:${date}`;
    const cachedHorses = trackHorsesCache[cacheKey] || [];
    
    if (cachedHorses.length === 0) {
      console.log(`No horses found for ${trackName} on ${date} for horse ${horseName}`);
      missingHorses.push({ horseName, trackName, reason: 'No horses found for track/date' });
      continue; // Continue to next horse instead of failing the entire bet
    }
    
    // Find this horse
    const horse = findHorseMatch(horseName, cachedHorses);
    
    if (horse) {
      console.log(`Found match for multiple bet: ${horseName} -> ${horse.horse_name} (Position: ${horse.position})`);
      horses.push(horse);
    } else {
      console.log(`No match found for horse: ${horseName} at ${trackName}`);
      missingHorses.push({ horseName, trackName, reason: 'No match found' });
    }
  }
  
  console.log(`Found ${horses.length} of ${horseNames.length} horses for multiple bet ${bet.id}`);
  
  // If we didn't find any horses, fail
  if (horses.length === 0) {
    console.log(`Failed to find any horses for multiple bet ${bet.id}`);
    for (const missing of missingHorses) {
      console.log(`- ${missing.horseName} at ${missing.trackName}: ${missing.reason}`);
    }
    return false;
  }
  
  // If we found some but not all horses, proceed with what we have (partial update)
  if (horses.length < horseNames.length) {
    console.log(`WARNING: Only found ${horses.length} of ${horseNames.length} horses for bet ${bet.id}`);
    for (const missing of missingHorses) {
      console.log(`- ${missing.horseName} at ${missing.trackName}: ${missing.reason}`);
    }
  }
  
  // Calculate bet status, returns, etc.
  const { status, returns, profit_loss, sp_industry, ovr_btn, fin_pos } = calculateBetResult(bet, horses);
  
  // Update bet in database
  try {
    // Prepare update data - ensure all values are properly typed
    const updateData = {
      status: status,
      fin_pos: fin_pos,
      updated_at: new Date().toISOString()
    };
    
    // Only add numeric fields if they're valid numbers
    if (returns !== null && !isNaN(returns)) updateData.returns = returns;
    if (profit_loss !== null && !isNaN(profit_loss)) updateData.profit_loss = profit_loss;
    if (sp_industry !== null && !isNaN(sp_industry)) updateData.sp_industry = sp_industry;
    if (ovr_btn !== null && !isNaN(ovr_btn)) updateData.ovr_btn = ovr_btn;
    
    console.log(`Updating multiple bet ${bet.id} with: ${JSON.stringify(updateData)}`);
    
    // Update in Supabase
    const { error } = await supabase
      .from('racing_bets')
      .update(updateData)
      .eq('id', bet.id);
    
    if (error) {
      console.error(`Error updating multiple bet ${bet.id}:`, error.message);
      console.error(`Update data: ${JSON.stringify(updateData)}`);
      return false;
    }
    
    console.log(`Successfully updated multiple bet ${bet.id}: ${status}, Returns: ${returns}`);
    return true;
  } catch (error) {
    console.error(`Exception updating multiple bet ${bet.id}:`, error.message);
    return false;
  }
}

// Calculate the outcome of a bet
function calculateBetResult(bet, horses) {
  if (!horses || horses.length === 0) {
    throw new Error('No horse data provided to calculate bet result');
  }
  
  const isMultiple = horses.length > 1;
  const originalHorseCount = (bet.horse_name || '').split('/').length;
  const missingHorses = originalHorseCount - horses.length;
  
  // For multi-selection bets where not all horses were found
  let status = 'Pending';
  
  if (isMultiple && missingHorses > 0) {
    console.log(`Multiple bet has ${missingHorses} missing horses, marking as 'Partial Update'`);
    status = 'Partial Update';
  } else if (isMultiple) {
    // For complete multiples, check if all horses won
    const allWon = horses.every(horse => {
      const pos = parseFloat(horse.position);
      return pos === 1 || horse.position === '1';
    });
    
    // Check for void legs (non-runners)
    const hasVoidLeg = horses.some(horse => {
      const posLower = (horse.position || '').toLowerCase();
      return posLower === 'rr' || posLower === 'nr' || posLower === 'ns' || posLower === 'void';
    });
    
    // If we have at least one void leg
    const allVoid = horses.every(horse => {
      const posLower = (horse.position || '').toLowerCase();
      return posLower === 'rr' || posLower === 'nr' || posLower === 'ns' || posLower === 'void';
    });
    
    if (allVoid) {
      status = 'Void';
    } else if (hasVoidLeg) {
      // For multiples with void legs, we need to recalculate
      const nonVoidHorses = horses.filter(horse => {
        const posLower = (horse.position || '').toLowerCase();
        return posLower !== 'rr' && posLower !== 'nr' && posLower !== 'ns' && posLower !== 'void';
      });
      
      // Check if all remaining horses won
      const allRemainingWon = nonVoidHorses.every(horse => {
        const pos = parseFloat(horse.position);
        return pos === 1 || horse.position === '1';
      });
      
      if (allRemainingWon && nonVoidHorses.length > 0) {
        status = 'Won (With Void)';
      } else {
        status = 'Lost';
      }
    } else if (allWon) {
      status = 'Won';
    } else {
      status = 'Lost';
    }
  } else {
    // Single bet
    const horse = horses[0];
    const positionStr = String(horse.position || '').trim().toLowerCase();
    
    // Check for non-numeric positions (void races)
    if (positionStr === 'nr' || positionStr === 'ns' || positionStr === 'rr' || positionStr === 'void') {
      status = 'Void';
    } else {
      // Try to get numeric position
      const position = parseFloat(positionStr);
      
      if (isNaN(position)) {
        // If position can't be parsed as a number
        status = 'Pending'; // Keep as pending if we can't determine position
      } else if (position === 1) {
        status = 'Won';
      } else if (bet.each_way === true) {
        // Check place for each-way bets
        const numRunners = horse.total_runners || 0;
        let placePaid = 0;
        
        if (numRunners >= 16) placePaid = 4;
        else if (numRunners >= 8) placePaid = 3;
        else if (numRunners >= 5) placePaid = 2;
        
        if (placePaid > 0 && position <= placePaid) {
          status = 'Placed';
        } else {
          status = 'Lost';
        }
      } else {
        status = 'Lost';
      }
    }
  }
  
  // Calculate returns
  let returns = 0;
  
  if (status === 'Won') {
    // Winning bet gets full odds
    returns = parseFloat(bet.stake || 0) * parseFloat(bet.odds || 0);
  } else if (status === 'Placed' && bet.each_way === true) {
    // Each-way place pays a fraction
    const placeOdds = (parseFloat(bet.odds || 0) - 1) * 0.2 + 1; // 1/5 odds typically
    returns = (parseFloat(bet.stake || 0) / 2) * placeOdds; // Half stake on place
  } else if (status === 'Void') {
    // Void bets return the stake
    returns = parseFloat(bet.stake || 0);
  } else if (status === 'Won (With Void)') {
    // For multiples with void legs, recalculate with adjusted odds
    let adjustedOdds = parseFloat(bet.odds || 0);
    const legCount = (bet.horse_name || '').split('/').length;
    
    // Simple adjustment - prorate the odds by removing 1/Nth per void leg
    const nonVoidCount = horses.filter(h => {
      const posLower = (h.position || '').toLowerCase();
      return posLower !== 'rr' && posLower !== 'nr' && posLower !== 'ns' && posLower !== 'void';
    }).length;
    
    // Simple approximation of adjusted odds
    adjustedOdds = 1 + ((adjustedOdds - 1) * nonVoidCount / legCount);
    
    returns = parseFloat(bet.stake || 0) * adjustedOdds;
  }
  
  // Calculate profit/loss
  const profitLoss = returns - parseFloat(bet.stake || 0);
  
  // Format finish positions
  const finishPositions = horses.map(h => h.position || '?').join(' / ');
  
  // Calculate SP value
  let spValue = null;
  if (isMultiple) {
    // For multiples, SP is the product of individual SPs
    let hasAllSPs = true;
    let cumulativeSP = 1;
    
    for (const horse of horses) {
      if (horse.sp === null || isNaN(horse.sp)) {
        hasAllSPs = false;
        break;
      }
      cumulativeSP *= parseFloat(horse.sp);
    }
    
    spValue = hasAllSPs ? cumulativeSP : null;
  } else {
    // For singles, use the horse's SP
    spValue = parseFloat(horses[0].sp || 0) || null;
  }
  
  // Calculate OVR_BTN value
  let ovrBtnValue = null;
  if (isMultiple) {
    // For multiples, use average of all horses' values
    let sum = 0;
    let count = 0;
    
    for (const horse of horses) {
      if (horse.ovr_btn !== null && !isNaN(horse.ovr_btn)) {
        sum += parseFloat(horse.ovr_btn);
        count++;
      }
    }
    
    ovrBtnValue = count > 0 ? sum / count : null;
  } else {
    // For singles, use the horse's value
    ovrBtnValue = horses[0].ovr_btn;
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

// Find a matching horse in the results
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
  
  // Try fuzzy matching with improved algorithm
  const fuzzyMatch = findClosestHorseMatch(cleanName, horses);
  if (fuzzyMatch) {
    console.log(`Fuzzy match found: ${fuzzyMatch.horse_name}`);
    return fuzzyMatch;
  }
  
  // Try word-by-word matching for horses with multiple words
  if (cleanName.includes(' ')) {
    console.log(`Trying word-by-word matching for "${cleanName}"`);
    const words = cleanName.split(' ').filter(w => w.length > 2); // Only use words with 3+ characters
    
    for (const horse of horses) {
      const apiName = (horse.horse_name || '').toLowerCase().trim();
      
      // Count how many words match
      let matchCount = 0;
      for (const word of words) {
        if (apiName.includes(word)) {
          matchCount++;
        }
      }
      
      // If more than half the words match, consider it a match
      if (matchCount >= Math.ceil(words.length / 2) && words.length >= 2) {
        console.log(`Word-by-word match found (${matchCount}/${words.length} words): ${horse.horse_name}`);
        return horse;
      }
    }
  }
  
  console.log(`No match found for horse: ${horseName}`);
  return null;
}

// Find closest matching horse using improved Levenshtein distance
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
  
  // Allow more fuzzy matching for longer names (30% for names up to 10 chars, 40% for longer)
  const threshold = Math.max(2, Math.floor(name.length * (name.length > 10 ? 0.4 : 0.3)));
  
  // First pass - try with full names
  for (const horse of horses) {
    const horseName = (horse.horse_name || '').toLowerCase().trim().replace(/\\s*\\([a-z]{2,3}\\)$/i, '');
    const distance = levenshtein(name, horseName);
    
    if (distance < threshold && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = horse;
    }
  }
  
  // If no match found and the name contains spaces, try matching on first part of the name
  if (!bestMatch && name.includes(' ')) {
    const firstPart = name.split(' ')[0];
    // Only try this if first part is reasonably long
    if (firstPart.length >= 4) {
      let bestFirstPartDistance = Infinity;
      
      for (const horse of horses) {
        const horseName = (horse.horse_name || '').toLowerCase().trim().replace(/\\s*\\([a-z]{2,3}\\)$/i, '');
        const horseFirstPart = horseName.split(' ')[0];
        
        if (horseFirstPart && horseFirstPart.length >= 4) {
          const distance = levenshtein(firstPart, horseFirstPart);
          const maxDist = Math.floor(Math.max(firstPart.length, horseFirstPart.length) * 0.4);
          
          if (distance <= maxDist && distance < bestFirstPartDistance) {
            bestFirstPartDistance = distance;
            bestMatch = horse;
          }
        }
      }
    }
  }
  
  return bestMatch;
}

// Simplify name for easier comparison
function simplifyName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

module.exports = {
  processMultipleBet,
  calculateBetResult,
  findHorseMatch,
  findClosestHorseMatch,
  simplifyName
};