# Racing Results Updater

A Node.js script to update racing bet results by fetching horse racing data from theracingapi.com and updating bet statuses in Supabase.

## Major Improvements

The latest version includes several key improvements:

1. **Enhanced Track Name Matching**:
   - Advanced fuzzy matching algorithms to find track IDs even with spelling variations
   - Support for track name aliases and common name variations
   - Tolerance for suffixes, prefixes, and regional indicators (AW, UK, IRE, etc.)

2. **Improved Multiple Bet Processing**:
   - Proper handling of multiple bet selections with different tracks
   - Better status handling for partially matched multiples
   - Correct calculations for void legs and reduced bets

3. **Robust API Request System**:
   - Improved error handling and retry logic
   - More detailed debug information
   - Longer delays between requests to avoid rate limiting
   - Better extraction of horse data from API responses

4. **Better Horse Name Matching**:
   - Multiple matching strategies (exact, simplified, fuzzy)
   - Handles country codes and other common suffixes in horse names
   - Improved Levenshtein distance matching for similar names

## How It Works

1. The script loads a JSON file with track codes mapping track names to their API IDs
2. Fetches all pending bets from Supabase
3. Groups bets by track and date to minimize API calls
4. Fetches race results for each track from theracingapi.com
5. Matches horses from bets to horses in the results
6. Updates bet status, returns, and other fields in Supabase

## Usage

1. Make sure all dependencies are installed:
   ```
   npm install
   ```

2. Set up environment variables (or use the defaults in the script):
   ```
   SUPABASE_URL=your_supabase_url
   SUPABASE_KEY=your_supabase_key
   RACING_API_USERNAME=your_racing_api_username
   RACING_API_PASSWORD=your_racing_api_password
   ```

3. Run the script:
   ```
   node bet-results-updater.js
   ```

4. Check the logs for detailed information about the process.

## Files

- `bet-results-updater.js` - The main script
- `improved-track-matcher.js` - Enhanced track name matching
- `improved-multiple-handler.js` - Better multiple bet handling
- `improved-api-request.js` - Improved API request logic
- `Track-codes-list.json` - JSON file with track name to ID mappings

## Troubleshooting

- If you see 404 errors, check that the track name is correctly matched to a course ID
- If you see rate limit errors, increase the delay between API calls
- If horses aren't matching, check the simplified names being used for comparison

For debugging, the script saves API responses and extracted horse data to JSON files.