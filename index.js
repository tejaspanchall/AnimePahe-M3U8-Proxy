import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import nodeFetch from 'node-fetch';


const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

// Internal Cookie Jar for session persistence across requests
const cookieJar = new Map();

app.listen(PORT, () => {
    console.log("Server Listening on PORT:", PORT);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'html', 'playground.html'));
});

app.get("/m3u8-proxy", async (req, res) => {
    let responseSent = false;
    const safeSendResponse = (statusCode, data) => {
        try {
            if (!responseSent) {
                responseSent = true;
                res.status(statusCode).send(data);
            }
        } catch (err) { }
    };

    try {
        const urlStr = req.query.url;
        if (!urlStr) return safeSendResponse(400, { message: "URL is required" });

        const url = new URL(urlStr);
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        let directReferer = req.query.referer || req.query.referrer;

        // Modern User-Agent from a working proxy example
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

        const headers = {
            "User-Agent": userAgent,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Connection": "keep-alive"
        };

        // Forward critical headers from client if present
        const forwardHeaders = ['range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'authorization', 'cookie'];
        forwardHeaders.forEach(h => {
            if (req.headers[h]) headers[h] = req.headers[h];
        });

        // Apply headers from query param (takes precedence)
        if (headersParam) {
            try {
                const additionalHeaders = JSON.parse(headersParam);
                Object.entries(additionalHeaders).forEach(([key, value]) => {
                    const lk = key.toLowerCase();
                    headers[lk] = value;
                    if (lk === 'referer' || lk === 'referrer') directReferer = value;
                });
            } catch (e) { }
        }

        // Referer & Origin Parity: many servers block localhost. Use target domain if missing.
        if (directReferer) {
            let refStr = decodeURIComponent(directReferer);
            if (refStr.includes('kwik.cx') && !refStr.endsWith('/')) {
                refStr += '/'; // Kwik often requires the trailing slash
            }
            headers['referer'] = refStr;
        }

        if (headers['referer']) {
            try {
                headers['origin'] = new URL(headers['referer']).origin;
            } catch (e) {
                headers['origin'] = headers['referer'];
            }
        }

        // Final fallback: never send localhost as origin
        if (!headers['origin'] || headers['origin'].includes('localhost')) {
            headers['origin'] = url.origin;
        }
        if (!headers['referer']) {
            headers['referer'] = url.origin;
        }

        // INJECT STORED COOKIES (Session Persistence)
        const storedCookies = cookieJar.get(url.hostname);
        if (storedCookies) {
            headers['cookie'] = headers['cookie'] ? `${headers['cookie']}; ${storedCookies}` : storedCookies;
        }

        if (url.pathname.endsWith(".mp4")) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        } else {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
        }

        const isPlaylist = url.pathname.toLowerCase().endsWith(".m3u8");
        const isKey = url.pathname.toLowerCase().includes('.key');

        console.log(`[m3u8-proxy] Fetching: ${url.href}`);
        // console.log(`[m3u8-proxy] Headers:`, JSON.stringify(headers));

        const targetResponse = await nodeFetch(url.href, {
            headers,
            redirect: 'follow',
            compress: false
        });

        // CAPTURE SET-COOKIE for future requests in this session
        const setCookie = targetResponse.headers.raw()['set-cookie'];
        if (setCookie) {
            const current = cookieJar.get(url.hostname) || "";
            const merged = [...new Set([...current.split('; '), ...setCookie.map(c => c.split(';')[0])])].filter(Boolean).join('; ');
            cookieJar.set(url.hostname, merged);
            console.log(`[m3u8-proxy] Session Updated: ${url.hostname}`);
        }

        // CORS Setup: browsers require specific origin if credentials=true
        const origin = req.headers.origin || '*';
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Range, Authorization, Cookie');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Proxy-By', 'm3u8-proxy');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        if (isPlaylist || targetResponse.headers.get('content-type')?.includes("mpegURL")) {
            console.log(`[m3u8-proxy] Playlist Mode [Status: ${targetResponse.status}]`);
            let content = await targetResponse.text();

            content = content.split("\n").map((line) => {
                const trimmed = line.trim();
                if (trimmed === '' || trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-VERSION")) return line;

                if (trimmed.startsWith("#")) {
                    return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, p1, suffix) => {
                        try {
                            const abs = new URL(p1, url.href).href;
                            let p = `/m3u8-proxy?url=${encodeURIComponent(abs)}`;
                            if (headersParam) p += `&headers=${encodeURIComponent(headersParam)}`;
                            if (directReferer) p += `&referer=${encodeURIComponent(directReferer)}`;
                            return `${prefix}${p}${suffix}`;
                        } catch (e) { return match; }
                    });
                }

                try {
                    const abs = new URL(trimmed, url.href).href;
                    let p = `/m3u8-proxy?url=${encodeURIComponent(abs)}`;
                    if (headersParam) p += `&headers=${encodeURIComponent(headersParam)}`;
                    if (directReferer) p += `&referer=${encodeURIComponent(directReferer)}`;
                    return p;
                } catch (e) { return line; }
            }).join("\n");

            res.setHeader('Content-Type', targetResponse.headers.get("Content-Type") || "application/vnd.apple.mpegurl");
            res.status(200).send(content);
        } else {
            // Binary content (segments, keys, etc.)
            const type = targetResponse.headers.get('content-type') || "application/octet-stream";
            const len = targetResponse.headers.get('content-length');

            // Safety check: detect HTML error pages masquerading as video
            const isLikelyErrorPage = (
                type.includes('text/html') ||
                (len && parseInt(len) < 2000)
            );

            if (isLikelyErrorPage && len && parseInt(len) < 2000) {
                // Peek at small responses to catch error pages
                const clone = targetResponse.clone();
                const text = await clone.text();
                if (text.includes('<html') || text.includes('<!DOCTYPE')) {
                    console.error(`[m3u8-proxy] ERROR PAGE DETECTED: ${text.substring(0, 500)}`);
                    return safeSendResponse(502, { message: "Upstream returned error page", body: text.substring(0, 1000) });
                }
            }

            // Enhanced logging for debugging
            const logInfo = {
                status: targetResponse.status,
                contentType: type,
                contentLength: len || 'chunked',
                path: url.pathname.substring(url.pathname.lastIndexOf('/') + 1)
            };
            console.log(`[m3u8-proxy] Binary Mode:`, JSON.stringify(logInfo));

            // Forward all relevant headers from upstream
            targetResponse.headers.forEach((v, k) => {
                const lk = k.toLowerCase();
                if (['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].includes(lk)) {
                    res.setHeader(k, v);
                }
            });

            res.writeHead(targetResponse.status);
            if (targetResponse.body) {
                targetResponse.body.pipe(res);
            } else {
                res.end();
            }
        }
    } catch (e) {
        console.error('[m3u8-proxy] Error:', e.message);
        if (!res.headersSent) safeSendResponse(500, { message: e.message });
    }
});
