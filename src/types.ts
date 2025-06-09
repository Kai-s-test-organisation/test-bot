// --- Type Definitions ---
export interface GitHubTeam {
    id: number;
    name: string;
    slug: string;
}

export interface GitHubUser {
    login: string;
    id: number;
}

export interface GitHubPullRequest {
    html_url: string;
    title: string;
    user: GitHubUser;
    requested_reviewers: GitHubUser[];
    requested_teams: GitHubTeam[];
    number: number;
    merged: boolean;
}

export interface GitHubRepository {
    id: number;
    name: string;
}

export interface PullRequestWebhookPayload {
    action: string;
    pull_request: GitHubPullRequest;
    repository: GitHubRepository;
}

export interface ReviewWebhookPayload {
    action: string;
    pull_request: GitHubPullRequest;
    repository: GitHubRepository;
    review: {
        state: 'approved' | 'changes_requested' | 'commented';
        user: GitHubUser;
    };
}

export interface IssueCommentWebhookPayload {
    action: string;
    issue: {
        number: number;
        pull_request?: {
            html_url: string;
        };
    };
    repository: GitHubRepository;
    comment: {
        user: GitHubUser;
    };
}

export interface RedisStoredData {
    channel: string;
    ts: string;
}