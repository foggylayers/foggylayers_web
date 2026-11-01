# Facebook publishing

The website has an owner publishing page at **https://foggylayers.com/admin/facebook/** and a private API for text, website-link, or single-photo posts. Publishing is disabled by default. No Facebook credentials belong in GitHub or in the website's public JavaScript.

## Set up Cloudflare

Open the **foggylayers-web** Worker in Cloudflare → **Settings → Variables and Secrets**. Add these as **Secret** values:

| Secret | Value |
| --- | --- |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | A Meta Page access token for the Foggy Layers Page, ID `61596052263830`. Use a Page token, not a personal user token. |
| `FACEBOOK_APP_SECRET` | The app secret from the Meta app that issued the Page token. Used to sign Graph requests with `appsecret_proof`. |
| `FACEBOOK_ADMIN_TOKEN` | A separate random password for this publisher: 43–128 URL-safe letters, numbers, underscores, or hyphens. Generate one locally, for example with `openssl rand -hex 32`, and keep it in a password manager. |

Enter those values directly in Cloudflare. Do not paste them into a chat, a commit, a URL, or an issue. The admin page takes only the separate **admin token**; it never needs your Meta Page token or app secret.

Wrangler provisions the `FacebookPublisher` SQLite Durable Object namespace when this code deploys. The entry point uses Cloudflare's `ctx.exports` loopback namespace internally as `FACEBOOK_PUBLISHER`, so there is no manual binding or database ID to enter. Each draft has its own persistent record containing its content, publishing state, and receipt, without credentials. The `previews` configuration enables isolated branch Previews; Page credentials are configured separately in production.

## Get a Meta Page token

Use a Meta app authorized to manage the Foggy Layers Page. Page publishing requires `pages_manage_posts` and applicable Page read access such as `pages_read_engagement`; `pages_show_list` is used when discovering Pages through `/me/accounts`. Your Meta account must have the relevant Page task/access, and app mode, access levels, review, and business verification requirements depend on your app and who uses it.

Use Meta's [Pages API documentation](https://developers.facebook.com/docs/pages-api/) and official [Get specific Page access token example](https://www.postman.com/meta/facebook/request/tass6hw/get-specific-page-access-token). Meta's official [Page SDK source](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py) defines the feed and photo operations used here. The configured version is `v26.0`; review Meta's version and permission requirements when maintaining the integration.

This feature creates Page posts. It does not change the Page bio or cover image, read private messages, or schedule posts.

## Verify before enabling

1. Deploy the code and add the three secrets.
2. Open **https://foggylayers.com/admin/facebook/** and enter the publishing **admin token**.
3. Connect. The server makes a read-only `/me` request and verifies that the token belongs to Page `61596052263830`. A personal token or a token for another Page is rejected.
4. Compose and review a draft. Review only saves the draft; it never publishes it. A photo URL must be an existing JPG or PNG under `https://foggylayers.com/images/`. The picker lists the catalog's photos. The preview cannot reproduce Facebook's exact link rendering.
5. When you are ready to allow posting, change `FACEBOOK_PUBLISHING_ENABLED` from `"false"` to `"true"` in **wrangler.jsonc**, commit it, and let Cloudflare deploy. Keep this setting in the repository so future builds preserve it. Then reconnect the admin page.
6. Review the saved content, check the confirmation box, and choose **Publish to Facebook**. This final action creates a real public Page post.

No live Facebook post was made as part of implementing this feature. Real token permissions can only be verified after you configure the secrets.

To pause publishing, set the flag back to `"false"` and redeploy. Rotate either token by replacing its Cloudflare secret. Disconnect or close the admin tab when finished; its token is kept in memory only, without cookies or browser storage.

## Private API

Every route below requires `Authorization: Bearer <FACEBOOK_ADMIN_TOKEN>`. Never put a credential in a query string. Browser requests must come from the same origin. Server clients may omit `Origin`. Responses are `Cache-Control: no-store`; these routes do not enable CORS.

| Method and path | Behavior |
| --- | --- |
| `GET /api/admin/facebook/status` | Reports configuration state and missing setting names, without secret values. |
| `GET /api/admin/facebook/connection` | Verifies the Page identity without publishing. Works while publishing is disabled. |
| `POST /api/admin/facebook/drafts` | Saves an immutable draft. JSON: `requestId` (UUID v4), `message` (1–5,000 characters), optional `imageUrl` or `linkUrl`. |
| `GET /api/admin/facebook/drafts/{requestId}` | Returns the saved content, state, and receipt if published. |
| `POST /api/admin/facebook/drafts/{requestId}/publish` | Publishes that saved content only when enabled. JSON must contain `{"confirm":true}`. |

Use only a website link or a photo field, not both; a website URL can be written into a photo's message instead. Link fields are restricted to HTTPS URLs on `foggylayers.com` without query strings or fragments. Message content is posted as entered and must be reviewed before confirming.

Reusing a draft ID with the same content returns its existing record; different content returns a conflict. Drafts older than 24 hours need a fresh review under a new ID. Keep the draft ID before publishing. The UI also has **Check an existing draft** to recover a result after reloading.

Before calling Facebook, a storage transaction permanently marks the draft as attempted. Concurrent requests and subsequent retries cannot send that same draft again. A successful retry returns the stored receipt. An explicit Graph rejection becomes `rejected`; a timeout, lost response, malformed receipt, or failed receipt write becomes `uncertain` or remains `publishing`. Those states never automatically resend. **Check the actual Facebook Page before creating a new draft after an unconfirmed attempt.** A new ID is a different draft, so reusing the same message with a new ID can still create a duplicate.

Graph calls go only to `graph.facebook.com` over HTTPS. The Page token stays in the Authorization header; requests include an HMAC `appsecret_proof`. Provider error bodies and exception messages are not echoed or logged by this code.

## Development checks

Run `npm test`, `npm run build`, `npm run check`, and `npx wrangler deploy --dry-run`. Automated tests use fake Graph responses, including concurrent calls, ambiguous failures, and receipt-write failures. They never contact or publish to Facebook.
