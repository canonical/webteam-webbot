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

These endpoints are also available under `/hubot` for backwards compatibility

## Adding New Commands

See the [commands README](./commands/README.md) for detailed instructions on adding new chat commands.
