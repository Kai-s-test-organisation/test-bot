import Database, { Database as DB, Statement } from 'better-sqlite3';
import {logger, DB_PATH} from "./config.js";

export class GithubSlackMapper {
    private db: DB;
    private getUserStmt!: Statement<[string]>;
    private setUserStmt!: Statement<[string, string]>;
    private deleteUserStmt!: Statement<[string]>;

    private getTeamChannelsStmt!: Statement<[string]>;
    private addTeamChannelStmt!: Statement<[string, string]>;
    private removeTeamChannelStmt!: Statement<[string, string]>;
    private removeAllTeamChannelsStmt!: Statement<[string]>;

    constructor(dbPath: string = DB_PATH) {
        logger.info({ dbPath }, 'Initializing GitHub-Slack mapper');

        try {
            this.db = new Database(dbPath);
            this._initializeTables();
            this._prepareStatements();

            logger.info({ dbPath }, 'GitHub-Slack mapper initialized successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, dbPath }, 'Failed to initialize GitHub-Slack mapper');
            throw error;
        }
    }

    private _initializeTables() {
        logger.debug('Creating database tables if they do not exist');

        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS GithubToSlackUser (
                    github_username TEXT PRIMARY KEY,
                    slack_username TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS GithubTeamToSlackChannel (
                    github_team TEXT NOT NULL,
                    slack_channel TEXT NOT NULL,
                    PRIMARY KEY (github_team, slack_channel)
                );
            `);

            logger.debug('Database tables created successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage }, 'Failed to create database tables');
            throw error;
        }
    }

    private _prepareStatements() {
        logger.debug('Preparing SQL statements');

        try {
            // User mapping statements
            this.getUserStmt = this.db.prepare(
                'SELECT slack_username FROM GithubToSlackUser WHERE github_username = ?'
            );
            this.setUserStmt = this.db.prepare(`
                INSERT INTO GithubToSlackUser (github_username, slack_username)
                VALUES (?, ?)
                ON CONFLICT(github_username) DO UPDATE SET slack_username = excluded.slack_username
            `);
            this.deleteUserStmt = this.db.prepare(
                'DELETE FROM GithubToSlackUser WHERE github_username = ?'
            );

            // Team to channel mapping statements (supporting multiple channels per team)
            this.getTeamChannelsStmt = this.db.prepare(
                'SELECT slack_channel FROM GithubTeamToSlackChannel WHERE github_team = ?'
            );
            this.addTeamChannelStmt = this.db.prepare(`
                INSERT OR IGNORE INTO GithubTeamToSlackChannel (github_team, slack_channel)
                VALUES (?, ?)
            `);
            this.removeTeamChannelStmt = this.db.prepare(
                'DELETE FROM GithubTeamToSlackChannel WHERE github_team = ? AND slack_channel = ?'
            );
            this.removeAllTeamChannelsStmt = this.db.prepare(
                'DELETE FROM GithubTeamToSlackChannel WHERE github_team = ?'
            );

            logger.debug('SQL statements prepared successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage }, 'Failed to prepare SQL statements');
            throw error;
        }
    }

    // User mapping methods
    getSlackUsername(githubUsername: string): string | null {
        logger.debug({ githubUsername }, 'Looking up Slack username for GitHub user');

        try {
            const row = this.getUserStmt.get(githubUsername) as { slack_username: string } | undefined;
            const slackUsername = row?.slack_username ?? null;

            if (slackUsername) {
                logger.debug({ githubUsername, slackUsername }, 'Found Slack username mapping');
            } else {
                logger.debug({ githubUsername }, 'No Slack username mapping found');
            }

            return slackUsername;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, githubUsername }, 'Failed to lookup Slack username');
            throw error;
        }
    }

    setSlackUsername(githubUsername: string, slackUsername: string): void {
        logger.info({ githubUsername, slackUsername }, 'Setting GitHub user to Slack user mapping');

        try {
            const result = this.setUserStmt.run(githubUsername, slackUsername);

            if (result.changes > 0) {
                logger.info({ githubUsername, slackUsername, changes: result.changes }, 'User mapping updated successfully');
            } else {
                logger.warn({ githubUsername, slackUsername }, 'User mapping update had no effect');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, githubUsername, slackUsername }, 'Failed to set user mapping');
            throw error;
        }
    }

    deleteSlackUsername(githubUsername: string): void {
        logger.info({ githubUsername }, 'Deleting GitHub user mapping');

        try {
            const result = this.deleteUserStmt.run(githubUsername);

            if (result.changes > 0) {
                logger.info({ githubUsername, changes: result.changes }, 'User mapping deleted successfully');
            } else {
                logger.warn({ githubUsername }, 'No user mapping found to delete');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, githubUsername }, 'Failed to delete user mapping');
            throw error;
        }
    }

    // Team to channel mapping methods (supporting multiple channels per team)
    getSlackChannels(githubTeam: string): string[] {
        logger.debug({ githubTeam }, 'Looking up Slack channels for GitHub team');

        try {
            const rows = this.getTeamChannelsStmt.all(githubTeam) as { slack_channel: string }[];
            const channels = rows.map(row => row.slack_channel);

            logger.debug({ githubTeam, channelCount: channels.length, channels }, 'Found Slack channel mappings');

            return channels;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, githubTeam }, 'Failed to lookup Slack channels');
            throw error;
        }
    }

    addSlackChannel(githubTeam: string, slackChannel: string): void {
        logger.info({ githubTeam, slackChannel }, 'Adding GitHub team to Slack channel mapping');

        try {
            const result = this.addTeamChannelStmt.run(githubTeam, slackChannel);

            if (result.changes > 0) {
                logger.info({ githubTeam, slackChannel }, 'Team channel mapping added successfully');
            } else {
                logger.debug({ githubTeam, slackChannel }, 'Team channel mapping already exists');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, githubTeam, slackChannel }, 'Failed to add team channel mapping');
            throw error;
        }
    }

    removeSlackChannel(githubTeam: string, slackChannel: string): void {
        logger.info({ githubTeam, slackChannel }, 'Removing GitHub team to Slack channel mapping');

        try {
            const result = this.removeTeamChannelStmt.run(githubTeam, slackChannel);

            if (result.changes > 0) {
                logger.info({ githubTeam, slackChannel }, 'Team channel mapping removed successfully');
            } else {
                logger.warn({ githubTeam, slackChannel }, 'No team channel mapping found to remove');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, githubTeam, slackChannel }, 'Failed to remove team channel mapping');
            throw error;
        }
    }

    removeAllSlackChannels(githubTeam: string): void {
        logger.info({ githubTeam }, 'Removing all Slack channel mappings for GitHub team');

        try {
            const result = this.removeAllTeamChannelsStmt.run(githubTeam);

            logger.info({ githubTeam, removedCount: result.changes }, 'Team channel mappings removed');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, githubTeam }, 'Failed to remove all team channel mappings');
            throw error;
        }
    }

    setSlackChannels(githubTeam: string, slackChannels: string[]): void {
        logger.info({ githubTeam, channelCount: slackChannels.length, channels: slackChannels }, 'Setting all Slack channels for GitHub team');

        try {
            // Remove all existing mappings for this team
            this.removeAllSlackChannels(githubTeam);

            // Add new mappings
            for (const channel of slackChannels) {
                this.addSlackChannel(githubTeam, channel);
            }

            logger.info({ githubTeam, channelCount: slackChannels.length }, 'Team channel mappings updated successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, githubTeam, channels: slackChannels }, 'Failed to set team channel mappings');
            throw error;
        }
    }

    // Batch resolvers
    getSlackChannelsByGithubTeams(teams: string[]): string[] {
        if (teams.length === 0) {
            logger.debug('No GitHub teams provided for channel lookup');
            return [];
        }

        logger.debug({ teamCount: teams.length, teams }, 'Looking up Slack channels for multiple GitHub teams');

        try {
            const placeholders = teams.map(() => '?').join(', ');
            const stmt = this.db.prepare(
                `SELECT DISTINCT slack_channel FROM GithubTeamToSlackChannel WHERE github_team IN (${placeholders})`
            );
            const rows = stmt.all(...teams) as { slack_channel: string }[];
            const channels = rows.map(row => row.slack_channel);

            logger.debug({ teamCount: teams.length, channelCount: channels.length, channels }, 'Found Slack channels for GitHub teams');

            return channels;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, teams }, 'Failed to lookup channels for multiple teams');
            throw error;
        }
    }

    getSlackUsernamesByGithubUsers(usernames: string[]): string[] {
        if (usernames.length === 0) {
            logger.debug('No GitHub usernames provided for lookup');
            return [];
        }

        logger.debug({ userCount: usernames.length, usernames }, 'Looking up Slack usernames for multiple GitHub users');

        try {
            const placeholders = usernames.map(() => '?').join(', ');
            const stmt = this.db.prepare(
                `SELECT slack_username FROM GithubToSlackUser WHERE github_username IN (${placeholders})`
            );
            const rows = stmt.all(...usernames) as { slack_username: string }[];
            const slackUsernames = rows.map(row => row.slack_username);

            logger.debug({
                requestedCount: usernames.length,
                foundCount: slackUsernames.length,
                slackUsernames
            }, 'Found Slack usernames for GitHub users');

            return slackUsernames;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage, usernames }, 'Failed to lookup usernames for multiple users');
            throw error;
        }
    }

    isHealthy(): boolean {
        try {
            this.db.prepare('SELECT 1').get();
            logger.debug('Database health check passed');
            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage }, 'Database health check failed');
            return false;
        }
    }

}

export const mapper = new GithubSlackMapper();