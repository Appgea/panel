# RevenueCat module

Read-only RevenueCat Charts & Metrics inside Panel. The project dashboard gets a compact
overview widget (proceeds, MRR, active subscriptions and new customers); the separate RevenueCat
rail screen adds the full overview, active users, trials, and a 90-day trend.

RevenueCat is opt-in. It is not part of Panel's default module set and makes no API calls for a
project unless that repository explicitly adds `"revenuecat"` to `.panel/modules.json`.

Each opted-in repository stores non-secret settings in `.panel/revenuecat.json`:

```json
{
  "version": 1,
  "project_id": "proj…",
  "currency": "USD",
  "revenue_type": "proceeds"
}
```

API v2 keys are never written there. The connection form uses the pasted key to discover its
RevenueCat project, verifies Projects, Overview, and Charts read access, then stores one credential
per RevenueCat project in macOS Keychain under service `com.appgea.panel.revenuecat`. The secret is
sent to the Keychain utility over stdin, not placed in process arguments. On Windows the key goes
to Windows Credential Manager as a generic credential named `com.appgea.panel.revenuecat:<project id>`,
written in-process through `advapi32`. Existing keys in the
module's gitignored state directory remain a read-only fallback and receive no new keys.

For unattended launches, `REVENUECAT_API_V2_KEY` is also accepted. If RevenueCat is already
configured as a project-scoped Claude MCP, Panel reuses that Bearer credential in-process without
copying or returning it to the webview. The local `/discover` helper can resolve the matching
project identity using the `project_configuration:projects:read` permission; it never returns the
credential. Use a V2 key with only `charts_metrics:overview:read` and
`charts_metrics:charts:read` for the dashboard flow (plus Projects read only for discovery).

Repository-local `.mcp.json` RevenueCat connections are supported as well, including remote Bearer
headers and stdio server environments using `REVENUECAT_SECRET_KEY`. Their credentials are also
read only in-process and are never copied into Panel configuration.

Responses are cached for five minutes. Today's value is always presented as provisional because
RevenueCat may still be receiving transactions for the current day.

## Guided setup

1. In the RevenueCat module, choose **Open RevenueCat API keys**.
2. Create a V2 secret key named **Panel read-only** with Projects read, Overview read, and Charts read.
3. Paste the key once and choose **Connect securely**. Panel discovers the project ID automatically.
