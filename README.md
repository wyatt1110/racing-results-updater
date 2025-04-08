# Racing Results Updater

Automated system to update betting results from The Racing API into a Supabase database.

## Features

- Fetches race results from The Racing API
- Updates bet records in Supabase with results and returns
- Calculates CLV (Closing Line Value) for each bet
- Runs automatically on GitHub Actions hourly between 1pm and 11pm UTC
- Handles win, place, and each-way bets

## Setup

### Prerequisites

- Node.js 18 or later
- Supabase account with a database containing a `bets` table
- API key for The Racing API

### Environment Variables

Create a `.env` file in the project root (for local development) or set up GitHub Secrets (for GitHub Actions):

```
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
RACING_API_KEY=your_racing_api_key
```

### Installation

```bash
git clone https://github.com/wyatt1110/racing-results-updater.git
cd racing-results-updater
npm install
```

## Usage

### Run Locally

```bash
node bet-results-updater.js
```

### GitHub Actions

The workflow is set to run automatically every hour between 1pm and 11pm UTC.

You can also trigger it manually from the "Actions" tab in your GitHub repository.

## Supabase Schema

The script expects a `bets` table with the following schema:

```sql
CREATE TABLE bets (
  id UUID PRIMARY KEY,
  selection TEXT NOT NULL,
  track TEXT NOT NULL,
  date DATE NOT NULL,
  stake NUMERIC NOT NULL,
  odds NUMERIC NOT NULL,
  bet_type TEXT NOT NULL,
  settled BOOLEAN DEFAULT false,
  result TEXT,
  returns NUMERIC,
  bsp NUMERIC,
  clv NUMERIC,
  clv_stake NUMERIC,
  finishing_position TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);
```

## License

ISC