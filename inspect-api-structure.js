require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Simple utility to analyze API response structure
function inspectResponseStructure() {
  try {
    console.log('Reading API response from results_raw_response.json...');
    
    // Check if file exists
    if (!fs.existsSync('results_raw_response.json')) {
      console.log('Error: results_raw_response.json file not found');
      return;
    }
    
    // Read the file content
    const rawData = fs.readFileSync('results_raw_response.json', 'utf8');
    const response = JSON.parse(rawData);
    
    console.log('API Response Structure Analysis:');
    console.log('--------------------------------');
    
    // Check top level structure
    console.log(`Top level keys: ${Object.keys(response).join(', ')}`);
    
    // Check results array existence and length
    if (response.results && Array.isArray(response.results)) {
      console.log(`Results array length: ${response.results.length}`);
      
      // Inspect the first meeting
      if (response.results.length > 0) {
        const firstMeeting = response.results[0];
        console.log(`\nFirst meeting keys: ${Object.keys(firstMeeting).join(', ')}`);
        console.log(`Meeting name: ${firstMeeting.meeting_name || firstMeeting.course || firstMeeting.venue || 'Unknown'}`);
        
        // Check for races array
        if (firstMeeting.races && Array.isArray(firstMeeting.races)) {
          console.log(`Races array length: ${firstMeeting.races.length}`);
          
          // Inspect the first race
          if (firstMeeting.races.length > 0) {
            const firstRace = firstMeeting.races[0];
            console.log(`\nFirst race keys: ${Object.keys(firstRace).join(', ')}`);
            
            // Check for runners/results array
            for (const possibleKey of ['runners', 'results', 'horses']) {
              if (firstRace[possibleKey] && Array.isArray(firstRace[possibleKey])) {
                console.log(`${possibleKey} array length: ${firstRace[possibleKey].length}`);
                
                // Inspect the first runner
                if (firstRace[possibleKey].length > 0) {
                  const firstRunner = firstRace[possibleKey][0];
                  console.log(`\nFirst ${possibleKey.slice(0, -1)} keys: ${Object.keys(firstRunner).join(', ')}`);
                  console.log(`Horse name: ${firstRunner.horse || firstRunner.name || 'Unknown'}`);
                  console.log(`Position: ${firstRunner.position || 'Unknown'}`);
                  console.log(`SP: ${firstRunner.sp || firstRunner.sp_dec || 'Unknown'}`);
                  console.log(`BTN: ${firstRunner.btn || 'Unknown'}`);
                  console.log(`OVR_BTN: ${firstRunner.ovr_btn || 'Unknown'}`);
                }
              } else {
                console.log(`No ${possibleKey} array found in first race`);
              }
            }
          }
        } else if (firstMeeting.data && firstMeeting.data.races && Array.isArray(firstMeeting.data.races)) {
          console.log(`Races array in data field length: ${firstMeeting.data.races.length}`);
          // Similar inspection can be done here
        } else {
          console.log('No races array found in first meeting');
          
          // Try to find any array in the first meeting
          for (const key in firstMeeting) {
            if (Array.isArray(firstMeeting[key])) {
              console.log(`Found array in key "${key}" with length ${firstMeeting[key].length}`);
            } else if (typeof firstMeeting[key] === 'object' && firstMeeting[key] !== null) {
              for (const subKey in firstMeeting[key]) {
                if (Array.isArray(firstMeeting[key][subKey])) {
                  console.log(`Found array in nested key "${key}.${subKey}" with length ${firstMeeting[key][subKey].length}`);
                }
              }
            }
          }
        }
      }
    } else {
      console.log('No results array found in API response');
      
      // Try to find any array in the response
      for (const key in response) {
        if (Array.isArray(response[key])) {
          console.log(`Found array in key "${key}" with length ${response[key].length}`);
          
          // Check first item in array
          if (response[key].length > 0) {
            console.log(`First item in ${key} has keys: ${Object.keys(response[key][0]).join(', ')}`);
          }
        }
      }
    }
    
    // Print a complete recursive inspection of keys for first meeting
    if (response.results && Array.isArray(response.results) && response.results.length > 0) {
      console.log('\nComplete Structure:');
      console.log('------------------');
      inspectObjectStructure(response.results[0], 'results[0]');
    }
    
    // Write modified structure to file for the updater script to use
    console.log('\nAttempting to extract horse data for all tracks...');
    const tracks = new Set();
    const allExtractedHorses = [];
    
    // Create a recursive function to find arrays with position, horse name, etc.
    const findHorseArrays = (obj, path = '') => {
      if (!obj || typeof obj !== 'object') return;
      
      // Check if this object looks like a horse/runner
      if (obj.position && (obj.horse || obj.name) && 
         (obj.sp || obj.sp_dec || obj.position || obj.btn || obj.ovr_btn || obj.finish_position)) {
        
        const trackName = path.includes('meeting_name=') 
          ? path.split('meeting_name=')[1].split(',')[0]
          : path.includes('course=') 
            ? path.split('course=')[1].split(',')[0]
            : 'Unknown';
            
        tracks.add(trackName);
        
        allExtractedHorses.push({
          horse_name: obj.horse || obj.name || 'Unknown',
          position: obj.position || obj.finish_position || 'Unknown',
          bsp: obj.bsp || obj.sp_dec || obj.sp || null,
          sp: obj.sp_dec || obj.sp || null,
          ovr_btn: obj.ovr_btn || obj.beaten_distance || obj.btn || '0',
          btn: obj.btn || obj.beaten_margin || '0',
          track_name: trackName,
          race_id: path.includes('race_id=') ? path.split('race_id=')[1].split(',')[0] : '',
          race_time: path.includes('time=') ? path.split('time=')[1].split(',')[0] : '',
          race_name: path.includes('race_name=') ? path.split('race_name=')[1].split(',')[0] : '',
          simplified_name: (obj.horse || obj.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        });
        return;
      }
      
      // If this is an array, check each element
      if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
          findHorseArrays(item, `${path}[${index}]`);
        });
        return;
      }
      
      // Otherwise, recurse through object properties
      for (const [key, value] of Object.entries(obj)) {
        let newPath = path ? `${path}.${key}` : key;
        
        // Add key values to path for important fields
        if (key === 'meeting_name' || key === 'course' || key === 'venue' || key === 'race_id' || 
            key === 'time' || key === 'race_name' || key === 'name') {
          newPath = `${newPath}=${value},${path}`;
        }
        
        findHorseArrays(value, newPath);
      }
    };
    
    // Start recursive scan of API response
    findHorseArrays(response);
    
    console.log(`Found ${allExtractedHorses.length} horses across ${tracks.size} tracks: ${[...tracks].join(', ')}`);
    
    // Write extracted horses to file
    if (allExtractedHorses.length > 0) {
      fs.writeFileSync('all_extracted_horses.json', JSON.stringify(allExtractedHorses, null, 2));
      console.log('Saved extracted horses to all_extracted_horses.json');
      
      // Also save the first few horses for inspection
      const sampleHorses = allExtractedHorses.slice(0, 10);
      console.log('\nSample extracted horses:');
      console.log(JSON.stringify(sampleHorses, null, 2));
    } else {
      console.log('No horses found in the API response');
    }
    
  } catch (error) {
    console.error('Error inspecting API response structure:', error);
  }
}

// Helper function to recursively print object structure
function inspectObjectStructure(obj, path = '', maxDepth = 3, currentDepth = 0) {
  if (currentDepth > maxDepth) {
    console.log(`${' '.repeat(currentDepth * 2)}${path}: [Max depth reached]`);
    return;
  }
  
  if (obj === null) {
    console.log(`${' '.repeat(currentDepth * 2)}${path}: null`);
    return;
  }
  
  if (Array.isArray(obj)) {
    console.log(`${' '.repeat(currentDepth * 2)}${path}: Array(${obj.length})`);
    if (obj.length > 0) {
      // Only inspect the first item in any array
      inspectObjectStructure(obj[0], `${path}[0]`, maxDepth, currentDepth + 1);
    }
    return;
  }
  
  if (typeof obj === 'object') {
    console.log(`${' '.repeat(currentDepth * 2)}${path}: Object {${Object.keys(obj).join(', ')}}`);
    for (const [key, value] of Object.entries(obj)) {
      inspectObjectStructure(value, path ? `${path}.${key}` : key, maxDepth, currentDepth + 1);
    }
    return;
  }
  
  // For primitive types, just print the value
  console.log(`${' '.repeat(currentDepth * 2)}${path}: ${typeof obj} (${obj})`);
}

// Run the inspector
inspectResponseStructure();