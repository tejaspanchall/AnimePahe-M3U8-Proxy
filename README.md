# AnimePahe M3U8 Proxy

A simple Express-based proxy server designed to handle M3U8 playlists and segment requests, managing necessary headers (Referer, Origin, User-Agent) to bypass restrictions.

## Features

-   Proxies M3U8 playlists and rewrites internal segment/playlist URLs to route through the proxy.
-   Handles CORS and custom headers.
-   Includes a playground for testing URLs.

## Installation

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```

## Usage

Start the server:

```bash
npm start
```

The server listens on port `3000` by default (configurable via `PORT` environment variable or `config.js`).

## Environment Variables

You can configure the server using a `.env` file. Copy `.env.example` to `.env` and adjust the values:

-   `PORT`: The port the server should listen on (default: `3000`).
-   `ALLOWED_ORIGINS`: Comma-separated list of allowed origins for CORS (e.g., `http://localhost:3000,https://your-domain.com`). If not set, it defaults to allowing all origins (depending on your specific implementation in `config.js`, currently defaults to empty array which usually implies specific handling or open access depending on middleware logic).

## Endpoints

### `GET /`
Opens the testing playground.

### `GET /m3u8-proxy`
Proxies a specific URL.

**Query Parameters:**
-   `url`: The absolute URL of the M3U8 file or segment to proxy.
-   `headers` (optional): JSON-encoded object of additional headers to send to the upstream server.

**Example:**
```
http://localhost:3000/m3u8-proxy?url=https://example.com/video.m3u8
```

## Configuration

Configuration is handled in `config.js`. You can modify:
-   `PORT`: Server port.
-   `DEFAULT_REFERER`: Default referer header sent upstream.
-   `FORWARD_HEADERS`: Headers to forward from the client request.
