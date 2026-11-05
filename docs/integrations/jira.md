# Jira (work)

Ships **disabled**. **Ask your IT team before connecting these.** Your workplace may have rules about API tokens.

## Polling (no admin needed)

Create an API token with scopes (Jira, `read:jira-work` and `read:jira-user`, 365 days; `/myself` needs the second, checked 2026-10-28), then paste your site (`yourteam.atlassian.net`), your
Atlassian email and the token. Every 3 minutes the relay:

1. (first poll only) `GET https://<site>/_edge/tenant_info` for the cloud id and `GET …/myself` for your account id;
2. `POST https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/search/jql` with Basic auth `email:token` and the JQL
   `(assignee = currentUser() OR watcher = currentUser()) AND updated >= -Nm ORDER BY updated ASC`, with
   `expand: changelog`.

The window is relative, so no timezone is involved. The first poll only records the cursor (no backlog). The cursor never
moves backward, and a 5 minute overlap is absorbed by the dedup keys (`jira:<KEY>:cl<history id>`, `…:c<comment id>`).
Your own changes and comments are skipped. Only `*.atlassian.net` sites are accepted. Ten failures in a row pause the
connection with a note in the Inbox.

Kinds: `jira.assigned` (high), `jira.comment`, `jira.status`.

## Optional: real time with an Automation rule (project admin)

Add a rule with a **Send web request** action: method POST, URL = the connection URL, header
`Authorization: Bearer <connection secret>`, body:

```json
{
  "kind": "assigned",
  "issue": {
    "key": "{{issue.key}}",
    "summary": "{{issue.summary.jsonEncode}}",
    "status": "{{issue.status.name}}"
  },
  "initiator": "{{initiator.displayName.jsonEncode}}",
  "comment": "{{comment.body.jsonEncode}}"
}
```

`jsonEncode` (Atlassian smart values, text fields, checked 2026-10-28) escapes quotes and line breaks so a comment cannot add keys to the body. The relay ignores any URL or `talos` key in the body: links are built from your configured site. Use `"kind": "comment"` or `"status"` in rules with those triggers. **The smart values are an inference from Atlassian's
documentation and have not been run against a real site: test the rule before relying on it.** An admin webhook
(`X-Hub-Signature: sha256=…`, `X-Atlassian-Webhook-Identifier`) is also accepted.
