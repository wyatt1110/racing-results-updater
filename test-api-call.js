// Test script to verify API calls and track code loading
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Racing API credentials
const racingApiUsername = 'KQ9W7rQeAHWMUgxH93ie3yEc';
const racingApiPassword = 'T5BoPivL3Q2h6RhCdLv4EwZu';
const racingApiBase = 'https://api.theracingapi.com/v1';

// Initialize API client
const racingApi = axios.create({
  baseURL: racingApiBase,
  auth: {
    username: racingApiUsername,
    password: racingApiPassword
  }
});

// Sleep function for delay between API calls
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Load track codes from JSON file
async function loadTrackCodes() {
  try {
    const trackCodesPath = path.resolve(__dirname, 'Track-codes-list.json');
    console.log(`Loading track codes from: ${trackCodesPath}`);
    
    if (fs.existsSync(trackCodesPath)) {
      const fileContent = fs.readFileSync(trackCodesPath, 'utf8');
      const parsedData = JSON.parse(fileContent);
      
      if (parsedData.course_list && Array.isArray(parsedData.course_list)) {
        console.log(`Found ${parsedData.course_list.length} tracks in Track-codes-list.json`);
        
        // Convert to name->id mapping
        const trackCodes = {};
        parsedData.course_list.forEach(course => {
          if (course.name && course.id) {
            trackCodes[course.name.toLowerCase()] = course.id;
          }
        });
        
        console.log(`Loaded ${Object.keys(trackCodes).length} track codes`);
        return trackCodes;
      } else {
        throw new Error('Track-codes-list.json has unexpected structure');
      }
    } else {
      throw new Error(`Track-codes-list.json not found at: ${trackCodesPath}`);
    }
  } catch (error) {
    console.error(`Error loading track codes: ${error.message}`);
    return {};
  }
}

// Test API call for a track+date
async function testApiCall(trackName, date, courseId) {
  console.log(`\nTesting API call for ${trackName} (${courseId}) on ${date}`);
  
  try {
    // Prepare API params
    const params = { start_date: date };
    
    if (courseId) {
      params.course = courseId;
    } else {
      console.error(`No course ID available for ${trackName}, cannot make API call`);
      return false;
    }
    
    console.log(`API Request to ${racingApiBase}/results with params:`, params);
    
    // Make the API call
    const response = await racingApi.get('/results', { params });
    
    // Check response
    if (response.data && response.data.results && Array.isArray(response.data.results)) {
      console.log(`API call successful! Found ${response.data.results.length} races`);
      
      // Count horses
      let totalHorses = 0;
      response.data.results.forEach(race => {
        if (race.runners && Array.isArray(race.runners)) {
          totalHorses += race.runners.length;
        }
      });
      
      console.log(`Total horses in response: ${totalHorses}`);
      
      // Save response for inspection
      const safeTrackName = trackName.replace(/[^a-zA-Z0-9]/g, '_');
      fs.writeFileSync(
        `${safeTrackName}_${date}_test_response.json`,
        JSON.stringify(response.data, null, 2)
      );
      
      return true;
    } else {
      console.error('API response missing expected structure');
      return false;
    }
  } catch (error) {
    console.error(`API call failed: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Error data: ${JSON.stringify(error.response.data)}`);
    }
    return false;
  }
}

// Main test function
async function runTests() {
  // Load track codes
  const trackCodes = await loadTrackCodes();
  
  // Tracks to test (these should be in your pending bets)
  const tracksToTest = [
    { name: 'Nottingham', date: '2025-04-09' },
    { name: 'Catterick', date: '2025-04-09' },
    { name: 'Limerick', date: '2025-04-10' },
    { name: 'Hereford', date: '2025-04-10' },
    { name: 'Lingfield', date: '2025-04-10' },
    { name: 'Newton Abbot', date: '2025-04-10' }
  ];
  
  // Test each track
  let successes = 0;
  for (const { name, date } of tracksToTest) {
    const courseId = trackCodes[name.toLowerCase()];
    
    if (courseId) {
      console.log(`Found course ID for ${name}: ${courseId}`);
      const success = await testApiCall(name, date, courseId);
      if (success) successes++;
    } else {
      console.error(`No course ID found for ${name}`);
    }
    
    // Wait between API calls
    await sleep(3000);
  }
  
  console.log(`\nTest complete. ${successes}/${tracksToTest.length} API calls successful.`);
}

// Run the tests
runTests()
  .then(() => console.log('Test script finished.'))
  .catch(error => console.error('Error in test script:', error.message));