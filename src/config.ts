import dotenv from 'dotenv';
import pino from 'pino';

// Load environment variables from .env file
dotenv.config();

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'github-slack-mapper' }
});


// --- Configuration from Environment Variables ---
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET!;
export const SLACK_WEBHOOK_SECRET = process.env.SLACK_WEBHOOK_SECRET!;
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const TWO_APPROVAL_REPOS_RAW = process.env.TWO_APPROVAL_REPOS_LIST || '';
export const PORT = parseInt(process.env.PORT || '3000', 10)!;
export const DB_PATH = process.env.SQLITE_DB_PATH || '/app/data/bot.db';


if (!GITHUB_WEBHOOK_SECRET || !SLACK_BOT_TOKEN || !TWO_APPROVAL_REPOS_RAW || !DB_PATH) {
    console.error("ERROR: Missing essential environment variables. Check .env file.");
    process.exit(1);
}


export const TWO_APPROVAL_REPOS = new Set(
    TWO_APPROVAL_REPOS_RAW
        .split(',')
        .map(repo => repo.trim())
        .filter(Boolean)
);

// Emoji constants
export const MERGED = "merged"
export const APPROVED = "white_check_mark"
export const CLOSED = "x"
export const COMMENTED = "speech_balloon"
export const READY_TO_MERGE = "rocket"
export const PARTIAL_APPROVAL = "one"
export const NEEDS_REVIEW = "warning"

// Other constants
export const THREE_DAYS_IN_SECONDS = 259200
