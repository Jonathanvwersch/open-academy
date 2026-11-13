# API contracts

- Own browser-safe request/response schemas and DTOs. Keep helper algorithms in shared and server/provider internals in the API.
- Export public modules explicitly in `package.json`. Import no application, filesystem, database client or provider SDK.
- Coordinate contract changes with producers and consumers. Do not expose answer keys by moving server content models here.
