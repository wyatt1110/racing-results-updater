# Racing Results Updater

A Node.js script for automating the updating of horse racing bet results by fetching data from The Racing API and updating a Supabase database.

## Features

- **Track-specific API calls** for precise race results
- **Group processing** by track name and date
- **Multiple horse bet handling** with specialized processing for accurate results
- **Enhanced horse name matching** with multiple strategies
- **Error resilience** with fallbacks and comprehensive error handling
- **Improved ovr_btn calculation** for multiple horse bets (summing instead of averaging)
- **Horse ID tracking** for better data integration and analysis

## How It Works

The script performs the following operations:

1. Loads track codes from a JSON file or falls back to hardcoded essential tracks
2. Fetches pending bets from Supabase database
3. Groups bets by track and date for efficient processing
4. For each track, calls The Racing API with appropriate course IDs
5. Processes each bet by matching horses using multiple matching strategies
6. Updates the Supabase database with results, including:
   - Bet status (Won/Lost/Placed/Void)
   - Returns and profit/loss
   - Starting price (SP)
   - Overall beaten distance (ovr_btn)
   - Finish positions
   - Horse IDs for tracking

## Recent Improvements

- **Better horse IDs tracking**: The script now captures horse_id from API results and saves it to Supabase for both single and multiple bets
- **Improved ovr_btn calculation**: For multiple bets, the ovr_btn value is now the sum of all horse distances, providing a more accurate total distance metric
- **More accurate multiple bet processing**: Better handling of complex betting scenarios with multiple horses

## Usage

1. Ensure your environment variables are set in a `.env` file:
   ```
   SUPABASE_URL=your_supabase_url
   SUPABASE_KEY=your_supabase_key
   RACING_API_USERNAME=your_api_username
   RACING_API_PASSWORD=your_api_password
   ```

2. Run the script:
   ```
   node bet-results-updater.js
   ```

## Dependencies

- @supabase/supabase-js
- axios
- dotenv

## Structure

The project has a modular architecture with specialized components:

- **bet-results-updater.js**: Main script that coordinates the entire process
- **improved-track-matcher.js**: Specialized module for matching track names
- **improved-api-request.js**: Handles API requests with robust error handling
- **improved-multiple-handler.js**: Processes bets with multiple horses

## Requirements

- Node.js 12+
- Active Supabase account
- Valid Racing API credentials