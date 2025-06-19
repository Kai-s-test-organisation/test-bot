import Database, { Database as DB, Statement } from 'better-sqlite3';

export class GithubSlackMapper {
    private db: DB;
    private getUserStmt: Statement<[string]>;
    private setUserStmt: Statement<[string, string]>;
    private deleteUserStmt: Statement<[string]>;

    private getTeamStmt: Statement<[string]>;
    private setTeamStmt: Statement<[string, string]>;
    private deleteTeamStmt: Statement<[string]>;

    constructor(dbPath: string = 'mappings.db') {
        this.db = new Database(dbPath);
        this._initializeTables();

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

        this.getTeamStmt = this.db.prepare(
            'SELECT slack_channel FROM GithubTeamToSlackChannel WHERE github_team = ?'
        );
        this.setTeamStmt = this.db.prepare(`
            INSERT INTO GithubTeamToSlackChannel (github_team, slack_channel)
            VALUES (?, ?)
            ON CONFLICT(github_team) DO UPDATE SET slack_channel = excluded.slack_channel
        `);
        this.deleteTeamStmt = this.db.prepare(
            'DELETE FROM GithubTeamToSlackChannel WHERE github_team = ?'
        );
    }

    private _initializeTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS GithubToSlackUser (
                github_username TEXT PRIMARY KEY,
                slack_username TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS GithubTeamToSlackChannel (
                github_team TEXT PRIMARY KEY,
                slack_channel TEXT NOT NULL
            );
        `);
    }

    // Single-value getters
    getSlackUsername(githubUsername: string): string | null {
        const row = this.getUserStmt.get(githubUsername) as { slack_username: string } | undefined;
        return row?.slack_username ?? null;
    }

    getSlackChannel(githubTeam: string): string | null {
        const row = this.getTeamStmt.get(githubTeam) as { slack_channel: string } | undefined;
        return row?.slack_channel ?? null;
    }

    // Setters
    setSlackUsername(githubUsername: string, slackUsername: string): void {
        this.setUserStmt.run(githubUsername, slackUsername);
    }

    setSlackChannel(githubTeam: string, slackChannel: string): void {
        this.setTeamStmt.run(githubTeam, slackChannel);
    }

    // Deleters
    deleteSlackUsername(githubUsername: string): void {
        this.deleteUserStmt.run(githubUsername);
    }

    deleteSlackChannel(githubTeam: string): void {
        this.deleteTeamStmt.run(githubTeam);
    }

    // Batch resolvers (correct direction: GitHub → Slack)
    getSlackChannelsByGithubTeams(teams: string[]): string[] {
        if (teams.length === 0) return [];

        const placeholders = teams.map(() => '?').join(', ');
        const stmt = this.db.prepare(
            `SELECT slack_channel FROM GithubTeamToSlackChannel WHERE github_team IN (${placeholders})`
        );
        const rows = stmt.all(...teams) as { slack_channel: string }[];
        return rows.map(row => row.slack_channel);
    }

    getSlackUsernamesByGithubUsers(usernames: string[]): string[] {
        if (usernames.length === 0) return [];

        const placeholders = usernames.map(() => '?').join(', ');
        const stmt = this.db.prepare(
            `SELECT slack_username FROM GithubToSlackUser WHERE github_username IN (${placeholders})`
        );
        const rows = stmt.all(...usernames) as { slack_username: string }[];
        return rows.map(row => row.slack_username);
    }
}

export const mapper = new GithubSlackMapper();