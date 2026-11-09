# Canonical Webteam Bot

A Mattermost bot for the Canonical webteam.

## Installation

1. Install dependencies:

```bash
bun install
```

2. Set up configuration:
   - Copy `config.json` to `config.local.json`
   - Configure credentials (prod credentials in bitwarden)
   - When running locally with the production token, set `mattermost.websocket_enabled` to `false`. Otherwise your copy listens for chat commands next to the deployed bot and both answer. Webhooks, DMs and posts don't need the websocket.

## Development

Start the development server with hot reload:

```bash
bun run dev
```

Run in production:

```bash
bun run start
```

Build for deployment:

```bash
bun run build
```

## API Endpoints

### Health Check

- `GET /_status/check`: Returns "OK" for health monitoring

### Webhooks

- `POST /webhooks/alertmanager`: Receives Alertmanager notifications and send on COS alerts channel
- `POST /webhooks/gh-action-fail`: GitHub Actions failure notifications
- `POST /webhooks/release`: Release event notifications (notify IS of new deployments)
- `POST /webhooks/acronym`: /acronym command
- `POST /webhooks/explain`: /explain command
- `POST /webhooks/dir`: /directory command
- `POST /webhooks/meet`: /meet command
- `POST /webhooks/dead-links`: Link checker report. Direct messages the page owner listed in each page's copydoc, and posts the copydocs without a findable owner to the given room (see below)

These endpoints are also available under `/hubot` for backwards compatibility

### Dead links

`POST /webhooks/dead-links` requires an `Authorization: Bearer <dead_links.token>` header and a JSON body:

```json
{
  "room": "web-alerts",
  "run_url": "https://github.com/canonical/ubuntu.com/actions/runs/1",
  "pages": [
    {
      "page_url": "https://ubuntu.com/example",
      "copydoc_url": "https://docs.google.com/document/d/<id>/edit",
      "broken_links": [
        { "url": "https://example.com/gone", "result": "404 Not Found" }
      ]
    }
  ]
}
```

The owner is read from the "Page owner" row of the copydoc: either a person chip, or a name optionally followed by `/` or `,` and a department. The name is matched to a Mattermost user, and only an exact single match gets a DM.

Optional body fields: `dry_run` (boolean) skips the DMs for this request even if they are enabled in the config, and `omitted_pages` / `omitted_links` (integers) tell the bot how much the sender left out to keep the request under the 100 kB body limit.

Copydocs whose owner could not be found or matched (a folder instead of a document, an unreadable doc, no owner row, no or several Mattermost matches) are listed in `room`. This also happens when DMs are off. When DMs are off, nobody is messaged and nothing is said about who would have been.

Config keys (all optional, the endpoint answers 503 without a token):

- `dead_links.token`: shared secret for the endpoint
- `dead_links.send_direct_messages`: DMs are only sent when this is `true`. It defaults to off, so the endpoint is safe to deploy first
- `google_docs`: the service account key fields (`type`, `project_id`, `private_key`, `client_email`, `client_id`, `token_uri`) of an account that can read the copydocs, stored like `google_sheets`

Run the tests with `bun test`.

## Adding New Commands

See the [commands README](./commands/README.md) for detailed instructions on adding new chat commands.
