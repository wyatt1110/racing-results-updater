require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
  auth: {
    username: racingApiUsername,
    password: racingApiPassword
  }
});

// Logger utility to control verbosity
const Logger = {
  LEVEL: {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  },
  currentLevel: 1, // Default to INFO
  
  debug: function(message, data) {
    if (this.currentLevel <= this.LEVEL.DEBUG) {
      console.log(`[DEBUG] ${message}`, data || '');
    }
  },
  
  info: function(message, data) {
    if (this.currentLevel <= this.LEVEL.INFO) {
      console.log(`[INFO] ${message}`, data || '');
    }
  },
  
  warn: function(message, data) {
    if (this.currentLevel <= this.LEVEL.WARN) {
      console.warn(`[WARN] ${message}`, data || '');
    }
  },
  
  error: function(message, error) {
    if (this.currentLevel <= this.LEVEL.ERROR) {
      console.error(`[ERROR] ${message}`, error || '');
      
      if (error && error.response) {
        console.error(`API Status: ${error.response.status}`);
        console.error(`API Data: ${JSON.stringify(error.response.data || {}).substring(0, 200)}...`);
      }
    }
  },
  
  setLevel: function(level) {
    this.currentLevel = level;
    console.log(`Log level set to: ${Object.keys(this.LEVEL).find(key => this.LEVEL[key] === level)}`);
  }
};

// Set log level (0=DEBUG, 1=INFO, 2=WARN, 3=ERROR)
Logger.setLevel(Logger.LEVEL.INFO);

// Sleep function for delay between API calls
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Track cache to avoid repeated API calls for the same track
const trackHorsesCache = {};

// Load track codes from GitHub repository
let TRACK_CODES = {};
async function loadTrackCodes() {
  try {
    Logger.info('Loading track codes from JSON file...');
    
    const trackCodesPath = path.resolve(__dirname, 'Track-codes-list.json');
    
    if (fs.existsSync(trackCodesPath)) {
      const fileContent = fs.readFileSync(trackCodesPath, 'utf8');
      const parsedData = JSON.parse(fileContent);
      
      // Process courses array
      if (parsedData.courses && Array.isArray(parsedData.courses)) {
        Logger.info(`Found ${parsedData.courses.length} tracks in Track-codes-list.json`);
        
        // Create mapping of track name (lowercase) to course ID
        parsedData.courses.forEach(course => {
          if (course.course && course.id) {
            TRACK_CODES[course.course.toLowerCase()] = course.id;
            // Also add region-qualified version for disambiguation
            if (course.region_code) {
              TRACK_CODES[`${course.course.toLowerCase()}-${course.region_code}`] = course.id;
            }
          }
        });
        
        Logger.info(`Successfully loaded ${Object.keys(TRACK_CODES).length} track codes`);
        return true;
      }
      else if (parsedData.course_list && Array.isArray(parsedData.course_list)) {
        Logger.info(`Found ${parsedData.course_list.length} tracks in course_list format`);
        
        parsedData.course_list.forEach(course => {
          if (course.name && course.id) {
            TRACK_CODES[course.name.toLowerCase()] = course.id;
          }
        });
        
        Logger.info(`Successfully loaded ${Object.keys(TRACK_CODES).length} track codes`);
        return true;
      }
      else {
        throw new Error('Track-codes-list.json has unexpected structure');
      }
    } else {
      throw new Error(`Track-codes-list.json not found at: ${trackCodesPath}`);
    }
  } catch (err) {
    Logger.error(`Failed to load track codes: ${err.message}`);
    return false;
  }
}

// Fallback to hardcoded track codes if loading fails
const FALLBACK_TRACK_CODES = {
  'catterick': 'crs_260',
  'nottingham': 'crs_1040',
  'leopardstown': 'crs_4862',
  'kempton': 'crs_28054',
  'taunton': 'crs_1898',
  'lingfield': 'crs_910',
  'limerick': 'crs_4868',
  'hereford': 'crs_778',
  'newton abbot': 'crs_1026'
};

// Find a course ID based on track name
function findCourseId(trackName) {
  if (!trackName) return null;
  
  // Clean the track name
  let cleanTrack = trackName.toLowerCase().trim();
  
  // Direct match
  if (TRACK_CODES[cleanTrack]) {
    Logger.debug(`Direct match for ${trackName}: ${TRACK_CODES[cleanTrack]}`);
    return TRACK_CODES[cleanTrack];
  }
  
  // Try removing common suffixes
  const withoutSuffix = cleanTrack
    .replace(/\\s*\\(aw\\)$/i, '')
    .replace(/\\s*\\(all weather\\)$/i, '')
    .replace(/\\s*racecourse$/i, '')
    .replace(/\\s*races$/i, '')
    .replace(/\\s*park$/i, '')
    .trim();
  
  if (TRACK_CODES[withoutSuffix]) {
    Logger.debug(`Suffix-removed match for ${trackName}: ${TRACK_CODES[withoutSuffix]}`);
    return TRACK_CODES[withoutSuffix];
  }
  
  // If track includes a hyphen, try searching for parts before and after
  if (cleanTrack.includes('-')) {
    const parts = cleanTrack.split('-');
    if (parts.length > 1) {
      if (TRACK_CODES[parts[0].trim()]) {
        Logger.debug(`Matched first part of hyphenated track: ${parts[0].trim()} -> ${TRACK_CODES[parts[0].trim()]}`);
        return TRACK_CODES[parts[0].trim()];
      }
    }
  }
  
  // Look for close matches
  // First try contains matching
  for (const [track, id] of Object.entries(TRACK_CODES)) {
    if (track.includes(withoutSuffix) || withoutSuffix.includes(track)) {
      Logger.debug(`Partial match: "${trackName}" -> "${track}" = ${id}`);
      return id;
    }
  }
  
  // Try fuzzy matching
  let bestMatch = null;
  let bestScore = 0;
  
  for (const [track, id] of Object.entries(TRACK_CODES)) {
    const simScore = calculateSimilarity(withoutSuffix, track);
    if (simScore > 0.8 && simScore > bestScore) {
      bestScore = simScore;
      bestMatch = id;
    }
  }
  
  if (bestMatch) {
    Logger.debug(`Fuzzy match for ${trackName}: ${bestMatch} (score: ${bestScore.toFixed(2)})`);
    return bestMatch;
  }
  
  // If we get here, check fallback codes
  if (FALLBACK_TRACK_CODES[cleanTrack]) {
    Logger.debug(`Using fallback code for ${trackName}: ${FALLBACK_TRACK_CODES[cleanTrack]}`);
    return FALLBACK_TRACK_CODES[cleanTrack];
  }
  
  Logger.error(`No course ID found for track: ${trackName}`);
  return null;
}

// Calculate similarity between two strings (0-1)
function calculateSimilarity(str1, str2) {
  // Convert strings to lowercase for comparison
  const s1 = String(str1).toLowerCase();
  const s2 = String(str2).toLowerCase();
  
  // Check for exact match
  if (s1 === s2) return 1.0;
  
  // If either string is empty, return 0
  if (s1.length === 0 || s2.length === 0) return 0.0;
  
  // Calculate Levenshtein distance
  const track1 = s1.replace(/[^a-z0-9]/g, '');
  const track2 = s2.replace(/[^a-z0-9]/g, '');
  
  const len1 = track1.length;
  const len2 = track2.length;
  
  // Use simplified logic for short strings
  if (Math.abs(len1 - len2) / Math.max(len1, len2) > 0.5) {
    return 0.0; // Too different in length
  }
  
  // Simplified scoring for short strings
  if (len1 < 4 || len2 < 4) {
    return track1.includes(track2) || track2.includes(track1) ? 0.9 : 0.0;
  }
  
  // Calculate the max distance there could be
  const maxDist = Math.max(len1, len2);
  
  // Calculate the actual Levenshtein distance
  const distance = levenshteinDistance(track1, track2);
  
  // Convert to a similarity score (1 is identical, 0 is completely different)
  return 1 - (distance / maxDist);
}

// Calculate Levenshtein distance between two strings
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix = [];
  
  // Initialize the matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  // Fill the matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j-1] === b[i-1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i-1][j] + 1,       // deletion
        matrix[i][j-1] + 1,       // insertion
        matrix[i-1][j-1] + cost   // substitution
      );
    }
  }
  
  return matrix[b.length][a.length];
}